import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { findProjectRoot } from '../project/discover.js';
import { runInspection } from '../inspect/run.js';
import { printSummary } from './inspect.js';

const FRONTEND_EXTENSIONS = new Set([
  '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.less',
  '.html', '.vue', '.svelte', '.astro', '.mdx',
]);

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.localhostfix', 'dist', 'build', '.next', 'coverage', 'out']);

export function isFrontendFile(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  if (parts.some((p) => IGNORED_SEGMENTS.has(p))) return false;
  return FRONTEND_EXTENSIONS.has(path.extname(filePath));
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch frontend files and re-run inspection after changes settle')
    .option('--route <route>', 'route to inspect on each run')
    .option('--debounce <ms>', 'quiet period after the last change before inspecting', '2000')
    .action(async (opts: { route?: string; debounce: string }) => {
      const project = findProjectRoot(process.cwd());
      const debounceMs = Math.max(500, Number(opts.debounce) || 2000);
      console.log(pc.bold(`  Watching ${project.root} for frontend changes (debounce ${debounceMs}ms). Ctrl-C to stop.`));

      let timer: NodeJS.Timeout | null = null;
      let running = false;
      let rerunRequested = false;

      const inspectOnce = async () => {
        if (running) {
          rerunRequested = true;
          return;
        }
        running = true;
        try {
          const { report, runDir } = await runInspection({
            cwd: project.root,
            route: opts.route,
            onProgress: (m) => console.error(pc.dim(`  ${m}`)),
          });
          printSummary(report, runDir);
        } catch (err) {
          console.error(pc.red(`  watch: inspection failed: ${err instanceof Error ? err.message : err}`));
        } finally {
          running = false;
          if (rerunRequested) {
            rerunRequested = false;
            schedule();
          }
        }
      };

      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void inspectOnce(), debounceMs);
      };

      try {
        fs.watch(project.root, { recursive: true }, (_event, filename) => {
          if (!filename || !isFrontendFile(filename)) return;
          console.log(pc.dim(`  changed: ${filename}`));
          schedule();
        });
      } catch (err) {
        console.error(pc.red(`  watch: cannot watch ${project.root}: ${err instanceof Error ? err.message : err}`));
        process.exit(2);
      }

      // Initial run so the watcher always starts from a known state.
      schedule();

      // Interrupting mid-inspection could otherwise orphan a dev server that
      // LocalhostFix started, so wait for the in-flight run to finish cleaning
      // up before exiting. A second interrupt exits immediately.
      await new Promise<void>((resolve) => {
        let stopping = false;
        const shutdown = () => {
          if (stopping) process.exit(130);
          stopping = true;
          if (timer) clearTimeout(timer);
          if (running) {
            console.log(pc.dim('\n  Finishing the current inspection before exiting… (Ctrl-C again to force)'));
            const poll = setInterval(() => {
              if (!running) {
                clearInterval(poll);
                resolve();
              }
            }, 100);
          } else {
            resolve();
          }
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
      console.log(pc.dim('  Stopped watching.'));
    });
}
