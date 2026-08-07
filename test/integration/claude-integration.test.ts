import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { installClaudeIntegration } from '../../src/integrations/claude-install.js';
import { claudeIntegrationStatus } from '../../src/integrations/claude.js';
import { AgentViewConfigSchema } from '../../src/config/schema.js';

const CLI = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'dist', 'cli', 'main.js');

const dirs: string[] = [];
function tmpProject(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-claude-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { dev: 'node s.mjs' } }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const config = (mode: 'off' | 'advisory' | 'enforced') =>
  AgentViewConfigSchema.parse({ autoInspect: mode, claudeIntegration: mode });

describe('Claude integration install', () => {
  test('installs the skill with valid frontmatter', () => {
    const dir = tmpProject();
    installClaudeIntegration(dir, config('advisory'));

    const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'agentview', 'SKILL.md'), 'utf8');
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toMatch(/^name: agentview$/m);
    expect(skill).toMatch(/^description: .+/m);
    // The workflow must tell the agent to look at both screenshots.
    expect(skill).toMatch(/desktop\.png/);
    expect(skill).toMatch(/mobile\.png/);
    expect(claudeIntegrationStatus(dir).skillInstalled).toBe(true);
  });

  test('hooks go to settings.local.json, not the shared committed file', () => {
    const dir = tmpProject();
    installClaudeIntegration(dir, config('advisory'));

    expect(fs.existsSync(path.join(dir, '.claude', 'settings.local.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.claude', 'settings.json'))).toBe(false);
    expect(claudeIntegrationStatus(dir).hookLocation).toContain('settings.local.json');
  });

  test('--shared writes to the committed settings file instead', () => {
    const dir = tmpProject();
    installClaudeIntegration(dir, config('advisory'), { shared: true });
    expect(fs.existsSync(path.join(dir, '.claude', 'settings.json'))).toBe(true);
  });

  test('existing user settings and unrelated hooks are preserved', () => {
    const existing = {
      model: 'claude-opus-5',
      permissions: { allow: ['Bash(npm run test *)'] },
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    };
    const dir = tmpProject({
      '.claude/settings.local.json': JSON.stringify(existing, null, 2),
    });

    installClaudeIntegration(dir, config('advisory'));
    const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));

    // Unrelated top-level keys survive untouched.
    expect(after.model).toBe('claude-opus-5');
    expect(after.permissions.allow).toEqual(['Bash(npm run test *)']);
    // The user's own hooks survive alongside ours.
    expect(after.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    const prettierStillThere = after.hooks.PostToolUse.some((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === 'prettier --write'),
    );
    expect(prettierStillThere).toBe(true);
    // And ours was added.
    expect(JSON.stringify(after.hooks)).toContain('agentview-hook');
    // A backup of the original was taken.
    expect(fs.existsSync(path.join(dir, '.claude', 'settings.local.json.agentview-backup'))).toBe(true);
  });

  test('re-running does not duplicate hook entries', () => {
    const dir = tmpProject();
    installClaudeIntegration(dir, config('advisory'));
    installClaudeIntegration(dir, config('advisory'));
    installClaudeIntegration(dir, config('enforced'));

    const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
    const count = JSON.stringify(after).split('agentview-hook').length - 1;
    expect(count).toBe(2); // exactly one PostToolUse + one Stop
  });

  test('autoInspect off removes previously installed hooks', () => {
    const dir = tmpProject();
    installClaudeIntegration(dir, config('advisory'));
    expect(claudeIntegrationStatus(dir).hookInstalled).toBe(true);

    installClaudeIntegration(dir, config('off'));
    expect(claudeIntegrationStatus(dir).hookInstalled).toBe(false);
  });

  test('malformed settings are refused rather than clobbered', () => {
    const broken = '{ this is not json';
    const dir = tmpProject({ '.claude/settings.local.json': broken });

    const result = installClaudeIntegration(dir, config('advisory'));
    expect(result.warnings.join(' ')).toMatch(/not valid JSON/i);
    // The user's file is left exactly as it was.
    expect(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).toBe(broken);
  });
});

describe('hook runtime', () => {
  function runHook(dir: string, args: string[], input: unknown): string {
    return execFileSync(process.execPath, [CLI, 'hook', ...args], {
      cwd: dir,
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  const staleMarker = (dir: string) => path.join(dir, '.agentview', 'state', 'stale');

  test('a backend-only edit does not mark verification stale', () => {
    const dir = tmpProject();
    runHook(dir, ['post-tool'], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'server', 'db.sql') },
    });
    expect(fs.existsSync(staleMarker(dir))).toBe(false);
  });

  test('a frontend edit marks verification stale', () => {
    const dir = tmpProject();
    runHook(dir, ['post-tool'], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src', 'Hero.tsx') },
    });
    expect(fs.existsSync(staleMarker(dir))).toBe(true);
  });

  test('the stop hook does nothing when nothing frontend-relevant changed', () => {
    const dir = tmpProject({ '.agentview/config.json': JSON.stringify({ autoInspect: 'advisory' }) });
    const out = runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: false });
    expect(out.trim()).toBe(''); // no inspection, no output
  });

  test('the stop hook does nothing when autoInspect is off, even if stale', () => {
    const dir = tmpProject({
      '.agentview/config.json': JSON.stringify({ autoInspect: 'off' }),
      '.agentview/state/stale': 'now src/Hero.tsx',
    });
    const out = runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: false });
    expect(out.trim()).toBe('');
    // The marker is left alone so a later enabled run still sees it.
    expect(fs.existsSync(staleMarker(dir))).toBe(true);
  });

  test('a held lock prevents a concurrent inspection', () => {
    const dir = tmpProject({
      '.agentview/config.json': JSON.stringify({ autoInspect: 'advisory' }),
      '.agentview/state/stale': 'now src/Hero.tsx',
      '.agentview/state/inspect.lock': '999999',
    });
    const out = runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: false });
    expect(out.trim()).toBe('');
  });

  test('enforced mode never blocks twice: stop_hook_active suppresses blocking', () => {
    // A project with no dev script fails fast, so no browser is launched.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-claude-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }));
    fs.mkdirSync(path.join(dir, '.agentview', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agentview', 'config.json'),
      JSON.stringify({ autoInspect: 'enforced' }),
    );
    fs.writeFileSync(staleMarker(dir), 'now src/Hero.tsx');

    const blocked = JSON.parse(
      runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: false }),
    );
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toMatch(/DEV_COMMAND_NOT_FOUND/);

    // Second turn: Claude is already continuing because of us. Blocking again
    // is what would create an infinite loop, so it must not happen.
    fs.writeFileSync(staleMarker(dir), 'now src/Hero.tsx');
    const second = JSON.parse(
      runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: true }),
    );
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toMatch(/AgentView inspected/);
  });

  test('the stale marker is cleared by a run so one edit causes one inspection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-claude-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }));
    fs.mkdirSync(path.join(dir, '.agentview', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agentview', 'config.json'),
      JSON.stringify({ autoInspect: 'advisory' }),
    );
    fs.writeFileSync(staleMarker(dir), 'now src/Hero.tsx');

    const first = runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: false });
    expect(first).toMatch(/AgentView inspected/);
    expect(fs.existsSync(staleMarker(dir))).toBe(false);

    // Nothing changed since, so the next Stop is a no-op.
    const second = runHook(dir, ['stop'], { hook_event_name: 'Stop', stop_hook_active: false });
    expect(second.trim()).toBe('');
  });
});
