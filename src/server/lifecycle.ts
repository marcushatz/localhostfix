import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probeUrl } from './probe.js';
import { checkPortOwnership, portOf, type PortOwner } from './ownership.js';
import { describeSelection, discoverServers, type DiscoveryResult } from './discovery.js';
import type { FrameworkAdapter } from '../frameworks/adapter.js';

export interface ServerHandle {
  /** Null when AgentView reused an already-running server. */
  child: ChildProcess | null;
  startedByUs: boolean;
  url: string;
  /**
   * Whether the process serving `url` belongs to the tree AgentView started.
   * 'reused' means we intentionally connected to a pre-existing server.
   * 'unknown' means ownership could not be determined (no lsof/permissions).
   */
  ownership: 'ours' | 'reused' | 'unknown';
  /** Reachable servers that were deliberately NOT used, and why. */
  skippedForeign: ForeignServer[];
  /** Human-readable reason this server was chosen. */
  selectionReason: string;
  /** Combined stdout+stderr captured so far (started servers only). */
  getLog(): string;
  /** Stop the server iff AgentView started it. Safe to call twice. */
  stop(): Promise<void>;
}

export interface ForeignServer {
  url: string;
  /** Working directory of the process that owns the port. */
  cwd: string;
  owners: PortOwner[];
}

export interface StartOptions {
  command: string;
  cwd: string;
  /** Project root, used to tell our own dev server from a neighbour's. */
  projectRoot: string;
  /** Accept a reachable server that belongs to a different project. */
  allowForeignServer?: boolean | undefined;
  /** Permit probing a non-localhost configured URL. */
  allowRemote?: boolean | undefined;
  adapter: FrameworkAdapter;
  expectedPort?: number | undefined;
  explicitUrl?: string | undefined;
  startupTimeoutMs: number;
  /** Called with incremental log chunks (for live doctor output). */
  onLog?: (chunk: string) => void;
}

export type StartFailure =
  | { kind: 'SERVER_START_FAILED'; log: string; exitCode: number | null; error?: string }
  | { kind: 'SERVER_START_TIMEOUT'; log: string; probedUrls: string[] }
  | {
      kind: 'SERVER_PORT_CONFLICT';
      log: string;
      url: string;
      owners: { pid: number; command: string }[];
    }
  | { kind: 'MULTIPLE_PROJECT_SERVERS'; discovery: DiscoveryResult }
  | { kind: 'DEV_COMMAND_NOT_FOUND' };

export type StartResult = { ok: true; handle: ServerHandle } | ({ ok: false } & StartFailure);

const URL_FALLBACK_PATTERN =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"']*)?)/i;

export function extractUrlFromLog(log: string, adapter: FrameworkAdapter): string | null {
  const clean = stripAnsi(log);
  for (const pattern of [...adapter.urlPatterns, URL_FALLBACK_PATTERN]) {
    const m = clean.match(pattern);
    if (m?.[1]?.startsWith('http')) return normalizeLocalUrl(m[1]);
  }
  return null;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

export function normalizeLocalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim().replace(/\/$/, ''));
    if (u.hostname === '0.0.0.0' || u.hostname === '::' ) u.hostname = 'localhost';
    return u.origin;
  } catch {
    return raw;
  }
}

/**
 * Reuse a healthy server when one is reachable; otherwise spawn the dev
 * command in its own process group, capture logs, discover the real URL,
 * and wait for readiness.
 */
