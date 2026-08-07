import type { ProcessInspector } from './types.js';
import { posixInspector } from './posix.js';
import { linuxInspector } from './linux.js';

export type { PortOwner, ProcessDetail, ProcessInspector } from './types.js';

/**
 * Platform with no process-inspection support. Everything returns empty, so
 * LocalhostFix reports ownership as unknown and says so in `doctor` — it never
 * silently guesses that a server belongs to the project.
 */
export const unsupportedInspector: ProcessInspector = {
  name: `${process.platform} (process inspection unsupported)`,
  supported: false,
  listListeningPorts: () => [],
  processDetails: () => new Map(),
  parentPid: () => null,
  killTree: (pid, signal) => {
    // No process groups: signal just the process itself, best effort.
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  },
};

function select(): ProcessInspector {
  switch (process.platform) {
    case 'darwin':
      return posixInspector;
    case 'linux':
      return linuxInspector;
    // Windows needs a different mechanism entirely (netstat/WMI/CIM); until
    // that exists and is verified, ownership is honestly reported as unknown
    // rather than approximated. See docs/PLATFORM_SUPPORT.md.
    default:
      return unsupportedInspector;
  }
}

let active: ProcessInspector = select();

export function processInspector(): ProcessInspector {
  return active;
}

/** Test seam: swap the inspector to simulate another platform. */
export function setProcessInspector(inspector: ProcessInspector): () => void {
  const previous = active;
  active = inspector;
  return () => {
    active = previous;
  };
}
