#!/usr/bin/env node
import { Command } from 'commander';
import { registerInspectCommand } from '../commands/inspect.js';
import { registerDoctorCommand } from '../commands/doctor.js';
import { registerSetupCommand } from '../commands/setup.js';
import { registerWatchCommand } from '../commands/watch.js';
import { registerStatusCommand } from '../commands/status.js';
import { registerCleanCommand } from '../commands/clean.js';
import { registerHookCommand } from '../commands/hook.js';
import { toolVersion } from '../inspect/run.js';

const program = new Command();

program
  .name('agentview')
  .description(
    'Verifies that your coding agent can inspect the frontend it is changing: finds or starts the dev server, renders the app in Chromium, captures evidence, and explains which layer failed.',
  )
  .version(toolVersion());

registerSetupCommand(program);
registerDoctorCommand(program);
registerInspectCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerCleanCommand(program);
registerHookCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('agentview: unexpected error:', err instanceof Error ? err.message : err);
  process.exit(4);
});
