import fs from 'node:fs';
import path from 'node:path';
import { localhostfixDir, configPath, loadConfig, saveConfig } from '../config/config.js';
import { LocalhostFixConfigSchema } from '../config/schema.js';
import { detectFramework, detectDevScript, adapterById } from '../frameworks/adapter.js';
import { findProjectRoot, detectPackageManager, runScriptCommand } from '../project/discover.js';
import { checkBrowserInstalled, INSTALL_COMMAND } from '../browser/driver.js';
import { runInspection } from '../inspect/run.js';
import type { InspectionReport } from '../artifacts/report.js';
import { verdictDomain, type Verdict } from '../diagnose/verdict.js';

/**
 * `localhostfix fix` — attempt safe recovery, then VERIFY.
 *
 * This is orchestration only. Diagnosis comes from exactly the same code path
 * `inspect` and `doctor` use; nothing here re-implements discovery or
 * classification. The command's whole job is: diagnose → apply only fixes
 * LocalhostFix can make confidently → re-inspect → report honestly whether
 * rendered frontend access was actually restored.
 *
 * Two rules constrain everything below:
 *
 *  1. LocalhostFix repairs its OWN state and configuration. It never edits
 *     application source, never signals a process it did not start, and never
 *     weakens a security or privacy control to make a run succeed.
 *  2. `FIXED` is only ever reported when a fresh verification inspection
 *     returns HEALTHY_RENDER. A browser launching is not success.
 */

export type FixOutcome =
  /** Nothing was wrong; inspection already works. */
  | 'ALREADY_HEALTHY'
  /** A safe fix was applied and verification now renders the app. */
  | 'FIXED'
  /** Infrastructure is healthy; the application itself is broken. */
  | 'APPLICATION_FIX_REQUIRED'
  /** LocalhostFix cannot safely repair this, or a fix did not restore access. */
  | 'COULD_NOT_REPAIR';

export interface AppliedFix {
  id: string;
  /** What was wrong. */
  problem: string;
  /** What LocalhostFix changed. */
  change: string;
  succeeded: boolean;
  /** How to undo it. */
  undo: string;
}

export interface ApprovalRequired {
  action: string;
  command: string;
}

export interface FixResult {
  outcome: FixOutcome;
  /** Verdict of the first diagnosis, before any fix. */
  initialVerdict: Verdict;
  fixesApplied: AppliedFix[];
  /** Report of the final verification run — the basis for the outcome. */
  finalReport: InspectionReport;
  /** Set when the run was verified after a fix rather than diagnosed once. */
  verified: boolean;
  /** Why LocalhostFix stopped, when it could not repair. */
  blockedBy: string | null;
  /** A fix that is safe but needs the user to say yes. */
  requiresApproval: ApprovalRequired | null;
  runDir: string;
  exitCode: number;
}

