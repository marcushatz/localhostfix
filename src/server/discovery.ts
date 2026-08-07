import type { FrameworkAdapter } from '../frameworks/adapter.js';
import {
  allListeningPorts,
  classifyCwd,
  processDetails,
  portOf,
  type CwdRelation,
  type PortOwner,
} from './ownership.js';
import { isLocalUrl, probeUrl } from './probe.js';

/**
 * The single authoritative answer to "which local server belongs to this
 * project?", shared by `doctor` and `inspect` so the two can never disagree.
 *
 * The rule this module exists to enforce: a reachable localhost URL is NOT
 * evidence that it serves the project being worked on. Framework default
 * ports collide across projects constantly, so identity is established from
 * the listening process itself — its working directory first, its command
 * line second — never from the fact that something answered.
 */

export type CandidateSource =
  | 'configured-url'
  | 'configured-port'
  | 'framework-default'
  | 'project-scan';

export interface ServerCandidate {
  url: string;
  port: number;
  owner: PortOwner;
  /** Working directory of the listening process, when readable. */
  cwd: string | null;
  commandLine: string | null;
  source: CandidateSource;
  /** How the owning process's directory relates to the project. */
  relation: CwdRelation | 'unknown';
  /** Whether the command line looks like this framework's dev server. */
  matchesFramework: boolean;
}

export type SelectionReason =
  | 'explicit-url'
  | 'only-project-server'
  | 'matches-framework-dev-command'
  | 'configured-port-ownership-unverifiable'
  | 'none';

export interface DiscoveryResult {
  /** Servers whose owning process runs inside the project directory. */
  projectServers: ServerCandidate[];
  /** Reachable servers at configured/default locations owned by another project. */
  foreignServers: ServerCandidate[];
  /** The server to use, when identity is established without guessing. */
  selected: ServerCandidate | null;
  selectionReason: SelectionReason;
  /**
   * True when several project servers are plausible and none is clearly the
   * dev server. Callers must report the ambiguity instead of picking one.
   */
  ambiguous: boolean;
  /** Best guess when ambiguous — reported, never silently used. */
  preferred: ServerCandidate | null;
  configuredUrl: string | null;
  configuredPort: number | null;
  /** True when process inspection is unavailable (no lsof, restricted host). */
  ownershipUnavailable: boolean;
  /**
   * Set when a configured URL was NOT probed because it is not localhost and
   * remote inspection was not explicitly allowed. Enforced here so that no
   * caller can reach a remote host by accident.
   */
  remoteUrlBlocked: string | null;
}

export interface DiscoveryOptions {
  projectRoot: string;
  adapter: FrameworkAdapter;
  configuredUrl?: string | undefined;
  configuredPort?: number | undefined;
  /** Probe timeout per candidate. */
  probeTimeoutMs?: number;
  /** Permit probing a non-localhost configured URL. */
  allowRemote?: boolean | undefined;
}

