import fs from 'node:fs';
import type { PortOwner, ProcessDetail, ProcessInspector } from './types.js';
import { posixInspector } from './posix.js';

/**
 * Linux process inspection through /proc, which needs no external binary and
 * is therefore more dependable than shelling out to lsof (frequently absent
 * in containers and minimal images). Falls back to the lsof implementation
 * for anything /proc cannot answer.
 *
 * NOTE: this implementation is written from the documented /proc interface
 * and is exercised by unit tests against captured fixture data. It has NOT
 * been verified on a live Linux host — see docs/PLATFORM_SUPPORT.md, where
 * Linux is listed as "Expected", never "Verified".
 */

/** Parse one /proc/net/tcp table into local port → socket inode. */
export function parseProcNetTcp(content: string): { port: number; inode: number }[] {
  const out: { port: number; inode: number }[] = [];
  const lines = content.trim().split('\n').slice(1); // drop the header
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    // local_address is field 1 ("0100007F:1F90"), state field 3, inode field 9.
    const localAddress = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (!localAddress || !state || !inode) continue;
    if (state !== '0A') continue; // 0A = TCP_LISTEN
    const hexPort = localAddress.split(':')[1];
    if (!hexPort) continue;
    out.push({ port: parseInt(hexPort, 16), inode: Number(inode) });
  }
  return out;
}

/** Map socket inodes to the PIDs holding them, by scanning /proc/<pid>/fd. */
function inodeToPid(inodes: Set<number>): Map<number, number> {
  const map = new Map<number, number>();
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return map;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // another user's process, or it exited
    }
    for (const fd of fds) {
      try {
        const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = link.match(/^socket:\[(\d+)\]$/);
        const inode = match?.[1] ? Number(match[1]) : null;
        if (inode !== null && inodes.has(inode) && !map.has(inode)) {
          map.set(inode, Number(pid));
        }
      } catch {
        /* fd vanished mid-scan */
      }
    }
  }
  return map;
}

function readCommandLine(pid: number): string | null {
  try {
    // /proc/<pid>/cmdline is NUL-separated.
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const joined = raw.split('\0').filter(Boolean).join(' ').trim();
    if (joined.length > 0) return joined;
  } catch {
    /* fall through */
  }
  try {
    // Kernel threads and some processes have an empty cmdline; comm is a name.
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function readCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** Field 4 of /proc/<pid>/stat is ppid; the comm field may contain spaces. */
export function parsePpidFromStat(stat: string): number | null {
  const closing = stat.lastIndexOf(')');
  if (closing === -1) return null;
  const after = stat.slice(closing + 2).split(/\s+/);
  const ppid = after[1];
  return ppid && Number.isFinite(Number(ppid)) ? Number(ppid) : null;
}

export function procAvailable(): boolean {
  try {
    return fs.existsSync('/proc/self/stat');
  } catch {
    return false;
  }
}

export const linuxInspector: ProcessInspector = {
  name: 'linux (/proc)',

  get supported(): boolean {
    return procAvailable() || posixInspector.supported;
  },

  listListeningPorts(): { port: number; owner: PortOwner }[] {
    if (!procAvailable()) return posixInspector.listListeningPorts();

    const entries: { port: number; inode: number }[] = [];
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        entries.push(...parseProcNetTcp(fs.readFileSync(table, 'utf8')));
      } catch {
        /* table absent (IPv6 disabled, for example) */
      }
    }
    if (entries.length === 0) return posixInspector.listListeningPorts();

    const owners = inodeToPid(new Set(entries.map((e) => e.inode)));
    const results: { port: number; owner: PortOwner }[] = [];
    for (const entry of entries) {
      const pid = owners.get(entry.inode);
      if (pid === undefined) continue; // owned by another user
      results.push({
        port: entry.port,
        owner: { pid, command: readCommandLine(pid)?.split(/\s+/)[0]?.split('/').pop() ?? 'unknown' },
      });
    }
    // If /proc told us nothing useful, lsof may still know.
    return results.length > 0 ? results : posixInspector.listListeningPorts();
  },

  processDetails(pids: number[]): Map<number, ProcessDetail> {
    if (!procAvailable()) return posixInspector.processDetails(pids);
    const out = new Map<number, ProcessDetail>();
    for (const pid of pids) {
      const cwd = readCwd(pid);
      const commandLine = readCommandLine(pid);
      if (cwd !== null || commandLine !== null) out.set(pid, { cwd, commandLine });
    }
    return out.size > 0 ? out : posixInspector.processDetails(pids);
  },

  parentPid(pid: number): number | null {
    if (!procAvailable()) return posixInspector.parentPid(pid);
    try {
      return parsePpidFromStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return posixInspector.parentPid(pid);
    }
  },

  killTree(pid, signal): void {
    posixInspector.killTree(pid, signal);
  },
};
