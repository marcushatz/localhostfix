import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../config/config.js';
import { findProjectRoot, detectPackageManager, runScriptCommand } from '../project/discover.js';
import { adapterById, detectDevScript, detectFramework } from '../frameworks/adapter.js';
import { ensureServer } from '../server/lifecycle.js';
import { describeCandidate, describeSelection, discoverServers } from '../server/discovery.js';
import { checkBrowserInstalled, launchChromium } from '../browser/driver.js';
import { claudeIntegrationStatus } from '../integrations/claude.js';

type Level = 'ok' | 'warn' | 'fail' | 'unknown' | 'action';

interface Finding {
  level: Level;
  text: string;
}

interface Section {
  title: string;
  findings: Finding[];
}

const ICON: Record<Level, string> = {
  ok: pc.green('✓'),
  warn: pc.yellow('!'),
  fail: pc.red('✗'),
  unknown: pc.dim('?'),
  action: pc.cyan('→'),
};

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose the full frontend-inspection chain without modifying anything')
    .option('--fix', 'apply safe fixes (store detected port/URL in AgentView config)')
    .option('--no-server', 'skip starting the dev server (probe only)')
    .action(async (opts: { fix?: boolean; server?: boolean }) => {
      const result = await runDoctor({ cwd: process.cwd(), fix: opts.fix ?? false, startServer: opts.server !== false });
      console.log('');
      console.log(pc.bold('  AGENTVIEW DOCTOR'));
      for (const section of result.sections) {
        console.log('');
        console.log(pc.bold(`  ${section.title}`));
        for (const f of section.findings) console.log(`  ${ICON[f.level]} ${f.text}`);
      }
      if (result.recommendations.length > 0) {
        console.log('');
        console.log(pc.bold('  Recommended actions'));
        result.recommendations.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
      }
      console.log('');
      process.exit(result.exitCode);
    });
}

export interface DoctorResult {
  sections: Section[];
  recommendations: string[];
  exitCode: number;
}

