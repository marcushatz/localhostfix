import fs from 'node:fs';
import path from 'node:path';
import { LocalhostFixConfigSchema, type LocalhostFixConfig } from './schema.js';

export const LOCALHOSTFIX_DIR = '.localhostfix';
export const CONFIG_FILE = 'config.json';

/**
 * The directory this tool used before it was renamed from "AgentView", which
 * was never publicly released. This exists only so a development machine that
 * ran a pre-rename build gets told what happened instead of silently losing
 * its configuration.
 *
 * Nothing is moved or deleted automatically, and no command reads from it.
 * Delete this constant and `legacyDirNotice()` once no such machine matters —
 * see docs/NAMING.md.
 */
const LEGACY_DIR = '.agentview';

/**
 * A one-line warning when a pre-rename directory is present, or null.
 * Callers print it; it never changes behaviour.
 */
export function legacyDirNotice(projectRoot: string): string | null {
  const legacy = path.join(projectRoot, LEGACY_DIR);
  if (!fs.existsSync(legacy)) return null;
  if (fs.existsSync(path.join(projectRoot, LOCALHOSTFIX_DIR))) {
    return `A leftover ${LEGACY_DIR}/ directory from the old name is still present. Nothing reads it; delete it when convenient.`;
  }
  return `Found ${LEGACY_DIR}/ from the previous name (AgentView). Move your settings with: mv ${LEGACY_DIR} ${LOCALHOSTFIX_DIR}`;
}

export function localhostfixDir(projectRoot: string): string {
  return path.join(projectRoot, LOCALHOSTFIX_DIR);
}

export function configPath(projectRoot: string): string {
  return path.join(localhostfixDir(projectRoot), CONFIG_FILE);
}

export interface LoadedConfig {
  config: LocalhostFixConfig;
  /** Path the config was loaded from, or null when defaults were used. */
  source: string | null;
  /** Set when a config file existed but could not be parsed/validated. */
  error: string | null;
}

export function loadConfig(projectRoot: string): LoadedConfig {
  const file = configPath(projectRoot);
  if (!fs.existsSync(file)) {
    return { config: LocalhostFixConfigSchema.parse({}), source: null, error: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { config: LocalhostFixConfigSchema.parse(raw), source: file, error: null };
  } catch (err) {
    return {
      config: LocalhostFixConfigSchema.parse({}),
      source: file,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function saveConfig(projectRoot: string, config: LocalhostFixConfig): string {
  const dir = localhostfixDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(projectRoot);
  const { $schema: _ignored, ...rest } = config;
  const body = { $schema: 'https://localhostfix.dev/schema/config-v1.json', ...rest };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}
