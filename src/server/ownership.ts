import { processInspector, type PortOwner, type ProcessDetail } from '../platform/index.js';

export type { PortOwner, ProcessDetail } from '../platform/index.js';

/**
 * Establishing which process owns a port, and whether it belongs to the
 * project being inspected.
 *
 * This exists because a reachable URL proves nothing about identity: a dev
 * server can advertise a port it does not serve, a stale process can hold a
 * port, and framework default ports collide across projects. Verifying the
 * listening process closes that hole. All OS-specific work is delegated to
 * the platform layer.
 */

export function listenersOnPort(port: number): PortOwner[] {
  return processInspector()
    .listListeningPorts()
    .filter((entry) => entry.port === port)
    .map((entry) => entry.owner);
}

export function allListeningPorts(): { port: number; owner: PortOwner }[] {
  return processInspector().listListeningPorts();
}

export function processDetails(pids: number[]): Map<number, ProcessDetail> {
  return processInspector().processDetails(pids);
}

export function processCwd(pid: number): string | null {
  return processDetails([pid]).get(pid)?.cwd ?? null;
}

export function processCommandLine(pid: number): string | null {
  return processDetails([pid]).get(pid)?.commandLine ?? null;
}

export function parentPid(pid: number): number | null {
  return processInspector().parentPid(pid);
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

export type OwnershipCheck =
  | { status: 'ours'; owners: PortOwner[] }
  | { status: 'foreign'; owners: PortOwner[] }
  | { status: 'unknown'; owners: PortOwner[] };

/**
 * Whether the process serving `port` belongs to the tree LocalhostFix spawned.
 * "unknown" means we could not tell; callers must treat that as informational
 * and never as a match.
 */
export function checkPortOwnership(port: number, ourPid: number | undefined): OwnershipCheck {
  const owners = listenersOnPort(port);
  if (owners.length === 0 || ourPid === undefined) return { status: 'unknown', owners };
  const ours = owners.some((o) => o.pid === ourPid || isDescendantOf(o.pid, ourPid));
  return ours ? { status: 'ours', owners } : { status: 'foreign', owners };
}

export interface ProjectServer {
  url: string;
  owner: PortOwner;
  commandLine: string | null;
}

/** Dev servers already running for this project, on any port. */
export function findProjectServers(projectRoot: string): ProjectServer[] {
  const listening = allListeningPorts();
  const details = processDetails([...new Set(listening.map((l) => l.owner.pid))]);
  const seen = new Set<number>();
  const found: ProjectServer[] = [];
  for (const { port, owner } of listening) {
    if (seen.has(port)) continue;
    seen.add(port);
    const detail = details.get(owner.pid);
    if (detail?.cwd && classifyCwd(detail.cwd, projectRoot) === 'inside') {
      found.push({
        url: `http://localhost:${port}`,
        owner,
        commandLine: detail.commandLine,
      });
    }
  }
  return found;
}

export type ProjectMatch =
  | { status: 'same-project'; owners: PortOwner[]; cwd: string }
  | { status: 'different-project'; owners: PortOwner[]; cwd: string }
  | { status: 'unknown'; owners: PortOwner[]; cwd: string | null };

export function checkServerProject(port: number, projectRoot: string): ProjectMatch {
  const owners = listenersOnPort(port);
  if (owners.length === 0) return { status: 'unknown', owners, cwd: null };
  const details = processDetails(owners.map((o) => o.pid));
  for (const owner of owners) {
    const cwd = details.get(owner.pid)?.cwd;
    if (!cwd) continue;
    switch (classifyCwd(cwd, projectRoot)) {
      case 'inside':
        return { status: 'same-project', owners, cwd };
      case 'contains':
        // A process whose cwd merely CONTAINS the project (often "/" for
        // system daemons) tells us nothing either way.
        return { status: 'unknown', owners, cwd };
      case 'unrelated':
        return { status: 'different-project', owners, cwd };
    }
  }
  return { status: 'unknown', owners, cwd: null };
}

/**
 * How a process's working directory relates to the project being inspected.
 *
 * `contains` is deliberately distinct from `inside`: a daemon whose cwd is
 * "/" contains every project on the machine, and treating that as a match
 * once caused LocalhostFix to inspect macOS AirPlay on port 7000 instead of the
 * developer's app.
 */
export type CwdRelation = 'inside' | 'contains' | 'unrelated';

export function classifyCwd(cwd: string, projectRoot: string): CwdRelation {
  const a = normalizePath(cwd);
  const b = normalizePath(projectRoot);
  if (a === b || a.startsWith(b + '/')) return 'inside';
  if (a === '' || b.startsWith(a + '/')) return 'contains';
  return 'unrelated';
}

function normalizePath(p: string): string {
  let out = p.replace(/\/+$/, '');
  // macOS reports /private/var/... where callers often have /var/...
  if (out.startsWith('/private/')) out = out.slice('/private'.length);
  return out;
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