export async function runDoctor(opts: {
  cwd: string;
  fix: boolean;
  startServer: boolean;
}): Promise<DoctorResult> {
  const sections: Section[] = [];
  const recommendations: string[] = [];
  const note = (section: Section, level: Level, text: string) => {
    section.findings.push({ level, text });
  };

  // ── Project ──────────────────────────────────────────────────────────
  const projectSection: Section = { title: 'Project', findings: [] };
  sections.push(projectSection);
  const project = findProjectRoot(opts.cwd);
  const { config, source: configSource, error: configError } = loadConfig(project.root);

  if (!project.packageJson && !config.url && !config.devCommand) {
    note(projectSection, 'fail', `No package.json found from ${opts.cwd} and no AgentView config`);
    recommendations.push('Run `agentview setup` inside a Node.js project.');
    return { sections, recommendations, exitCode: 2 };
  }
  const adapter = adapterById(config.framework) ?? detectFramework(project.packageJson, project.root);
  const pm = detectPackageManager(project.root, project.packageJson);
  note(projectSection, 'ok', `Project root: ${project.root}`);
  note(projectSection, 'ok', `Framework: ${adapter.displayName}`);
  note(projectSection, 'ok', `Package manager: ${pm}`);

  let devCommand = config.devCommand ?? null;
  if (!devCommand) {
    const script = detectDevScript(project.packageJson, adapter);
    if (script) devCommand = runScriptCommand(pm, script.script);
  }
  if (devCommand) {
    note(projectSection, 'ok', `Development command: ${devCommand}`);
  } else if (config.url) {
    note(projectSection, 'warn', 'No development command; relying on configured "url"');
  } else {
    note(projectSection, 'fail', 'No development command found (no dev/start/serve script)');
    recommendations.push('Add a dev script to package.json or set "devCommand" in .agentview/config.json.');
  }

  if (configError) {
    note(projectSection, 'fail', `.agentview/config.json is invalid: ${configError.split('\n')[0]}`);
    recommendations.push('Fix or delete .agentview/config.json, then re-run `agentview setup`.');
  } else if (configSource) {
    note(projectSection, 'ok', 'AgentView config: .agentview/config.json');
  } else {
    note(projectSection, 'warn', 'No AgentView config yet (defaults in use) — run `agentview setup`');
  }

  // ── Configured URL ───────────────────────────────────────────────────
  const expectedPort = config.expectedPort ?? adapter.defaultPort;
  const configuredUrl = config.url ?? (expectedPort ? `http://localhost:${expectedPort}` : null);
  const configuredSection: Section = { title: 'Configured URL', findings: [] };
  sections.push(configuredSection);
  if (configuredUrl) {
    note(configuredSection, config.url || config.expectedPort ? 'ok' : 'warn',
      `${configuredUrl}${config.url ? '' : config.expectedPort ? '' : ` (${adapter.displayName} default — not configured)`}`);
  } else {
    note(configuredSection, 'warn', 'No URL or port configured; AgentView will discover one');
  }

  // ── Port ownership ───────────────────────────────────────────────────
  // The same discovery `inspect` uses, so the two commands can never
  // disagree about which server belongs to this project.
  const discovery = await discoverServers({
    projectRoot: project.root,
    adapter,
    configuredUrl: config.url,
    configuredPort: expectedPort ?? undefined,
    allowRemote: config.allowRemote,
  });

  if (discovery.remoteUrlBlocked) {
    note(configuredSection, 'fail',
      `${discovery.remoteUrlBlocked} is not a localhost URL — AgentView did not contact it`);
    recommendations.push(
      'AgentView inspects localhost only. Set a local "url", or pass --allow-remote if you understand that artifacts may then contain remote data.',
    );
  }

  const ownershipSection: Section = { title: 'Port ownership', findings: [] };
  sections.push(ownershipSection);
  if (discovery.ownershipUnavailable) {
    note(ownershipSection, 'unknown',
      'Process inspection unavailable on this system (lsof missing or restricted) — AgentView cannot verify which project owns a port');
  } else if (discovery.foreignServers.length > 0) {
    for (const foreign of discovery.foreignServers) {
      note(ownershipSection, 'fail',
        `Port ${foreign.port} belongs to a different project:\n      ${foreign.cwd ?? '(directory unreadable)'}`);
    }
    recommendations.push(
      'The configured port is serving another project. Inspecting it would verify the wrong application.',
    );
  } else if (configuredUrl) {
    const port = expectedPort;
    const owned = discovery.projectServers.some((s) => s.port === port);
    if (owned) note(ownershipSection, 'ok', `Port ${port} is owned by this project`);
    else note(ownershipSection, 'ok', `Port ${port} is not occupied by another project`);
  }

  // ── Detected project server ──────────────────────────────────────────
  const serverSection: Section = { title: 'Detected project server', findings: [] };
  sections.push(serverSection);
  let actualUrl: string | null = null;

  if (discovery.ambiguous) {
    note(serverSection, 'fail',
      `${discovery.projectServers.length} servers are listening inside this project and none is clearly the dev server:`);
    for (const c of discovery.projectServers) {
      note(serverSection, 'unknown', `    ${describeCandidate(c)}`);
    }
    if (discovery.preferred) {
      note(serverSection, 'unknown', `    best guess: port ${discovery.preferred.port}`);
    }
    recommendations.push(
      'Several servers are running here. Re-run with `--url http://localhost:<port>` or stop the ones you are not using.',
    );
  } else if (discovery.selected) {
    actualUrl = discovery.selected.url;
    note(serverSection, 'ok', `Current project is listening on:\n      ${actualUrl}`);
    note(serverSection, 'ok', `Chosen because: ${describeSelection(discovery)}`);
    for (const other of discovery.projectServers.filter((s) => s.url !== actualUrl)) {
      note(serverSection, 'unknown', `Also running in this project: ${describeCandidate(other)}`);
    }
  }

  if (!actualUrl && !discovery.ambiguous && devCommand && opts.startServer) {
    note(serverSection, 'action', `Starting dev server to verify it works: ${devCommand}`);
    const result = await ensureServer({
      command: devCommand,
      cwd: path.join(project.root, config.cwd ?? '.'),
      projectRoot: project.root,
      adapter,
      expectedPort: expectedPort ?? undefined,
      explicitUrl: config.url,
      startupTimeoutMs: config.startupTimeoutMs,
    });
    if (result.ok) {
      actualUrl = result.handle.url;
      note(serverSection, 'ok', `Process started; actual URL: ${result.handle.url}`);
      await result.handle.stop();
    } else if (result.kind === 'SERVER_START_FAILED') {
      note(serverSection, 'fail', 'Dev server exited before becoming reachable');
      const tail = result.log.split('\n').filter(Boolean).slice(-4);
      for (const line of tail) note(serverSection, 'unknown', pc.dim(line.slice(0, 120)));
      recommendations.push('Fix the dev server startup error shown above.');
    } else {
      note(serverSection, 'fail', `Dev server did not become reachable within ${config.startupTimeoutMs}ms`);
      recommendations.push('Increase "startupTimeoutMs" or set "url" explicitly in .agentview/config.json.');
    }
  } else if (!actualUrl && !discovery.ambiguous && !opts.startServer) {
    note(serverSection, 'unknown', 'No server running for this project; start skipped (--no-server)');
  } else if (!actualUrl && !discovery.ambiguous && !devCommand) {
    note(serverSection, 'fail', 'No server running for this project, and no dev command to start one');
  }

  if (actualUrl && expectedPort) {
    const actualPort = Number(new URL(actualUrl).port || 80);
    if (actualPort !== expectedPort) {
      note(serverSection, 'warn', `Configuration expects port ${expectedPort}, but this project's server is on ${actualPort}`);
      if (opts.fix) {
        saveConfig(project.root, { ...config, expectedPort: actualPort });
        note(serverSection, 'ok', `Fixed: stored expectedPort ${actualPort} in .agentview/config.json (undo: edit the file)`);
      } else {
        recommendations.push(`Update AgentView configuration to port ${actualPort} — run \`agentview doctor --fix\`.`);
      }
    }
  }

  // ── Browser ──────────────────────────────────────────────────────────
  const browserSection: Section = { title: 'Browser', findings: [] };
  sections.push(browserSection);
  note(browserSection, 'ok', 'Playwright package available (bundled with AgentView)');
  const availability = checkBrowserInstalled();
  if (availability.installed) {
    note(browserSection, 'ok', `Chromium executable: ${availability.executablePath}`);
    const launch = await launchChromium();
    if (launch.ok) {
      await launch.browser.close();
      note(browserSection, 'ok', 'Chromium launches successfully');
    } else {
      note(browserSection, 'fail', `Chromium launch failed: ${launch.detail.split('\n')[0]}`);
      recommendations.push('Reinstall the browser: npx playwright install chromium');
    }
  } else {
    note(browserSection, 'fail', 'Chromium executable unavailable');
    recommendations.push('Install the supported Chromium build: npx playwright install chromium');
  }

  // ── Claude integration ───────────────────────────────────────────────
  const claudeSection: Section = { title: 'Claude integration', findings: [] };
  sections.push(claudeSection);
  const claude = claudeIntegrationStatus(project.root);
  if (claude.skillInstalled) {
    note(claudeSection, 'ok', 'Project skill installed (.claude/skills/agentview)');
  } else {
    note(claudeSection, 'warn', 'Project skill not installed — run `agentview setup --claude`');
  }
  if (claude.hookInstalled) {
    note(claudeSection, 'ok', `Automatic verification hook enabled in ${claude.hookLocation} (mode: ${config.autoInspect})`);
    if (config.autoInspect === 'off') {
      note(claudeSection, 'warn', 'Hook is installed but autoInspect is "off" — it will exit immediately');
    }
  } else {
    note(claudeSection, 'warn', 'Automatic verification hook not enabled');
  }

  const hasFailure = sections.some((s) => s.findings.some((f) => f.level === 'fail'));
  return { sections, recommendations, exitCode: hasFailure ? 2 : 0 };
}

export function doctorArtifactsDirIgnored(projectRoot: string): boolean {
  const gitignore = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignore)) return false;
  return fs.readFileSync(gitignore, 'utf8').includes('.agentview/runs');
}
