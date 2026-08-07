import fs from 'node:fs';
import path from 'node:path';

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

export interface ProjectInfo {
  root: string;
  packageJson: PackageJson | null;
  packageJsonPath: string | null;
}

/**
 * Walk upward from `startDir` to find the nearest directory containing
 * package.json (or .agentview/config.json for pre-configured projects).
 */
export function findProjectRoot(startDir: string): ProjectInfo {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return { root: dir, ...readPackageJson(pkgPath) };
    }
    if (fs.existsSync(path.join(dir, '.agentview', 'config.json'))) {
      return { root: dir, packageJson: null, packageJsonPath: null };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { root: path.resolve(startDir), packageJson: null, packageJsonPath: null };
    }
    dir = parent;
  }
}

function readPackageJson(pkgPath: string): Pick<ProjectInfo, 'packageJson' | 'packageJsonPath'> {
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
    return { packageJson: parsed, packageJsonPath: pkgPath };
  } catch {
    return { packageJson: null, packageJsonPath: pkgPath };
  }
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPackageManager(root: string, pkg: PackageJson | null): PackageManager {
  if (pkg?.packageManager) {
    const name = pkg.packageManager.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb')))
    return 'bun';
  return 'npm';
}

export function runScriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'npm':
      return `npm run ${script}`;
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
  }
}
