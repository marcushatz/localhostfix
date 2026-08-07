import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runFix } from '../../src/fixes/engine.js';
import { loadConfig } from '../../src/config/config.js';
import {
  BLANK_HANDLER,
  CRASH_HANDLER,
  HEALTHY_HANDLER,
  makeFixture,
  serverSource,
  type Fixture,
} from '../fixtures/servers.js';

/**
 * `agentview fix` must repair only what it owns, never touch application
 * source, and never claim success without a verifying inspection.
 */

const TIMEOUT = 180_000;
const cleanups: (() => void | Promise<void>)[] = [];
const fixtures: Fixture[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (fixtures.length) fixtures.pop()!.cleanup();
});

function fixture(name: string, source: string, config?: Record<string, unknown>): string {
  const f = makeFixture(name, source);
  fixtures.push(f);
  if (config) {
    fs.mkdirSync(path.join(f.dir, '.agentview'), { recursive: true });
    fs.writeFileSync(path.join(f.dir, '.agentview', 'config.json'), JSON.stringify(config));
  }
  return f.dir;
}

const SERVER_SOURCE = (title: string) => `import http from 'node:http';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>${title}</title></head><body>' +
    '<div id="root"><h1>${title}</h1><p>Plenty of visible text so the blank heuristic is satisfied without argument.</p><button>Act</button><a href="/x">Link</a></div>' +
    '</body></html>');
});
server.listen(0, () => console.log('LISTENING ' + server.address().port));
`;

/** Spawn a server with a real working directory and command-line signature. */
async function spawnServer(cwd: string, scriptName: string, title: string): Promise<number> {
  const script = path.join(cwd, scriptName);
  fs.writeFileSync(script, SERVER_SOURCE(title));
  const child: ChildProcess = spawn(process.execPath, [script], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  });
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never listened')), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/LISTENING (\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}`));
    });
  });
}

function freePort(): Promise<number> {
  return import('node:net').then(
    (net) =>
      new Promise<number>((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, () => {
          const addr = s.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          s.close(() => (port ? resolve(port) : reject(new Error('no port'))));
        });
      }),
  );
}

