import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { runFix, type FixResult } from '../fixes/engine.js';

export function registerFixCommand(program: Command): void {
  program
    .command('fix [route]')
    .description('Attempt safe recovery of frontend inspection, then verify whether it works again')
    .option('--url <url>', 'explicit URL to inspect (also resolves ambiguous servers)')
    .option('--route <route>', 'route to inspect (alternative to the positional argument)')
    .option('--yes', 'approve actions that install software (currently the Chromium build)')
    .option('--allow-remote', 'permit non-localhost URLs (privacy risk — see docs/PRIVACY.md)')
    .option('--json', 'print the machine-readable result to stdout')
    .action(async (routeArg: string | undefined, opts: {
      url?: string;
      route?: string;
      yes?: boolean;
      allowRemote?: boolean;
      json?: boolean;
    }) => {
      let urlOverride = opts.url;
      let route = opts.route ?? routeArg;
      if (urlOverride) {
        try {
          const u = new URL(urlOverride);
          if (u.pathname !== '/' && !route) route = u.pathname;
          urlOverride = u.origin;
        } catch {
          console.error(pc.red(`Invalid --url: ${urlOverride}`));
          process.exit(4);
        }
      }

      const result = await runFix({
        cwd: process.cwd(),
        route,
        urlOverride,
        approveInstall: opts.yes,
        allowRemote: opts.allowRemote,
        onProgress: opts.json ? undefined : (m) => console.error(pc.dim(`  ${m}`)),
      });

      if (opts.json) {
        console.log(JSON.stringify(toJson(result), null, 2));
      } else {
        printFixResult(result);
      }
      process.exit(result.exitCode);
    });
}

function toJson(r: FixResult) {
  return {
    outcome: r.outcome,
    initialVerdict: r.initialVerdict,
    finalVerdict: r.finalReport.verdict,
    verified: r.verified,
    fixesApplied: r.fixesApplied,
    blockedBy: r.blockedBy,
    requiresApproval: r.requiresApproval,
    evidence: r.finalReport.evidence,
    recommendation: r.finalReport.recommendation,
    exitCode: r.exitCode,
    runDir: r.finalReport.runDir,
  };
}

export function printFixResult(r: FixResult): void {
  const report = r.finalReport;
  const colour =
    r.outcome === 'FIXED' || r.outcome === 'ALREADY_HEALTHY'
      ? pc.green
      : r.outcome === 'APPLICATION_FIX_REQUIRED'
        ? pc.yellow
        : pc.red;

  console.log('');
  console.log(`  ${colour(pc.bold(r.outcome))}`);
  console.log('');

  if (r.fixesApplied.length > 0) {
    for (const fix of r.fixesApplied) {
      console.log(`  ${fix.succeeded ? pc.green('✓') : pc.red('✗')} ${capitalize(fix.problem)}.`);
      console.log(`    ${fix.change}.`);
    }
    console.log('');
  }

  switch (r.outcome) {
    case 'ALREADY_HEALTHY':
      // Inspection was never broken. Saying "nothing needed repair" would
      // contradict the configuration corrections listed above it.
      console.log(
        r.fixesApplied.some((f) => f.succeeded)
          ? '  Inspection was already working; stored configuration was corrected.'
          : '  Nothing needed repair.',
      );
      console.log(`  Project server: ${report.server.actualUrl}`);
      console.log('  Chromium launched. Application rendered.');
      console.log('');
      console.log('  Frontend inspection is working.');
      break;

    case 'FIXED':
      console.log(`  Project server found at ${report.server.actualUrl}.`);
      console.log('  Chromium launched. Application rendered.');
      console.log('');
      console.log(pc.green('  Frontend inspection restored.'));
      break;

    case 'APPLICATION_FIX_REQUIRED':
      console.log('  Server and browser are healthy.');
      console.log(`  ${describeApplicationFailure(report.verdict)}`);
      if (report.evidence.length > 0) {
        console.log('');
        console.log('  Evidence:');
        for (const e of report.evidence.slice(0, 8)) console.log(`    ${e.detail}`);
      }
      console.log('');
      console.log('  AgentView made no source-code changes.');
      console.log('  Fix the application, then rerun:');
      console.log('    agentview inspect');
      break;

    case 'COULD_NOT_REPAIR':
      if (r.blockedBy) console.log(`  ${capitalize(r.blockedBy)}`);
      if (r.requiresApproval) {
        console.log('');
        console.log(`  ${r.requiresApproval.action}:`);
        console.log(`    ${r.requiresApproval.command}`);
        console.log('');
        console.log('  Or re-run with --yes to let AgentView do it.');
      }
      break;
  }

  console.log('');
  const reportPath = path.relative(process.cwd(), path.join(report.runDir, 'report.md'));
  console.log(pc.dim(`  Report: ${reportPath.startsWith('..') ? report.runDir : reportPath}`));
  if (r.verified) {
    console.log(pc.dim('  This outcome was confirmed by a fresh inspection after the fix.'));
  }
  console.log('');
}

function describeApplicationFailure(verdict: string): string {
  switch (verdict) {
    case 'APPLICATION_RUNTIME_FAILURE':
      return 'The application crashed during render.';
    case 'LIKELY_BLANK_RENDER':
      return 'The application rendered blank.';
    case 'FAILED_DEPENDENCY_REQUEST':
      return 'The application shell rendered, but critical requests failed.';
    case 'ROUTE_NOT_FOUND':
      return 'The requested route does not exist.';
    case 'AUTHENTICATION_GATE':
      return 'The route is behind authentication. AgentView will not bypass it.';
    case 'PARTIAL_RENDER':
      return 'The application rendered with problems.';
    default:
      return 'The application did not render correctly.';
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
