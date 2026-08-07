import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTVIEW_HOOK_MARKER,
  LOCAL_SETTINGS_FILE,
  SHARED_SETTINGS_FILE,
  SKILL_DIR,
} from './claude.js';
import type { AgentViewConfig } from '../config/schema.js';

export interface InstallResult {
  changes: string[];
  warnings: string[];
}

export interface InstallOptions {
  /** Write hooks to the committed .claude/settings.json instead of settings.local.json. */
  shared?: boolean;
}

/**
 * Install the project-level Claude Code integration:
 *  1. .claude/skills/agentview/SKILL.md — the inspection workflow skill.
 *  2. Optional hooks in .claude/settings.json (autoInspect != off):
 *     PostToolUse → mark frontend verification stale (cheap, no browser)
 *     Stop        → run one inspection when state is stale
 *
 * Existing settings are preserved: we parse, append only our own hook
 * entries (identified by the AGENTVIEW_HOOK_MARKER in the command), and
 * never touch unrelated keys. A backup is written before the first edit.
 */
export function installClaudeIntegration(
  projectRoot: string,
  config: AgentViewConfig,
  options: InstallOptions = {},
): InstallResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const SETTINGS_FILE = options.shared ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE;

  // 1. Skill
  const skillDir = path.join(projectRoot, SKILL_DIR);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  const existedBefore = fs.existsSync(skillPath);
  fs.writeFileSync(skillPath, skillContent());
  changes.push(`${existedBefore ? 'Updated' : 'Created'} ${path.relative(projectRoot, skillPath)}`);

  // 2. Hooks
  if (config.autoInspect === 'off') {
    removeAgentViewHooks(projectRoot, changes);
    return { changes, warnings };
  }

  const settingsPath = path.join(projectRoot, SETTINGS_FILE);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const backup = settingsPath + '.agentview-backup';
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(settingsPath, backup);
        changes.push(`Backed up existing settings to ${path.relative(projectRoot, backup)}`);
      }
    } catch {
      warnings.push(`${SETTINGS_FILE} exists but is not valid JSON — hooks NOT installed. Fix the file and re-run setup.`);
      return { changes, warnings };
    }
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  upsertHook(hooks, 'PostToolUse', 'Write|Edit|MultiEdit|NotebookEdit', `npx agentview hook post-tool # ${AGENTVIEW_HOOK_MARKER}`);
  upsertHook(hooks, 'Stop', '', `npx agentview hook stop # ${AGENTVIEW_HOOK_MARKER}`, 300);

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  changes.push(`Installed AgentView hooks in ${path.relative(projectRoot, settingsPath)} (mode: ${config.autoInspect})`);
  changes.push('Undo: remove the entries containing "agentview-hook" from that file, or run setup with --auto off');
  return { changes, warnings };
}

interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number }[];
}

function upsertHook(
  hooks: Record<string, unknown[]>,
  event: string,
  matcher: string,
  command: string,
  timeout?: number,
): void {
  const list = (hooks[event] ??= []) as HookEntry[];
  // Replace any previous AgentView entry for this event; keep user entries.
  const filtered = list.filter(
    (entry) => !entry.hooks?.some((h) => h.command?.includes(AGENTVIEW_HOOK_MARKER)),
  );
  const entry: HookEntry = {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }],
  };
  filtered.push(entry);
  hooks[event] = filtered;
}

function removeAgentViewHooks(projectRoot: string, changes: string[]): void {
  for (const file of [LOCAL_SETTINGS_FILE, SHARED_SETTINGS_FILE]) {
    removeFromSettingsFile(path.join(projectRoot, file), changes);
  }
}

function removeFromSettingsFile(settingsPath: string, changes: string[]): void {
  if (!fs.existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, HookEntry[]> | undefined;
    if (!hooks) return;
    let removed = false;
    for (const event of Object.keys(hooks)) {
      const list = hooks[event] ?? [];
      const filtered = list.filter(
        (entry) => !entry.hooks?.some((h) => h.command?.includes(AGENTVIEW_HOOK_MARKER)),
      );
      if (filtered.length !== list.length) {
        removed = true;
        if (filtered.length === 0) delete hooks[event];
        else hooks[event] = filtered;
      }
    }
    if (removed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      changes.push('Removed AgentView hooks (autoInspect: off)');
    }
  } catch {
    /* leave unreadable settings untouched */
  }
}

function skillContent(): string {
  return `---
name: agentview
description: Verify the rendered frontend with AgentView before making visual claims. Use after editing frontend files (components, styles, pages), when asked whether the UI looks right, when a page seems blank or broken on localhost, or before saying a frontend change is complete.
---

# AgentView — rendered-frontend verification

AgentView opens the real app in Chromium and captures evidence. Use it instead of assuming the frontend looks correct from source code alone.

## When to run

- After completing frontend changes (components, pages, styles, layouts).
- Before claiming anything about how the UI looks or behaves.
- When localhost seems blank, broken, or unreachable.

## How to run

\`\`\`bash
npx agentview inspect            # default route
npx agentview inspect /profile   # specific route
npx agentview doctor             # when inspection itself fails
\`\`\`

## After every run — read the evidence

1. Read \`.agentview/latest/report.md\` — verdict, evidence, recommended next action.
2. View BOTH screenshots: \`.agentview/latest/desktop.png\` and \`.agentview/latest/mobile.png\` (use the Read tool — they are images).
3. Check \`page-errors.json\`, \`console.json\`, and \`network.json\` when the verdict is not HEALTHY_RENDER.

## Rules

- NEVER claim the frontend was visually verified unless an inspection succeeded AND you looked at the screenshots.
- The report's \`domain\` field tells you whose problem a failure is:
  - \`setup\` → environment problem (server, port, browser). Fix per the recommendation or run \`agentview doctor\`. Do NOT edit application code to fix these.
  - \`application\` → the app itself failed (runtime error, failed API, blank render, missing route). Use the evidence to debug the app.
- HEALTHY_RENDER means the page rendered — not that it is visually correct. Judge correctness from the screenshots.
- If \`likelyBlank\` is "uncertain", the page may be intentionally minimal — check the screenshot before concluding anything.
- Exit codes: 0 healthy · 1 application problem · 2 setup problem · 3 indeterminate.

## When inspection itself is broken

Run \`npx agentview fix\`. It repairs only setup problems it owns (wrong stored
port, server not running, stale state, corrupt AgentView config) and then
re-inspects to verify. Its outcome tells you what to do:

- \`FIXED\` / \`ALREADY_HEALTHY\` — inspection works; carry on and read the report.
- \`APPLICATION_FIX_REQUIRED\` — the tooling is fine and YOUR CODE is broken. The
  evidence you need is in the output and in \`.agentview/latest/\`. Fix the app,
  then run \`npx agentview inspect\` again.
- \`COULD_NOT_REPAIR\` — AgentView will not act safely here. Read the stated
  reason; it names the next action (often \`--url\`, or a command to run).

\`fix\` never edits source code. If it reports \`APPLICATION_FIX_REQUIRED\`, the
repair is yours to make.
`;
}
