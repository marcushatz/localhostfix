import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { runInspection } from '../inspect/run.js';
import type { InspectionReport } from '../artifacts/report.js';

export function registerInspectCommand(program: Command): void {
  program
    .command('inspect [route]')
    .description('Run one full frontend inspection and generate artifacts')
    .option('--url <url>', 'explicit URL to inspect (skips server discovery for the origin)')
    .option('--route <route>', 'route to inspect (alternative to the positional argument)')
    .option('--headed', 'run Chromium with a visible window')
    .option('--allow-remote', 'permit non-localhost URLs (privacy risk — artifacts may contain remote data)')
    .option('--json', 'print report.json to stdout instead of the human summary')
    .action(async (routeArg: string | undefined, opts: {
      url?: string;
      route?: string;
      headed?: boolean;
      allowRemote?: boolean;
      json?: boolean;
    }) => {
      let urlOverride = opts.url;
      let route = opts.route ?? routeArg;
      // Allow `inspect --url http://host:port/path` to carry the route too.
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
      const { report, runDir } = await runInspection({
        cwd: process.cwd(),
        route,
        urlOverride,
        headed: opts.headed,
        allowRemote: opts.allowRemote,
        onProgress: opts.json ? undefined : (m) => console.error(pc.dim(`  ${m}`)),
      });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printSummary(report, runDir);
      }
      process.exit(report.exitCode);
    });
}

export function printSummary(r: InspectionReport, runDir: string): void {
  const color =
    r.domain === 'healthy' ? pc.green : r.domain === 'application' ? pc.yellow : pc.red;
  console.log('');
  console.log(`  ${color(pc.bold(r.verdict))} ${pc.dim(`(confidence: ${r.confidence})`)}`);
  console.log('');
  if (r.url) console.log(`  URL        ${r.url}`);
  console.log(`  Server     ${r.server.reachable ? `reachable at ${r.server.actualUrl}${r.server.reusedExisting ? ' (reused)' : ''}` : 'not reachable'}`);
  console.log(`  Browser    ${r.browser.launched ? 'Chromium launched' : (r.browser.detail ?? 'not launched')}`);
  if (r.navigation.attempted) {
    console.log(`  Navigation ${r.navigation.error ?? `HTTP ${r.navigation.status}`}`);
  }
  if (r.render.visibleElementCount !== null) {
    console.log(`  Render     ${r.render.visibleElementCount} visible elements, ${r.render.visibleTextLength} chars text`);
  }
  if (r.counts.pageErrors || r.counts.consoleErrors || r.counts.failedRequests) {
    console.log(
      `  Problems   ${r.counts.pageErrors} page errors, ${r.counts.consoleErrors} console errors, ${r.counts.failedRequests} failed requests`,
    );
  }
  if (r.evidence.length > 0) {
    console.log('');
    console.log(pc.bold('  Evidence'));
    for (const e of r.evidence.slice(0, 8)) console.log(`   - ${e.detail}`);
  }
  console.log('');
  console.log(pc.bold('  Next action ') + r.recommendation);
  console.log('');
  console.log(pc.dim(`  Artifacts: ${path.join(runDir, 'report.md')}`));
  console.log('');
}
