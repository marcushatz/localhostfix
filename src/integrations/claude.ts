import fs from 'node:fs';
import path from 'node:path';

/**
 * Claude Code project-level integration.
 *
 * - Skill:  .claude/skills/localhostfix/SKILL.md  (auto-discovered by Claude Code)
 * - Hooks:  .claude/settings.json → hooks.PostToolUse (mark stale) + hooks.Stop
 *           (run one inspection when a task finishes with stale frontend state)
 *
 * Everything LocalhostFix writes is additive: existing settings keys and existing
 * hooks are preserved; we only append our own entries, identified by the
 * LOCALHOSTFIX_HOOK marker so they can be found and removed cleanly.
 */

export const SKILL_DIR = path.join('.claude', 'skills', 'localhostfix');

/**
 * Hooks go to settings.local.json by default: it is personal and
 * git-ignored, so installing LocalhostFix never imposes a browser-launching
 * hook on everyone who clones the repo. `--shared` opts into the committed
 * settings.json for teams that want it.
 */
export const LOCAL_SETTINGS_FILE = path.join('.claude', 'settings.local.json');
export const SHARED_SETTINGS_FILE = path.join('.claude', 'settings.json');
export const LOCALHOSTFIX_HOOK_MARKER = 'localhostfix-hook';

export interface ClaudeStatus {
  skillInstalled: boolean;
  hookInstalled: boolean;
  /** Which settings file currently carries the LocalhostFix hooks. */
  hookLocation: string | null;
}

export function claudeIntegrationStatus(projectRoot: string): ClaudeStatus {
  const skillInstalled = fs.existsSync(path.join(projectRoot, SKILL_DIR, 'SKILL.md'));
  for (const file of [LOCAL_SETTINGS_FILE, SHARED_SETTINGS_FILE]) {
    const settingsPath = path.join(projectRoot, file);
    if (!fs.existsSync(settingsPath)) continue;
    try {
      if (fs.readFileSync(settingsPath, 'utf8').includes(LOCALHOSTFIX_HOOK_MARKER)) {
        return { skillInstalled, hookInstalled: true, hookLocation: file };
      }
    } catch {
      /* unreadable settings are reported as "not installed" */
    }
  }
  return { skillInstalled, hookInstalled: false, hookLocation: null };
}
