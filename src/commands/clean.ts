import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Command } from 'commander';
import { agentviewDir } from '../config/config.js';
import { findProjectRoot } from '../project/discover.js';

export function registerCleanCommand(program: Command): void {
  program
    .command('clean')
    .description('Remove AgentView-generated runs, latest artifacts, and state (keeps config.json)')
    .action(() => {
      const project = findProjectRoot(process.cwd());
      const dir = agentviewDir(project.root);
      let removed = 0;
      for (const sub of ['runs', 'latest', 'state']) {
        const target = path.join(dir, sub);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          console.log(pc.dim(`  removed ${target}`));
          removed++;
        }
      }
      console.log(removed > 0 ? pc.green(`  Cleaned ${removed} director${removed === 1 ? 'y' : 'ies'}.`) : '  Nothing to clean.');
    });
}
