/**
 * Everything AgentView needs from the operating system, behind one interface.
 *
 * Server identity — the feature that stops AgentView inspecting the wrong
 * application — depends entirely on OS process inspection, and that is the
 * least portable part of the tool. Isolating it here means adding a platform
 * is implementing this interface, not hunting through the codebase.
 *
 * Every method is best-effort: an implementation that cannot answer returns
 * empty/null rather than throwing. Callers treat "cannot determine" as
 * unknown and degrade safely — they must never treat it as a match.
 */

export interface PortOwner {
  pid: number;
  command: string;
}

export interface ProcessDetail {
  /** Working directory of the process, or null when unreadable. */
  cwd: string | null;
  /** Full command line, or null when unreadable. */
  commandLine: string | null;
}

export interface ProcessInspector {
  /** Identifier used in diagnostics, e.g. "darwin (lsof)" or "linux (/proc)". */
  readonly name: string;

  /**
   * Whether process inspection is usable here at all. When false, AgentView
   * reports port ownership as unknown and says so, rather than guessing.
   */
  readonly supported: boolean;

  /** Every TCP port currently being listened on, with its owning process. */
  listListeningPorts(): { port: number; owner: PortOwner }[];

  /** Working directory and command line for many PIDs at once. */
  processDetails(pids: number[]): Map<number, ProcessDetail>;

  /** Parent of a process, for ancestry checks. Null when unreadable. */
  parentPid(pid: number): number | null;

  /**
   * Terminate a process tree that AgentView started. Implementations must
   * only ever be called with a PID AgentView spawned itself.
   */
  killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}
