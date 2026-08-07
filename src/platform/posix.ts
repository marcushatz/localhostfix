import { execFileSync } from 'node:child_process';
import type { PortOwner, ProcessDetail, ProcessInspector } from './types.js';

/**
 * Process inspection via `lsof` and `ps`, available on macOS and most Linux
 * installations. Linux additionally prefers /proc where present (see
 * linux.ts), because it needs no external binary.
 */

export function runCommand(command: string, args: string[], timeoutMs = 5000): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function commandExists(command: string): boolean {
  return runCommand('command', ['-v', command], 2000) !== null || runCommand('which', [command], 2000) !== null;
}

/** Parse `lsof -F` output, which alternates p<pid>, c<command>, n<name> records. */
export function parseLsofFields(raw: string): { pid: number; command: string; name: string }[] {
  const out: { pid: number; command: string; name: string }[] = [];
  let pid: number | null = null;
  let command = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      command = '';
    } else if (line.startsWith('c')) {
      command = line.slice(1);
    } else if (line.startsWith('n') && pid !== null) {
      out.push({ pid, command, name: line.slice(1) });
    }
  }
  return out;
}

/** "*:3000", "127.0.0.1:3000", "[::1]:3000" → 3000 */
export function portFromSocketName(name: string): number | null {
  const match = name.match(/:(\d+)$/);
  return match?.[1] ? Number(match[1]) : null;
}

export const posixInspector: ProcessInspector = {
  name: 'posix (lsof + ps)',

  get supported(): boolean {
    return runCommand('lsof', ['-v'], 2000) !== null || commandExists('lsof');
  },

  listListeningPorts(): { port: number; owner: PortOwner }[] {
    const raw = runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
    if (raw === null) return [];
    const results: { port: number; owner: PortOwner }[] = [];
    for (const record of parseLsofFields(raw)) {
      const port = portFromSocketName(record.name);
      if (port !== null) results.push({ port, owner: { pid: record.pid, command: record.command } });
    }
    return results;
  },

  processDetails(pids: number[]): Map<number, ProcessDetail> {
    const out = new Map<number, ProcessDetail>();
    if (pids.length === 0) return out;
    const list = pids.join(',');

    const cwds = new Map<number, string>();
    const rawCwd = runCommand('lsof', ['-a', '-p', list, '-d', 'cwd', '-Fpn']);
    if (rawCwd !== null) {
      for (const record of parseLsofFields(rawCwd)) cwds.set(record.pid, record.name);
    }

    const commands = new Map<number, string>();
    const rawPs = runCommand('ps', ['-o', 'pid=,command=', '-p', list]);
    if (rawPs !== null) {
      for (const line of rawPs.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match?.[1] && match[2]) commands.set(Number(match[1]), match[2].trim());
      }
    }

    for (const pid of pids) {
      const cwd = cwds.get(pid) ?? null;
      const commandLine = commands.get(pid) ?? null;
      if (cwd !== null || commandLine !== null) out.set(pid, { cwd, commandLine });
    }
    return out;
  },

  parentPid(pid: number): number | null {
    const raw = runCommand('ps', ['-o', 'ppid=', '-p', String(pid)], 2000);
    if (raw === null) return null;
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  },

  killTree(pid: number, signal): void {
    // Negative PID signals the whole process group. LocalhostFix spawns dev
    // servers detached precisely so their children die with them.
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
  },
};
