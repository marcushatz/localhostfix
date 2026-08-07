import fs from 'node:fs';
import path from 'node:path';
import { AgentViewConfigSchema, type AgentViewConfig } from './schema.js';

export const AGENTVIEW_DIR = '.agentview';
export const CONFIG_FILE = 'config.json';

export function agentviewDir(projectRoot: string): string {
  return path.join(projectRoot, AGENTVIEW_DIR);
}

export function configPath(projectRoot: string): string {
  return path.join(agentviewDir(projectRoot), CONFIG_FILE);
}

export interface LoadedConfig {
  config: AgentViewConfig;
  /** Path the config was loaded from, or null when defaults were used. */
  source: string | null;
  /** Set when a config file existed but could not be parsed/validated. */
  error: string | null;
}

export function loadConfig(projectRoot: string): LoadedConfig {
  const file = configPath(projectRoot);
  if (!fs.existsSync(file)) {
    return { config: AgentViewConfigSchema.parse({}), source: null, error: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { config: AgentViewConfigSchema.parse(raw), source: file, error: null };
  } catch (err) {
    return {
      config: AgentViewConfigSchema.parse({}),
      source: file,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function saveConfig(projectRoot: string, config: AgentViewConfig): string {
  const dir = agentviewDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(projectRoot);
  const { $schema: _ignored, ...rest } = config;
  const body = { $schema: 'https://agentview.dev/schema/config-v1.json', ...rest };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}