export async function discoverServers(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const probeTimeout = opts.probeTimeoutMs ?? 1500;
  const listening = allListeningPorts();
  const details = processDetails([...new Set(listening.map((l) => l.owner.pid))]);
  const ownershipUnavailable = listening.length > 0 && details.size === 0;

  const configuredPort =
    opts.configuredPort ?? (opts.configuredUrl ? portOf(opts.configuredUrl) : null) ?? null;

  const build = (port: number, owner: PortOwner, source: CandidateSource): ServerCandidate => {
    const detail = details.get(owner.pid);
    const cwd = detail?.cwd ?? null;
    const commandLine = detail?.commandLine ?? null;
    return {
      url: `http://localhost:${port}`,
      port,
      owner,
      cwd,
      commandLine,
      source,
      relation: cwd ? classifyCwd(cwd, opts.projectRoot) : 'unknown',
      matchesFramework:
        commandLine !== null && opts.adapter.devProcessPatterns.some((p) => p.test(commandLine)),
    };
  };

  // Every listener that runs inside the project directory.
  const projectServers: ServerCandidate[] = [];
  const seenPorts = new Set<number>();
  for (const { port, owner } of listening) {
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);
    const candidate = build(port, owner, 'project-scan');
    if (candidate.relation === 'inside') projectServers.push(candidate);
  }
  projectServers.sort((a, b) => a.port - b.port);

  // Anything reachable at a configured/default location that is NOT ours.
  const foreignServers: ServerCandidate[] = [];
  const configuredLocations: { port: number; source: CandidateSource }[] = [];
  if (configuredPort !== null) {
    configuredLocations.push({
      port: configuredPort,
      source: opts.configuredUrl ? 'configured-url' : 'configured-port',
    });
  }
  if (opts.adapter.defaultPort !== null && opts.adapter.defaultPort !== configuredPort) {
    configuredLocations.push({ port: opts.adapter.defaultPort, source: 'framework-default' });
  }

  for (const { port, source } of configuredLocations) {
    if (projectServers.some((s) => s.port === port)) continue;
    const listener = listening.find((l) => l.port === port);
    if (!listener) continue;
    const candidate = build(port, listener.owner, source);
    // 'contains' (a process whose cwd is "/" or a parent) proves nothing
    // either way, so it is not reported as a foreign project.
    if (candidate.relation === 'unrelated') foreignServers.push(candidate);
  }

  const result: DiscoveryResult = {
    projectServers,
    foreignServers,
    selected: null,
    selectionReason: 'none',
    ambiguous: false,
    preferred: null,
    configuredUrl: opts.configuredUrl ?? null,
    configuredPort,
    ownershipUnavailable,
    remoteUrlBlocked: null,
  };

  // Privacy guard, enforced at the only place that makes requests: never
  // touch a non-localhost host unless explicitly permitted.
  const configuredUrlIsProbeable =
    opts.configuredUrl !== undefined &&
    (isLocalUrl(opts.configuredUrl) || opts.allowRemote === true);
  if (opts.configuredUrl !== undefined && !configuredUrlIsProbeable) {
    result.remoteUrlBlocked = opts.configuredUrl;
  }

  // 1. An explicit URL is a deliberate instruction and is honoured, provided
  //    something is actually there.
  if (opts.configuredUrl && configuredUrlIsProbeable) {
    const probe = await probeUrl(opts.configuredUrl, probeTimeout);
    if (probe.ok) {
      const port = portOf(opts.configuredUrl);
      const existing = port !== null ? projectServers.find((s) => s.port === port) : undefined;
      const listener = port !== null ? listening.find((l) => l.port === port) : undefined;
      result.selected = existing ?? (listener ? build(listener.port, listener.owner, 'configured-url') : null);
      if (result.selected) {
        result.selected = { ...result.selected, source: 'configured-url' };
        result.selectionReason = 'explicit-url';
        return result;
      }
    }
  }

  // 2. Servers verifiably inside the project beat any assumption about which
  //    port it "should" be on.
  const reachable: ServerCandidate[] = [];
  for (const candidate of projectServers) {
    const probe = await probeUrl(candidate.url, probeTimeout);
    if (probe.ok) reachable.push(candidate);
  }

  if (reachable.length === 1) {
    result.selected = reachable[0]!;
    result.selectionReason = 'only-project-server';
    return result;
  }

  if (reachable.length > 1) {
    const frameworkMatches = reachable.filter((s) => s.matchesFramework);
    if (frameworkMatches.length === 1) {
      result.selected = frameworkMatches[0]!;
      result.selectionReason = 'matches-framework-dev-command';
      return result;
    }
    // Zero matches, or several equally plausible ones: refuse to guess.
    result.ambiguous = true;
    result.preferred = frameworkMatches[0] ?? reachable[0]!;
    return result;
  }

  // 3. Nothing identifiable inside the project. A configured port may still
  //    be serving it on a host where ownership cannot be read; accept that
  //    only when the owner is genuinely unknown, never when it is foreign.
  if (configuredPort !== null && !foreignServers.some((f) => f.port === configuredPort)) {
    const url = configuredUrlIsProbeable && opts.configuredUrl
      ? opts.configuredUrl
      : `http://localhost:${configuredPort}`;
    const probe = isLocalUrl(url) || opts.allowRemote === true
      ? await probeUrl(url, probeTimeout)
      : { ok: false as const };
    if (probe.ok) {
      const listener = listening.find((l) => l.port === configuredPort);
      const candidate = listener
        ? build(configuredPort, listener.owner, 'configured-port')
        : {
            url,
            port: configuredPort,
            owner: { pid: -1, command: 'unknown' },
            cwd: null,
            commandLine: null,
            source: 'configured-port' as CandidateSource,
            relation: 'unknown' as const,
            matchesFramework: false,
          };
      if (candidate.relation !== 'unrelated') {
        result.selected = candidate;
        result.selectionReason = 'configured-port-ownership-unverifiable';
      }
    }
  }

  return result;
}

/** One-line explanation of why a candidate was chosen, for reports. */
export function describeSelection(result: DiscoveryResult): string {
  switch (result.selectionReason) {
    case 'explicit-url':
      return 'explicitly configured URL';
    case 'only-project-server':
      return 'the only server listening inside this project';
    case 'matches-framework-dev-command':
      return 'matches the configured framework dev command';
    case 'configured-port-ownership-unverifiable':
      return 'reachable at the configured port; process ownership could not be verified on this system';
    case 'none':
      return 'no server selected';
  }
}

export function describeCandidate(c: ServerCandidate): string {
  return `${c.port} — ${shortenCommand(c.commandLine ?? c.owner.command)}`;
}

/**
 * Command lines are dominated by long absolute interpreter paths
 * (`/opt/homebrew/Cellar/python@3.14/.../Python -m http.server`), which
 * truncate to something useless. Keep the program's basename and its
 * arguments, which is the part that identifies the server.
 */
export function shortenCommand(commandLine: string, maxLength = 60): string {
  const [program = '', ...args] = commandLine.trim().split(/\s+/);
  const basename = program.split('/').pop() || program;
  const shortened = [basename, ...args].join(' ');
  return shortened.length > maxLength ? shortened.slice(0, maxLength - 1) + '…' : shortened;
}
