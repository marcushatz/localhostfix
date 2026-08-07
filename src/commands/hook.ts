import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { agentviewDir, loadConfig } from '../config/config.js';
import { findProjectRoot } from '../project/discover.js';
import { runInspection } from '../inspect/run.js';
import { isFrontendFile } from './watch.js';

/**
 * Hook runtime invoked by Claude Code:
 *
 *   agentview hook post-tool  — reads the PostToolUse JSON from stdin; when the
 *     edited file is frontend-relevant, marks verification stale. Never launches
 *     a browser; must stay fast.
 *
 *   agentview hook stop — reads the Stop JSON from stdin; when verification is
 *     stale, runs ONE inspection and clears the marker.
 *     Loop safety:
 *       - no stale marker → exit 0 immediately (nothing relevant changed)
 *       - stop_hook_active=true → never block again (max one forced
 *         continuation per turn, so a loop is impossible)
 *       - a lock file prevents concurrent inspections
 *     Modes (config.autoInspect):
 *       - advisory: never blocks; reports via systemMessage
 *       - enforced: blocks once with the diagnosis when the verdict is unhealthy
 */
export function registerHookCommand(program: Command): void {
  const hook = program.command('hook', { hidden: true }).description('Internal: Claude Code hook entry points');

  hook.command('post-tool').action(async () => {
    const input = await readStdinJson();
    const filePath = extractFilePath(input);
    if (!filePath || !isFrontendFile(filePath)) return; // backend-only edits never mark stale
    const project = findProjectRoot(process.cwd());
    const stateDir = path.join(agentviewDir(project.root), 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'stale'), new Date().toISOString() + ' ' + filePath + '\n', { flag: 'a' });
  });

  hook.command('stop').action(async () => {
    const input = await readStdinJson();
    const project = findProjectRoot(process.cwd());
    const { config } = loadConfig(project.root);
    if (config.autoInspect === 'off') return;

    const stateDir = path.join(agentviewDir(project.root), 'state');
    const staleMarker = path.join(stateDir, 'stale');
    if (!fs.existsSync(staleMarker)) return; // nothing relevant changed

    const lock = path.join(stateDir, 'inspect.lock');
    if (fs.existsSync(lock)) {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < 10 * 60 * 1000) return; // another inspection is running
      fs.rmSync(lock, { force: true }); // stale lock from a crashed run
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lock, String(process.pid));

    try {
      fs.rmSync(staleMarker, { force: true }); // clear BEFORE running: edits during the run re-mark
      const { report } = await runInspection({ cwd: project.root });
      const stopHookActive = Boolean((input as { stop_hook_active?: boolean }).stop_hook_active);
      const healthy = report.verdict === 'HEALTHY_RENDER';
      const summary = `AgentView inspected ${report.url ?? 'the app'}: ${report.verdict}. Report: .agentview/latest/report.md, screenshots: .agentview/latest/desktop.png / mobile.png`;

      if (config.autoInspect === 'enforced' && !healthy && !stopHookActive) {
        // Force one continuation so Claude sees the diagnosis. stop_hook_active
        // guarantees we never force a second one in the same turn.
        emit({
          decision: 'block',
          reason:
            `${summary}\nTop evidence:\n` +
            report.evidence.slice(0, 5).map((e) => `- ${e.detail}`).join('\n') +
            `\nRecommended next action: ${report.recommendation}\n` +
            `Domain: ${report.domain} (${report.domain === 'setup' ? 'environment problem — do not edit app code for this' : 'application problem'})`,
        });
      } else {
        emit({ systemMessage: summary });
      }
    } catch (err) {
      emit({ systemMessage: `AgentView auto-inspection failed to run: ${err instanceof Error ? err.message : err}` });
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
}

function emit(output: Record<string, unknown>): void {
  console.log(JSON.stringify(output));
}

function extractFilePath(input: unknown): string | null {
  const toolInput = (input as { tool_input?: { file_path?: string; notebook_path?: string } }).tool_input;
  return toolInput?.file_path ?? toolInput?.notebook_path ?? null;
}

async function readStdinJson(): Promise<unknown> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
