import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { AgentViewConfigSchema } from '../config/schema.js';
import { configPath, loadConfig, saveConfig } from '../config/config.js';
import { findProjectRoot, detectPackageManager, runScriptCommand } from '../project/discover.js';
import { detectDevScript, detectFramework } from '../frameworks/adapter.js';
import { checkBrowserInstalled } from '../browser/driver.js';
import { installClaudeIntegration } from '../integrations/claude-install.js';

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('One-time project configuration (detects framework, dev command, port; writes .agentview/config.json)')
    .option('--claude', 'also install the Claude Code project skill')
    .option('--auto <mode>', 'automatic verification mode: off | advisory | enforced')
    .option('--shared', 'install hooks into the committed .claude/settings.json instead of settings.local.json')
    .option('--force', 'overwrite detected fields in an existing config')
    .action(async (opts: { claude?: boolean; auto?: string; shared?: boolean; force?: boolean }) => {
      const changes: string[] = [];
      const project = findProjectRoot(process.cwd());
      console.log('');
      console.log(pc.bold('  AgentView setup'));
      console.log(`  Project root: ${project.root}`);

      if (!project.packageJson) {
        console.log(pc.yellow('  ! No package.json found. AgentView can still work with an explicit "url" or "devCommand" in .agentview/config.json.'));
      }

      const adapter = detectFramework(project.packageJson, project.root);
      const pm = detectPackageManager(project.root, project.packageJson);
      const script = detectDevScript(project.packageJson, adapter);
      console.log(`  Framework: ${adapter.displayName}`);
      console.log(`  Package manager: ${pm}`);
      console.log(script ? `  Dev command: ${runScriptCommand(pm, script.script)}` : pc.yellow('  ! No dev script detected'));

      // Merge into existing config; never clobber user-set fields unless --force.
      const existing = loadConfig(project.root);
      const detected = {
        framework: adapter.id,
        packageManager: pm,
        ...(script ? { devCommand: runScriptCommand(pm, script.script) } : {}),
        ...(adapter.defaultPort ? { expectedPort: adapter.defaultPort } : {}),
      };
      const base = existing.source && !existing.error ? existing.config : AgentViewConfigSchema.parse({});
      const merged = opts.force ? { ...base, ...detected } : { ...detected, ...stripUndefined(base), ...(existing.source ? {} : detected) };
      const auto = opts.auto;
      if (auto) {
        if (!['off', 'advisory', 'enforced'].includes(auto)) {
          console.error(pc.red(`  Invalid --auto mode: ${auto} (use off | advisory | enforced)`));
          process.exit(4);
        }
        merged.autoInspect = auto as 'off' | 'advisory' | 'enforced';
      }
      if (opts.claude) {
        const mode = merged.autoInspect;
        merged.claudeIntegration = mode && mode !== 'off' ? mode : 'advisory';
      }

      const parsed = AgentViewConfigSchema.parse(merged);
      const file = saveConfig(project.root, parsed);
      changes.push(`${existing.source ? 'Updated' : 'Created'} ${path.relative(project.root, file)}`);

      // .gitignore entries for generated artifacts.
      const gitignoreChanges = ensureGitignore(project.root);
      changes.push(...gitignoreChanges);

      // Browser dependency readiness.
      const availability = checkBrowserInstalled();
      if (availability.installed) {
        // The full executable path is ~120 characters of noise; the build
        // directory is the part that identifies what will run.
        const build = availability.foundBuilds.find((b) => b.startsWith('chromium-')) ?? 'installed';
        console.log(pc.green(`  ✓ Chromium ready (${build})`));
      } else {
        console.log(pc.yellow('  ! Chromium is not installed for Playwright.'));
        console.log(pc.yellow('    AgentView will not download browsers without your approval. Run:'));
        console.log(pc.bold('      npx playwright install chromium'));
      }

      // Claude Code integration.
      if (opts.claude) {
        const result = installClaudeIntegration(project.root, parsed, { shared: opts.shared ?? false });
        changes.push(...result.changes);
        for (const warning of result.warnings) console.log(pc.yellow(`  ! ${warning}`));
      }

      console.log('');
      console.log(pc.bold('  Changes made'));
      for (const c of changes) console.log(`  - ${c}`);

      // Say plainly whether the project is ready, and what to do if not.
      // Reporting "setup complete" for a project AgentView cannot inspect
      // would only move the failure to the next command.
      console.log('');
      console.log(pc.bold('  Next steps'));
      const canRun = Boolean(parsed.devCommand || parsed.url);
      if (!canRun) {
        console.log(pc.yellow('  ! AgentView cannot inspect this project yet: no dev command was found.'));
        console.log('    Add a "dev" script to package.json, or set "devCommand" or "url"');
        console.log(`    in ${path.relative(process.cwd(), file) || '.agentview/config.json'}.`);
      } else if (!availability.installed) {
        console.log('  1. npx playwright install chromium');
        console.log('  2. agentview doctor');
      } else {
        console.log('  1. agentview doctor      check the whole chain');
        console.log('  2. agentview inspect     inspect the rendered app');
      }
      if (!opts.claude) {
        console.log('');
        console.log(pc.dim('  `agentview setup --claude` installs the Claude Code skill and verification hook.'));
      }
      console.log('');
    });
}

function ensureGitignore(projectRoot: string): string[] {
  const file = path.join(projectRoot, '.gitignore');
  const entries = ['.agentview/runs/', '.agentview/latest/', '.agentview/state/'];
  const changes: string[] = [];
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = entries.filter((e) => !content.split('\n').some((line) => line.trim() === e || line.trim() === e.replace(/\/$/, '')));
  if (missing.length > 0) {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += '\n# AgentView generated artifacts (may contain screenshots of local data)\n' + missing.join('\n') + '\n';
    fs.writeFileSync(file, content);
    changes.push(`Added ${missing.join(', ')} to .gitignore`);
  }
  return changes;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
