import { execFileSync } from 'node:child_process';

/**
 * Who is actually listening on a port.
 *
 * This exists because a dev server can advertise a URL it does not serve
 * (wrong port in a log line, a stale process holding the port, a different
 * project already running). Probing such a URL succeeds and AgentView would
 * happily inspect the WRONG application. Verifying that the listening process
 * descends from the process AgentView started closes that hole.
 */
export interface PortOwner {
  pid: number;
  command: string;
}

/** Best-effort: returns [] on unsupported platforms or when lsof is unavailable. */
export function listenersOnPort(port: number): PortOwner[] {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // -F output: alternating "p<pid>" and "c<command>" lines.
    const owners: PortOwner[] = [];
    let pid: number | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('c') && pid !== null) {
        owners.push({ pid, command: line.slice(1) });
        pid = null;
      }
    }
    return owners;
  } catch {
    return [];
  }
}

/** Walk the parent chain of `pid` looking for `ancestorPid`. */
export function isDescendantOf(pid: number, ancestorPid: number, maxDepth = 12): boolean {
  let current = pid;
  for (let i = 0; i < maxDepth; i++) {
    if (current === ancestorPid) return true;
    const parent = parentPid(current);
    if (parent === null || parent <= 1 || parent === current) return false;
    current = parent;
  }
  return false;
}

export function parentPid(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Number(out.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type OwnershipCheck =
  | { status: 'ours'; owners: PortOwner[] }
  | { status: 'foreign'; owners: PortOwner[] }
  | { status: 'unknown'; owners: PortOwner[] };

/**
 * Determine whether the process serving `port` belongs to the server tree
 * AgentView spawned. "unknown" means we could not tell (no lsof, permissions,
 * container) — callers must treat that as informational, never as a failure.
 */
export function checkPortOwnership(port: number, ourPid: number | undefined): OwnershipCheck {
  const owners = listenersOnPort(port);
  if (owners.length === 0 || ourPid === undefined) return { status: 'unknown', owners };
  const ours = owners.some((o) => o.pid === ourPid || isDescendantOf(o.pid, ourPid));
  return ours ? { status: 'ours', owners } : { status: 'foreign', owners };
}

export function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}