export async function ensureServer(opts: StartOptions): Promise<StartResult> {
  const candidates = candidateUrls(opts);

  // 1. Reuse an already-running server — but only one that verifiably
  //    belongs to THIS project. Shared with `doctor` so both commands can
  //    never disagree about which server is the project's.
  const discovery = await discoverServers({
    projectRoot: opts.projectRoot,
    adapter: opts.adapter,
    configuredUrl: opts.explicitUrl,
    configuredPort: opts.expectedPort,
    allowRemote: opts.allowRemote,
  });

  const skippedForeign: ForeignServer[] = discovery.foreignServers.map((f) => ({
    url: f.url,
    cwd: f.cwd ?? '(unreadable)',
    owners: [f.owner],
  }));

  if (discovery.ambiguous && !opts.allowForeignServer) {
    return { ok: false, kind: 'MULTIPLE_PROJECT_SERVERS', discovery };
  }

  const reuse = discovery.selected;
  if (reuse) {
    return {
      ok: true,
      handle: {
        child: null,
        startedByUs: false,
        url: reuse.url,
        ownership: 'reused',
        skippedForeign,
        selectionReason: describeSelection(discovery),
        getLog: () => '',
        stop: async () => {},
      },
    };
  }

  // 2. Nothing of ours is running, so we must start it. Only now does a
  //    missing dev command actually matter — an already-running project
  //    server makes it irrelevant.
  if (opts.command.trim().length === 0) {
    return { ok: false, kind: 'DEV_COMMAND_NOT_FOUND' };
  }

  let log = '';
  const append = (chunk: Buffer | string) => {
    const text = chunk.toString();
    log += text;
    opts.onLog?.(text);
  };

  let child: ChildProcess;
  try {
    child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      detached: true, // own process group → we can kill the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '' },
    });
  } catch (err) {
    return {
      ok: false,
      kind: 'SERVER_START_FAILED',
      log: '',
      exitCode: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  let exited = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  child.on('error', (err) => {
    exited = true;
    append(`\n[agentview] spawn error: ${err.message}\n`);
  });

  const stop = async () => {
    if (child.pid && !exited) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // negative pid → whole group
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) await sleep(100);
      if (!exited && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  };

  // 3. Wait for readiness: URL parsed from logs first, then candidates.
  //
  //    A reachable URL is not automatically OUR server. A dev server can
  //    advertise a port it does not serve, or an unrelated project may
  //    already hold that port — inspecting it would silently verify the
  //    wrong application. So when we started the server, only accept a URL
  //    served by our own process tree.
  const deadline = Date.now() + opts.startupTimeoutMs;
  const probed = new Set<string>();
  let foreign: { url: string; owners: PortOwner[] } | null = null;

  while (Date.now() < deadline) {
    if (exited) {
      return { ok: false, kind: 'SERVER_START_FAILED', log, exitCode };
    }
    const urls = [extractUrlFromLog(log, opts.adapter), ...candidates].filter(
      (u): u is string => Boolean(u),
    );
    for (const url of urls) {
      probed.add(url);
      const probe = await probeUrl(url, 1500);
      if (!probe.ok) continue;

      const port = portOf(url);
      const ownership = port === null ? { status: 'unknown' as const, owners: [] } : checkPortOwnership(port, child.pid);
      if (ownership.status === 'foreign') {
        foreign = { url, owners: ownership.owners };
        continue; // keep waiting for our own server to come up
      }
      return {
        ok: true,
        handle: {
          child,
          startedByUs: true,
          url,
          ownership: ownership.status === 'ours' ? 'ours' : 'unknown',
          skippedForeign,
          selectionReason:
            ownership.status === 'ours'
              ? 'started by AgentView; verified by process ancestry'
              : 'started by AgentView; ownership not verifiable on this system',
          getLog: () => log,
          stop,
        },
      };
    }
    await sleep(500);
  }

  await stop();
  if (foreign) {
    return { ok: false, kind: 'SERVER_PORT_CONFLICT', log, url: foreign.url, owners: foreign.owners };
  }
  return { ok: false, kind: 'SERVER_START_TIMEOUT', log, probedUrls: [...probed] };
}

export function rankProjectServers<T extends { commandLine: string | null }>(
  servers: T[],
  adapter: FrameworkAdapter,
): T[] {
  const matches = (s: T) =>
    s.commandLine !== null && adapter.devProcessPatterns.some((p) => p.test(s.commandLine!));
  const preferred = servers.filter(matches);
  const rest = servers.filter((s) => !matches(s));
  return [...preferred, ...rest];
}

/**
 * Ports probed AFTER AgentView spawns the dev server. Discovery handles the
 * reuse case; here we only need places our own new server might appear
 * before it prints its URL.
 */
function candidateUrls(opts: StartOptions): string[] {
  const urls: string[] = [];
  if (opts.explicitUrl) urls.push(normalizeLocalUrl(opts.explicitUrl));
  if (opts.expectedPort) urls.push(`http://localhost:${opts.expectedPort}`);
  if (opts.adapter.defaultPort && opts.adapter.defaultPort !== opts.expectedPort) {
    urls.push(`http://localhost:${opts.adapter.defaultPort}`);
  }
  return [...new Set(urls)];
}

export function writeServerLog(runDir: string, handle: ServerHandle): string | null {
  const log = handle.getLog();
  const file = path.join(runDir, 'server.log');
  if (!handle.startedByUs && log.length === 0) {
    fs.writeFileSync(file, '[agentview] reused an already-running dev server; its logs are not captured.\n');
    return file;
  }
  fs.writeFileSync(file, log);
  return file;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
