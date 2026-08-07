import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probeUrl } from './probe.js';
import {
  checkPortOwnership,
  checkServerProject,
  findProjectServers,
  portOf,
  type PortOwner,
  type ProjectServer,
} from './ownership.js';
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
    };

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

  // 1. Reuse an already-running server — but only if it belongs to THIS
  //    project. Framework default ports collide across projects constantly,
  //    and reusing a neighbour's server would verify the wrong application.
  const skippedForeign: ForeignServer[] = [];
  for (const url of candidates) {
    const probe = await probeUrl(url, 1500);
    if (!probe.ok) continue;

    const port = portOf(url);
    const match = port === null ? null : checkServerProject(port, opts.projectRoot);
    if (match?.status === 'different-project' && !opts.allowForeignServer) {
      skippedForeign.push({
        url,
        cwd: match.cwd,
        owners: match.owners,
      });
      continue; // start our own server instead
    }
    return {
      ok: true,
      handle: {
        child: null,
        startedByUs: false,
        url,
        ownership: 'reused',
        skippedForeign,
        getLog: () => '',
        stop: async () => {},
      },
    };
  }

  // 2. Start it ourselves.
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

export function rankProjectServers(
  servers: ProjectServer[],
  adapter: FrameworkAdapter,
): ProjectServer[] {
  const matches = (s: ProjectServer) =>
    s.commandLine !== null && adapter.devProcessPatterns.some((p) => p.test(s.commandLine!));
  const preferred = servers.filter(matches);
  const rest = servers.filter((s) => !matches(s));
  return [...preferred, ...rest];
}

function candidateUrls(opts: StartOptions): string[] {
  const urls: string[] = [];
  // 1. Explicit user intent always wins.
  if (opts.explicitUrl) urls.push(normalizeLocalUrl(opts.explicitUrl));
  // 2. A server verifiably belonging to this project beats any guess about
  //    which port it "should" be on. Several may be running inside the same
  //    directory (a stray static server, an old preview build), so prefer
  //    the one whose process actually looks like this framework's dev server.
  for (const server of rankProjectServers(findProjectServers(opts.projectRoot), opts.adapter)) {
    urls.push(server.url);
  }
  // 3. Then the configured port, then the framework default.
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