export interface FixOptions {
  cwd: string;
  route?: string | undefined;
  urlOverride?: string | undefined;
  /** Approve actions that install software (currently the Chromium build). */
  approveInstall?: boolean | undefined;
  allowRemote?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

const STALE_LOCK_MS = 10 * 60 * 1000;

export async function runFix(opts: FixOptions): Promise<FixResult> {
  const progress = opts.onProgress ?? (() => {});
  const project = findProjectRoot(opts.cwd);
  const fixesApplied: AppliedFix[] = [];

  // Repairs to LocalhostFix's own files happen before diagnosis, because a
  // corrupt config is what prevents diagnosis from being meaningful.
  fixesApplied.push(...repairOwnState(project.root));

  progress('Diagnosing…');
  const first = await runInspection({
    cwd: opts.cwd,
    route: opts.route,
    urlOverride: opts.urlOverride,
    allowRemote: opts.allowRemote,
    onProgress: opts.onProgress,
  });
  const initialVerdict = first.report.verdict;

  // Already working. Still worth correcting stored configuration drift so the
  // next run does not depend on rediscovery.
  if (initialVerdict === 'HEALTHY_RENDER') {
    fixesApplied.push(...correctStoredPort(project.root, first.report));
    return finalize({
      outcome: 'ALREADY_HEALTHY',
      initialVerdict,
      fixesApplied,
      finalReport: first.report,
      verified: false,
      blockedBy: null,
      requiresApproval: null,
      runDir: first.runDir,
    });
  }

  // The application is broken. LocalhostFix's job here is evidence, not repair.
  if (verdictDomain(initialVerdict) === 'application') {
    return finalize({
      outcome: 'APPLICATION_FIX_REQUIRED',
      initialVerdict,
      fixesApplied,
      finalReport: first.report,
      verified: false,
      blockedBy: null,
      requiresApproval: null,
      runDir: first.runDir,
    });
  }

  // Infrastructure problem: decide whether it is one LocalhostFix may repair.
  const plan = planFix(project.root, first.report, initialVerdict, opts);

  if (plan.kind === 'requires-approval') {
    return finalize({
      outcome: 'COULD_NOT_REPAIR',
      initialVerdict,
      fixesApplied,
      finalReport: first.report,
      verified: false,
      blockedBy: plan.reason,
      requiresApproval: plan.approval,
      runDir: first.runDir,
    });
  }

  if (plan.kind === 'unrepairable') {
    return finalize({
      outcome: 'COULD_NOT_REPAIR',
      initialVerdict,
      fixesApplied,
      finalReport: first.report,
      verified: false,
      blockedBy: plan.reason,
      requiresApproval: null,
      runDir: first.runDir,
    });
  }

  // Apply, then verify. Never report success without a fresh inspection.
  for (const fix of plan.fixes) fixesApplied.push(fix);
  progress('Verifying the fix…');
  const second = await runInspection({
    cwd: opts.cwd,
    route: opts.route,
    urlOverride: opts.urlOverride,
    allowRemote: opts.allowRemote,
    onProgress: opts.onProgress,
  });

  if (second.report.verdict === 'HEALTHY_RENDER') {
    fixesApplied.push(...correctStoredPort(project.root, second.report));
    return finalize({
      outcome: 'FIXED',
      initialVerdict,
      fixesApplied,
      finalReport: second.report,
      verified: true,
      blockedBy: null,
      requiresApproval: null,
      runDir: second.runDir,
    });
  }

  if (verdictDomain(second.report.verdict) === 'application') {
    return finalize({
      outcome: 'APPLICATION_FIX_REQUIRED',
      initialVerdict,
      fixesApplied,
      finalReport: second.report,
      verified: true,
      blockedBy: null,
      requiresApproval: null,
      runDir: second.runDir,
    });
  }

  return finalize({
    outcome: 'COULD_NOT_REPAIR',
    initialVerdict,
    fixesApplied,
    finalReport: second.report,
    verified: true,
    blockedBy: `the problem persisted after the fix (${second.report.verdict})`,
    requiresApproval: null,
    runDir: second.runDir,
  });
}

type FixPlan =
  | { kind: 'apply'; fixes: AppliedFix[] }
  | { kind: 'requires-approval'; reason: string; approval: ApprovalRequired }
  | { kind: 'unrepairable'; reason: string };

/**
 * Map a diagnosis to a safe repair. Anything not listed here is deliberately
 * left alone — the default is to diagnose, not to act.
 */
function planFix(
  projectRoot: string,
  report: InspectionReport,
  verdict: Verdict,
  opts: FixOptions,
): FixPlan {
  switch (verdict) {
    case 'BROWSER_NOT_INSTALLED': {
      // Installing software is safe but not silent: it downloads ~150 MB and
      // is the user's decision, not LocalhostFix's.
      if (!opts.approveInstall) {
        return {
          kind: 'requires-approval',
          reason: 'Chromium is missing. Safe automatic installation requires user approval.',
          approval: { action: 'Install the supported Chromium build', command: INSTALL_COMMAND },
        };
      }
      const fix = installChromium();
      return fix.succeeded
        ? { kind: 'apply', fixes: [fix] }
        : { kind: 'unrepairable', reason: `Chromium installation failed. Run \`${INSTALL_COMMAND}\` manually.` };
    }

    case 'SERVER_START_TIMEOUT': {
      // A slow dev server is a configuration problem LocalhostFix owns.
      const { config } = loadConfig(projectRoot);
      const current = config.startupTimeoutMs;
      // Give the retry a genuinely generous budget rather than a marginal
      // increment: doubling a short timeout lands right back on the boundary
      // that just failed.
      const raised = Math.min(Math.max(current * 2, 30_000), 180_000);
      if (raised <= current) {
        return {
          kind: 'unrepairable',
          reason: `the dev server did not become ready within ${current}ms, already the maximum LocalhostFix will wait`,
        };
      }
      saveConfig(projectRoot, { ...config, startupTimeoutMs: raised });
      return {
        kind: 'apply',
        fixes: [
          {
            id: 'startup-timeout',
            problem: `the dev server did not become ready within ${current}ms`,
            change: `raised startupTimeoutMs to ${raised} in .localhostfix/config.json`,
            succeeded: true,
            undo: `set "startupTimeoutMs": ${current} in .localhostfix/config.json`,
          },
        ],
      };
    }

    case 'MULTIPLE_PROJECT_SERVERS':
      return {
        kind: 'unrepairable',
        reason:
          'several servers are running in this project and LocalhostFix will not guess which is your app. Re-run with --url http://localhost:<port>, or stop the ones you are not using.',
      };

    case 'SERVER_PORT_CONFLICT':
      return {
        kind: 'unrepairable',
        reason:
          'the port is held by a process LocalhostFix did not start. LocalhostFix will not terminate it. Stop it yourself, or set "url"/"expectedPort" in .localhostfix/config.json.',
      };

    case 'DEV_COMMAND_NOT_FOUND':
      return {
        kind: 'unrepairable',
        reason:
          'no server is running and there is no dev command to start one. Add a "dev" script to package.json, or set "devCommand" in .localhostfix/config.json.',
      };

    case 'SERVER_START_FAILED':
      return {
        kind: 'unrepairable',
        reason:
          'the dev server exited before becoming reachable. This is a problem in the project, not in LocalhostFix — read server.log in the run directory.',
      };

    case 'PROJECT_NOT_RECOGNIZED': {
      // A remote URL was blocked, or there is genuinely no project here.
      // Neither is something to "fix": clearing the guard would defeat it.
      const blocked = report.evidence.some((e) => e.kind === 'remote-url-blocked');
      return {
        kind: 'unrepairable',
        reason: blocked
          ? 'the configured URL is not localhost. LocalhostFix will not contact it, and will not disable that protection for you. Pass --allow-remote deliberately if you understand the privacy implications.'
          : 'no Node.js project was found here. Run `localhostfix setup` in your project directory.',
      };
    }

    case 'BROWSER_LAUNCH_FAILED':
      return {
        kind: 'unrepairable',
        reason: `Chromium is installed but failed to launch: ${report.browser.detail ?? 'unknown error'}. Try \`${INSTALL_COMMAND}\` to repair the installation.`,
      };

    default:
      return {
        kind: 'unrepairable',
        reason: `LocalhostFix has no safe automatic repair for ${verdict}.`,
      };
  }
}

/**
 * Repair LocalhostFix's own files. These run before diagnosis because broken
 * LocalhostFix state makes every later answer untrustworthy.
 */
function repairOwnState(projectRoot: string): AppliedFix[] {
  const fixes: AppliedFix[] = [];

  // A stale lock left by a crashed run would suppress the Claude Stop hook.
  const lock = path.join(localhostfixDir(projectRoot), 'state', 'inspect.lock');
  if (fs.existsSync(lock)) {
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > STALE_LOCK_MS) {
        fs.rmSync(lock, { force: true });
        fixes.push({
          id: 'stale-lock',
          problem: `a stale inspection lock from a crashed run (${Math.round(age / 60000)} minutes old) was blocking automatic verification`,
          change: 'removed .localhostfix/state/inspect.lock',
          succeeded: true,
          undo: 'none needed; the lock is recreated per run',
        });
      }
    } catch {
      /* unreadable lock: leave it alone */
    }
  }

  // An unparseable config makes LocalhostFix fall back to defaults silently.
  const { error } = loadConfig(projectRoot);
  if (error) {
    const file = configPath(projectRoot);
    const backup = `${file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      const project = findProjectRoot(projectRoot);
      const adapter = detectFramework(project.packageJson, project.root);
      const pm = detectPackageManager(project.root, project.packageJson);
      const script = detectDevScript(project.packageJson, adapter);
      saveConfig(
        projectRoot,
        LocalhostFixConfigSchema.parse({
          framework: adapter.id,
          packageManager: pm,
          ...(script ? { devCommand: runScriptCommand(pm, script.script) } : {}),
          ...(adapter.defaultPort ? { expectedPort: adapter.defaultPort } : {}),
        }),
      );
      fixes.push({
        id: 'invalid-config',
        problem: `.localhostfix/config.json was not valid (${error.split('\n')[0]})`,
        change: `moved it to ${path.basename(backup)} and regenerated it from project detection`,
        succeeded: true,
        undo: `restore ${path.basename(backup)} over .localhostfix/config.json`,
      });
    } catch (err) {
      fixes.push({
        id: 'invalid-config',
        problem: '.localhostfix/config.json was not valid',
        change: `could not regenerate it: ${err instanceof Error ? err.message : String(err)}`,
        succeeded: false,
        undo: 'none; nothing changed',
      });
    }
  }

  return fixes;
}

/** Store the port the project's server is actually on. */
function correctStoredPort(projectRoot: string, report: InspectionReport): AppliedFix[] {
  if (!report.server.portMismatch || !report.server.actualUrl) return [];
  const { config, source } = loadConfig(projectRoot);
  if (!source) return []; // no config file to correct; discovery handles it
  const actualPort = Number(new URL(report.server.actualUrl).port || 80);
  if (!Number.isFinite(actualPort) || actualPort === config.expectedPort) return [];
  const previous = config.expectedPort;
  saveConfig(projectRoot, { ...config, expectedPort: actualPort });
  return [
    {
      id: 'stored-port',
      problem: `configuration expected port ${previous}, but this project's server is on ${actualPort}`,
      change: `stored expectedPort ${actualPort} in .localhostfix/config.json`,
      succeeded: true,
      undo: `set "expectedPort": ${previous ?? 'null'} in .localhostfix/config.json`,
    },
  ];
}

