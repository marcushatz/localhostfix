import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { agentviewDir, loadConfig } from '../config/config.js';
import { findProjectRoot } from '../project/discover.js';
import { claudeIntegrationStatus } from '../integrations/claude.js';
import type { InspectionReport } from '../artifacts/report.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show AgentView config, integration state, and the last inspection result')
    .action(() => {
      const project = findProjectRoot(process.cwd());
      const { config, source } = loadConfig(project.root);
      const claude = claudeIntegrationStatus(project.root);
      console.log('');
      console.log(pc.bold('  AgentView status'));
      console.log(`  Project root : ${project.root}`);
      console.log(`  Config       : ${source ? path.relative(process.cwd(), source) : 'none — run `agentview setup`'}`);
      console.log(`  Framework    : ${config.framework ?? 'detected at run time'}`);
      console.log(`  Dev command  : ${config.devCommand ?? 'detected at run time'}`);
      console.log(
        `  URL          : ${config.url ?? (config.expectedPort ? `discovered (expecting port ${config.expectedPort})` : 'discovered at run time')}`,
      );
      console.log(`  Claude skill : ${claude.skillInstalled ? 'installed' : 'not installed'}`);
      console.log(`  Auto-inspect : ${claude.hookInstalled ? config.autoInspect : 'off (hook not installed)'}`);
      const latestReport = path.join(agentviewDir(project.root), 'latest', 'report.json');
      if (fs.existsSync(latestReport)) {
        try {
          const report = JSON.parse(fs.readFileSync(latestReport, 'utf8')) as InspectionReport;
          const when = report.startedAt.replace('T', ' ').replace(/\..+$/, '');
          console.log(`  Last run     : ${report.verdict} — ${report.url ?? 'no URL determined'} (${when})`);
        } catch {
          console.log('  Last run     : (unreadable report.json)');
        }
      } else {
        console.log('  Last run     : none');
      }
      console.log('');
    });
}