describe('fix repairs what AgentView owns', () => {
  test(
    'a wrong configured port is corrected and the result is verified',
    async () => {
      const wrongPort = await freePort();
      const dir = fixture('fix-port', serverSource(HEALTHY_HANDLER), {
        expectedPort: wrongPort,
        startupTimeoutMs: 30_000,
      });

      const result = await runFix({ cwd: dir });

      expect(result.outcome).toBe('ALREADY_HEALTHY');
      expect(result.fixesApplied.map((f) => f.id)).toContain('stored-port');
      // The correction is persisted, not just reported.
      const stored = loadConfig(dir).config.expectedPort;
      expect(stored).not.toBe(wrongPort);
      expect(result.finalReport.server.actualUrl).toContain(`:${stored}`);
      expect(result.exitCode).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'a dev server that was not running is started, and rendering is confirmed',
    async () => {
      const dir = fixture('fix-start', serverSource(HEALTHY_HANDLER));

      const result = await runFix({ cwd: dir });

      expect(result.outcome).toBe('ALREADY_HEALTHY');
      expect(result.finalReport.verdict).toBe('HEALTHY_RENDER');
      expect(result.finalReport.server.startedByAgentView).toBe(true);
      expect(result.finalReport.render.visibleElementCount).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    'a stale inspection lock is cleared',
    async () => {
      const dir = fixture('fix-lock', serverSource(HEALTHY_HANDLER));
      const stateDir = path.join(dir, '.agentview', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      const lock = path.join(stateDir, 'inspect.lock');
      fs.writeFileSync(lock, '999999');
      // Backdate it well beyond the staleness threshold.
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);

      const result = await runFix({ cwd: dir });

      expect(result.fixesApplied.map((f) => f.id)).toContain('stale-lock');
      expect(fs.existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'a corrupt AgentView config is backed up and regenerated',
    async () => {
      const dir = fixture('fix-config', serverSource(HEALTHY_HANDLER));
      fs.mkdirSync(path.join(dir, '.agentview'), { recursive: true });
      const configFile = path.join(dir, '.agentview', 'config.json');
      fs.writeFileSync(configFile, '{ this is not json');

      const result = await runFix({ cwd: dir });

      const applied = result.fixesApplied.find((f) => f.id === 'invalid-config');
      expect(applied?.succeeded).toBe(true);
      // The broken file is preserved rather than destroyed.
      const backups = fs.readdirSync(path.join(dir, '.agentview')).filter((f) => f.includes('.invalid-'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, '.agentview', backups[0]!), 'utf8')).toBe('{ this is not json');
      expect(() => JSON.parse(fs.readFileSync(configFile, 'utf8'))).not.toThrow();
      expect(applied?.undo).toMatch(/restore/i);
    },
    TIMEOUT,
  );

  test(
    'running fix twice changes nothing the second time',
    async () => {
      const wrongPort = await freePort();
      const dir = fixture('fix-idempotent', serverSource(HEALTHY_HANDLER), {
        expectedPort: wrongPort,
        startupTimeoutMs: 30_000,
      });

      const first = await runFix({ cwd: dir });
      expect(first.fixesApplied.length).toBeGreaterThan(0);

      const configAfterFirst = fs.readFileSync(path.join(dir, '.agentview', 'config.json'), 'utf8');
      const second = await runFix({ cwd: dir });

      // A second run may still correct the port, because a fixture server
      // binds a fresh random port each start — what must not happen is a
      // different KIND of repair appearing, or the outcome degrading.
      expect(second.outcome).toBe('ALREADY_HEALTHY');
      expect(second.fixesApplied.every((f) => f.id === 'stored-port')).toBe(true);
      expect(JSON.parse(configAfterFirst)).toHaveProperty('expectedPort');
    },
    TIMEOUT,
  );
});

describe('fix never touches the application', () => {
  test(
    'a runtime crash yields APPLICATION_FIX_REQUIRED with no source modified',
    async () => {
      const dir = fixture('fix-crash', serverSource(CRASH_HANDLER));
      const sources = ['server.mjs', 'package.json'];
      const before = sources.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));

      const result = await runFix({ cwd: dir });

      expect(result.outcome).toBe('APPLICATION_FIX_REQUIRED');
      expect(result.exitCode).toBe(1);
      expect(result.finalReport.verdict).toBe('APPLICATION_RUNTIME_FAILURE');
      // The evidence Claude needs in order to repair it.
      expect(result.finalReport.evidence.some((e) => /userProfile is not defined/.test(e.detail))).toBe(
        true,
      );
      // Not one byte of the project changed.
      sources.forEach((f, i) => {
        expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(before[i]);
      });
    },
    TIMEOUT,
  );

  test(
    'a blank render is reported as an application problem, not repaired',
    async () => {
      const dir = fixture('fix-blank', serverSource(BLANK_HANDLER));
      const before = fs.readFileSync(path.join(dir, 'server.mjs'), 'utf8');

      const result = await runFix({ cwd: dir });

      expect(result.outcome).toBe('APPLICATION_FIX_REQUIRED');
      expect(result.finalReport.verdict).toBe('LIKELY_BLANK_RENDER');
      expect(fs.readFileSync(path.join(dir, 'server.mjs'), 'utf8')).toBe(before);
      expect(result.fixesApplied.filter((f) => f.succeeded)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('fix refuses to act where it cannot be confident', () => {
  test(
    'a missing browser is never installed silently',
    async () => {
      const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-nobrowser-'));
      cleanups.push(() => fs.rmSync(emptyCache, { recursive: true, force: true }));
      const dir = fixture('fix-nobrowser', serverSource(HEALTHY_HANDLER));

      // A fresh process is the only faithful simulation: Playwright resolves
      // its browser cache at import time.
      const { spawnSync } = await import('node:child_process');
      const CLI = path.join(process.cwd(), 'dist', 'cli', 'main.js');
      const run = spawnSync(process.execPath, [CLI, 'fix', '--json'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: emptyCache },
      });
      const result = JSON.parse(run.stdout);

      expect(result.outcome).toBe('COULD_NOT_REPAIR');
      expect(result.requiresApproval.command).toMatch(/playwright install chromium/);
      expect(result.blockedBy).toMatch(/requires user approval/i);
      // Nothing was downloaded into the cache we pointed it at.
      expect(fs.readdirSync(emptyCache).filter((f) => f.startsWith('chromium'))).toEqual([]);
      expect(run.status).toBe(2);
    },
    TIMEOUT,
  );

  test(
    'ambiguous project servers are never guessed between',
    async () => {
      const dir = fixture('fix-ambiguous', serverSource(HEALTHY_HANDLER));
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'ambiguous', private: true, scripts: { dev: 'node server-a.mjs' } }),
      );
      await spawnServer(dir, 'server-a.mjs', 'App A');
      await spawnServer(dir, 'server-b.mjs', 'App B');

      const result = await runFix({ cwd: dir });

      expect(result.outcome).toBe('COULD_NOT_REPAIR');
      expect(result.initialVerdict).toBe('MULTIPLE_PROJECT_SERVERS');
      expect(result.blockedBy).toMatch(/will not guess/i);
      expect(result.blockedBy).toMatch(/--url/);
      expect(result.fixesApplied.filter((f) => f.succeeded)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'the localhost guard is still enforced and is not "fixed" away',
    async () => {
      const dir = fixture('fix-remote', serverSource(HEALTHY_HANDLER), {
        url: 'http://203.0.113.10:8080', // TEST-NET-3: unroutable by definition
        allowRemote: false,
      });

      const result = await runFix({ cwd: dir });

      expect(result.outcome).toBe('COULD_NOT_REPAIR');
      expect(result.blockedBy).toMatch(/not localhost/i);
      expect(result.blockedBy).toMatch(/will not disable that protection/i);
      // The guard must not have been switched off to make the run pass.
      expect(loadConfig(dir).config.allowRemote).toBe(false);
      expect(loadConfig(dir).config.url).toBe('http://203.0.113.10:8080');
    },
    TIMEOUT,
  );

  test(
    'a server owned by another process is never terminated',
    async () => {
      // A neighbour's server occupies the configured port. Killing it would
      // be the "easy fix" and is exactly what AgentView must not do.
      const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-neighbour-'));
      cleanups.push(() => fs.rmSync(foreignDir, { recursive: true, force: true }));
      const foreignPort = await spawnServer(foreignDir, 'neighbour.mjs', 'Neighbour App');

      const dir = fixture('fix-noKill', serverSource(HEALTHY_HANDLER), {
        expectedPort: foreignPort,
        startupTimeoutMs: 20_000,
      });

      await runFix({ cwd: dir });

      // The neighbour is still serving after fix ran.
      const stillAlive = await fetch(`http://localhost:${foreignPort}`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      expect(stillAlive).toBe(true);
    },
    TIMEOUT,
  );
});

describe('fix verifies rather than assumes', () => {
  test(
    'a slow dev server has its timeout raised, and the retry is verified',
    async () => {
      // Listens only after a delay that exceeds the initial timeout.
      const SLOW = `import http from 'node:http';
setTimeout(() => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Slow</title></head><body><div id="root"><h1>Slow but fine</h1><p>This server took its time before it began listening on its port.</p><button>Act</button><a href="/x">Link</a></div></body></html>');
  });
  server.listen(0, () => console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));
}, 4000);
`;
      const dir = fixture('fix-slow', SLOW, { startupTimeoutMs: 2000 });

      const result = await runFix({ cwd: dir });

      expect(result.initialVerdict).toBe('SERVER_START_TIMEOUT');
      expect(result.fixesApplied.map((f) => f.id)).toContain('startup-timeout');
      expect(result.verified).toBe(true);
      expect(result.outcome).toBe('FIXED');
      expect(result.finalReport.verdict).toBe('HEALTHY_RENDER');
      // The raised value was persisted.
      expect(loadConfig(dir).config.startupTimeoutMs).toBeGreaterThan(2000);
    },
    TIMEOUT,
  );

  test(
    'FIXED is only reported when a fresh inspection actually rendered the app',
    async () => {
      // A server that starts slowly AND then crashes: the infrastructure fix
      // succeeds, but the app does not render, so this must not be FIXED.
      const SLOW_CRASH = `import http from 'node:http';
setTimeout(() => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Crash</title></head><body><div id="root"></div><script>throw new ReferenceError("userProfile is not defined")</script></body></html>');
  });
  server.listen(0, () => console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));
}, 4000);
`;
      const dir = fixture('fix-slowcrash', SLOW_CRASH, { startupTimeoutMs: 2000 });

      const result = await runFix({ cwd: dir });

      expect(result.initialVerdict).toBe('SERVER_START_TIMEOUT');
      expect(result.fixesApplied.map((f) => f.id)).toContain('startup-timeout');
      // The infrastructure fix worked, but the outcome reflects the app.
      expect(result.outcome).not.toBe('FIXED');
      expect(result.outcome).toBe('APPLICATION_FIX_REQUIRED');
      expect(result.verified).toBe(true);
      expect(result.exitCode).toBe(1);
    },
    TIMEOUT,
  );
});