function installChromium(): AppliedFix {
  const base = {
    id: 'browser-install',
    problem: 'the supported Chromium build was not installed',
    undo: 'remove the build from the Playwright browser cache',
  };
  try {
    // Deliberately a subprocess: Playwright exposes no programmatic install.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('npx', ['playwright', 'install', 'chromium'], {
      stdio: 'ignore',
      timeout: 10 * 60 * 1000,
    });
    const availability = checkBrowserInstalled();
    return {
      ...base,
      change: availability.installed
        ? `installed Chromium via \`${INSTALL_COMMAND}\` (approved)`
        : 'ran the installer, but Chromium is still not present',
      succeeded: availability.installed,
    };
  } catch (err) {
    return {
      ...base,
      change: `installation failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      succeeded: false,
    };
  }
}

function finalize(partial: Omit<FixResult, 'exitCode'>): FixResult {
  const exitCode = (() => {
    switch (partial.outcome) {
      case 'ALREADY_HEALTHY':
      case 'FIXED':
        return 0;
      case 'APPLICATION_FIX_REQUIRED':
        return 1;
      case 'COULD_NOT_REPAIR':
        return 2;
    }
  })();
  return { ...partial, exitCode };
}

/** Adapter id resolution shared with the rest of the tool. */
export { adapterById };
