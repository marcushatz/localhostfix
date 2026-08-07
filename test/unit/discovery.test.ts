import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  detectPackageManager,
  findProjectRoot,
  runScriptCommand,
} from '../../src/project/discover.js';
import { detectDevScript, detectFramework, genericAdapter, nextAdapter, viteAdapter } from '../../src/frameworks/adapter.js';
import { extractUrlFromLog, normalizeLocalUrl } from '../../src/server/lifecycle.js';
import { isFrontendFile } from '../../src/commands/watch.js';

const dirs: string[] = [];
function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhostfix-disc-'));
  dirs.push(dir);
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

describe('project discovery', () => {
  test('finds the nearest package.json walking upward', () => {
    const dir = tmpProject({ 'package.json': '{"name":"x"}', 'src/deep/nested.txt': 'x' });
    const info = findProjectRoot(path.join(dir, 'src', 'deep'));
    expect(fs.realpathSync(info.root)).toBe(fs.realpathSync(dir));
    expect(info.packageJson?.name).toBe('x');
  });

  test('tolerates malformed package.json without throwing', () => {
    const dir = tmpProject({ 'package.json': '{not json' });
    const info = findProjectRoot(dir);
    expect(info.packageJson).toBeNull();
  });
});

describe('package manager detection', () => {
  test.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
  ])('%s implies %s', (lockfile, expected) => {
    const dir = tmpProject({ 'package.json': '{}', [lockfile]: '' });
    expect(detectPackageManager(dir, {})).toBe(expected);
  });

  test('defaults to npm and honours the packageManager field', () => {
    const dir = tmpProject({ 'package.json': '{}' });
    expect(detectPackageManager(dir, {})).toBe('npm');
    expect(detectPackageManager(dir, { packageManager: 'pnpm@10.0.0' })).toBe('pnpm');
  });

  test('builds the right run command per manager', () => {
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev');
    expect(runScriptCommand('pnpm', 'dev')).toBe('pnpm dev');
    expect(runScriptCommand('yarn', 'dev')).toBe('yarn dev');
    expect(runScriptCommand('bun', 'dev')).toBe('bun run dev');
  });
});

describe('framework detection', () => {
  test('next and vite are detected from dependencies', () => {
    expect(detectFramework({ dependencies: { next: '15.0.0' } }, '/tmp').id).toBe('next');
    expect(detectFramework({ devDependencies: { vite: '7.0.0' } }, '/tmp').id).toBe('vite');
  });

  test('unknown projects fall back to the generic adapter', () => {
    expect(detectFramework({ dependencies: { express: '5' } }, '/tmp').id).toBe('generic');
    expect(detectFramework(null, '/tmp').id).toBe('generic');
  });

  test('dev script selection follows adapter preference order', () => {
    expect(detectDevScript({ scripts: { dev: 'next dev' } }, nextAdapter)?.script).toBe('dev');
    expect(detectDevScript({ scripts: { start: 'vite' } }, viteAdapter)?.script).toBe('start');
    expect(detectDevScript({ scripts: { build: 'tsc' } }, genericAdapter)).toBeNull();
  });
});

describe('URL discovery from dev-server logs', () => {
  test('parses the Vite banner', () => {
    const log = '  VITE v7.0.0  ready in 120 ms\n\n  ➜  Local:   http://localhost:5173/\n';
    expect(extractUrlFromLog(log, viteAdapter)).toBe('http://localhost:5173');
  });

  test('parses the Next.js banner', () => {
    const log = '   ▲ Next.js 15.0.0\n   - Local:        http://localhost:3210\n';
    expect(extractUrlFromLog(log, nextAdapter)).toBe('http://localhost:3210');
  });

  test('finds a bare URL in arbitrary output', () => {
    expect(extractUrlFromLog('server up at http://127.0.0.1:8080 now', genericAdapter)).toBe(
      'http://127.0.0.1:8080',
    );
  });

  test('returns null when no URL is present', () => {
    expect(extractUrlFromLog('compiling...\ndone', genericAdapter)).toBeNull();
  });

  test('normalizes wildcard hosts to localhost', () => {
    expect(normalizeLocalUrl('http://0.0.0.0:3000/')).toBe('http://localhost:3000');
  });
});

describe('frontend file classification', () => {
  test('recognises frontend sources and styles', () => {
    expect(isFrontendFile('src/components/Hero.tsx')).toBe(true);
    expect(isFrontendFile('app/globals.css')).toBe(true);
    expect(isFrontendFile('pages/index.vue')).toBe(true);
  });

  test('ignores non-frontend and generated paths', () => {
    expect(isFrontendFile('README.md')).toBe(false);
    expect(isFrontendFile('server/db.sql')).toBe(false);
    expect(isFrontendFile(path.join('node_modules', 'react', 'index.js'))).toBe(false);
    expect(isFrontendFile(path.join('.next', 'static', 'chunk.js'))).toBe(false);
    expect(isFrontendFile(path.join('.localhostfix', 'runs', 'x.js'))).toBe(false);
  });
});
