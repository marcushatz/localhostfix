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

/** Full command line of a process. Null when it cannot be read. */
export function processCommandLine(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
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

/**
 * Every TCP port currently being listened on, with its owning process.
 * Best-effort: returns [] where lsof is unavailable.
 */
export function allListeningPorts(): { port: number; owner: PortOwner }[] {
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const results: { port: number; owner: PortOwner }[] = [];
    let pid: number | null = null;
    let command = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
        command = '';
      } else if (line.startsWith('c')) {
        command = line.slice(1);
      } else if (line.startsWith('n') && pid !== null) {
        // Name looks like "*:3000", "127.0.0.1:3000", or "[::1]:3000".
        const match = line.match(/:(\d+)$/);
        if (match?.[1]) {
          results.push({ port: Number(match[1]), owner: { pid, command } });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Find dev servers already running FOR THIS PROJECT, on any port.
 *
 * Dev servers routinely land on a port nobody predicted — the default was
 * taken, or a framework picked the next free one. Probing only the expected
 * port then misses a perfectly healthy server, and probing common ports
 * blindly risks hitting a different project. Matching the listening
 * process's working directory to the project root finds the right server
 * wherever it ended up.
 */
export interface ProjectServer {
  url: string;
  owner: PortOwner;
  /** Full command line of the listening process, when readable. */
  commandLine: string | null;
}

export function findProjectServers(projectRoot: string): ProjectServer[] {
  const seen = new Set<number>();
  const found: ProjectServer[] = [];
  for (const { port, owner } of allListeningPorts()) {
    if (seen.has(port)) continue;
    seen.add(port);
    const cwd = processCwd(owner.pid);
    if (cwd && runsInsideProject(cwd, projectRoot)) {
      found.push({
        url: `http://localhost:${port}`,
        owner,
        commandLine: processCommandLine(owner.pid),
      });
    }
  }
  return found;
}

export interface ProcessDetail {
  cwd: string | null;
  commandLine: string | null;
}

/**
 * Working directory and command line for many PIDs in two subprocess calls
 * rather than two per PID. Discovery inspects every listening process, so the
 * per-PID version made `doctor` noticeably slow on a busy machine.
 */
export function processDetails(pids: number[]): Map<number, ProcessDetail> {
  const out = new Map<number, ProcessDetail>();
  if (pids.length === 0) return out;
  const list = pids.join(',');

  const cwds = new Map<number, string>();
  try {
    const raw = execFileSync('lsof', ['-a', '-p', list, '-d', 'cwd', '-Fpn'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pid: number | null = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== null) cwds.set(pid, line.slice(1));
    }
  } catch {
    /* unavailable: cwd stays null, callers treat that as "unknown" */
  }

  const commands = new Map<number, string>();
  try {
    const raw = execFileSync('ps', ['-o', 'pid=,command=', '-p', list], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of raw.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (match?.[1] && match[2]) commands.set(Number(match[1]), match[2].trim());
    }
  } catch {
    /* unavailable */
  }

  for (const pid of pids) {
    const cwd = cwds.get(pid) ?? null;
    const commandLine = commands.get(pid) ?? null;
    if (cwd !== null || commandLine !== null) out.set(pid, { cwd, commandLine });
  }
  return out;
}

/** Working directory of a process, via lsof. Null when it cannot be read. */
export function processCwd(pid: number): string | null {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

export type ProjectMatch =
  | { status: 'same-project'; owners: PortOwner[]; cwd: string | null }
  | { status: 'different-project'; owners: PortOwner[]; cwd: string }
  | { status: 'unknown'; owners: PortOwner[]; cwd: string | null };

/**
 * Decide whether an already-running server on `port` belongs to the project
 * being inspected.
 *
 * Reusing a running server is a feature — but reusing ANOTHER project's
 * server silently verifies the wrong application, which is the exact failure
 * this tool exists to prevent. Framework default ports (3000, 5173) collide
 * constantly across projects, so this check earns its keep.
 *
 * Monorepos are handled by accepting either direction of containment: a dev
 * server running in `apps/web` under a repo root still counts as the same
 * project.
 */
export function checkServerProject(port: number, projectRoot: string): ProjectMatch {
  const owners = listenersOnPort(port);
  if (owners.length === 0) return { status: 'unknown', owners, cwd: null };

  for (const owner of owners) {
    const cwd = processCwd(owner.pid);
    if (!cwd) continue;
    if (runsInsideProject(cwd, projectRoot)) return { status: 'same-project', owners, cwd };
    // A process whose cwd merely CONTAINS the project (often "/" for system
    // daemons) tells us nothing either way. Claiming "different project"
    // there would block legitimate setups, so stay honest and say unknown.
    if (containsProject(cwd, projectRoot)) return { status: 'unknown', owners, cwd };
    return { status: 'different-project', owners, cwd };
  }
  return { status: 'unknown', owners, cwd: null };
}

/**
 * How a process's working directory relates to the project being inspected.
 *
 * `contains` is deliberately distinct from `inside`: a daemon whose cwd is
 * "/" contains every project on the machine, and treating that as a match
 * once caused AgentView to inspect macOS AirPlay on port 7000 instead of the
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

function runsInsideProject(cwd: string, projectRoot: string): boolean {
  return classifyCwd(cwd, projectRoot) === 'inside';
}

function containsProject(cwd: string, projectRoot: string): boolean {
  return classifyCwd(cwd, projectRoot) === 'contains';
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
