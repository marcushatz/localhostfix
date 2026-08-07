import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { runInspection } from '../../src/inspect/run.js';
import {
  API_500_HANDLER,
  AUTH_HANDLER,
  BLANK_HANDLER,
  CRASH_HANDLER,
  EXIT_SOURCE,
  HANG_SOURCE,
  HEALTHY_HANDLER,
  makeFixture,
  serverSource,
  type Fixture,
} from '../fixtures/servers.js';

// Real servers + real Chromium. Cold CI browser/dev-server startup budget;
// see vitest.config.ts.
const TIMEOUT = 240_000;

const fixtures: Fixture[] = [];
function fixture(name: string, source: string, extra?: { scripts?: Record<string, string> }): string {
  const f = makeFixture(name, source, extra);
  fixtures.push(f);
  return f.dir;
}
afterAll(() => {
  for (const f of fixtures) f.cleanup();
});

/** Bind to port 0, read the assigned port, release it. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

describe('inspection pipeline', () => {
  test(
    'a healthy page is classified HEALTHY_RENDER with both screenshots',
    async () => {
      const dir = fixture('healthy', serverSource(HEALTHY_HANDLER));
      const { report, runDir } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('HEALTHY_RENDER');
      expect(report.domain).toBe('healthy');
      expect(report.exitCode).toBe(0);
      expect(report.server.reachable).toBe(true);
      expect(report.browser.launched).toBe(true);
      expect(report.navigation.status).toBe(200);

      // Screenshots must exist and be real images, not empty files.
      const desktop = path.join(runDir, 'desktop.png');
      const mobile = path.join(runDir, 'mobile.png');
      expect(fs.existsSync(desktop)).toBe(true);
      expect(fs.existsSync(mobile)).toBe(true);
      expect(fs.statSync(desktop).size).toBeGreaterThan(1000);
      expect(fs.statSync(mobile).size).toBeGreaterThan(1000);
      expect(fs.readFileSync(desktop).subarray(1, 4).toString()).toBe('PNG');

      // Reports in both formats, and the latest pointer refreshed.
      expect(fs.existsSync(path.join(runDir, 'report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.localhostfix', 'latest', 'report.json'))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'a runtime crash is an application failure, never a healthy render',
    async () => {
      const dir = fixture('crash', serverSource(CRASH_HANDLER));
      const { report, runDir } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('APPLICATION_RUNTIME_FAILURE');
      expect(report.domain).toBe('application');
      expect(report.exitCode).toBe(1);
      expect(report.counts.pageErrors).toBeGreaterThan(0);
      expect(report.evidence.some((e) => /userProfile is not defined/.test(e.detail))).toBe(true);

      const pageErrors = JSON.parse(fs.readFileSync(path.join(runDir, 'page-errors.json'), 'utf8'));
      expect(pageErrors[0].message).toMatch(/userProfile is not defined/);
    },
    TIMEOUT,
  );

  test(
    'an empty app root is identified as a likely blank render',
    async () => {
      const dir = fixture('blank', serverSource(BLANK_HANDLER));
      const { report } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('LIKELY_BLANK_RENDER');
      expect(report.render.blank?.likelyBlank).toBe(true);
      expect(report.render.blank?.reasons.length).toBeGreaterThan(0);
      expect(report.exitCode).toBe(1);
    },
    TIMEOUT,
  );

  test(
    'a failing critical API is reported as a dependency failure with secrets redacted',
    async () => {
      const dir = fixture('api500', serverSource(API_500_HANDLER));
      const { report, runDir } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('FAILED_DEPENDENCY_REQUEST');
      expect(report.domain).toBe('application');
      expect(report.evidence.some((e) => e.kind === 'http-500')).toBe(true);

      const networkRaw = fs.readFileSync(path.join(runDir, 'network.json'), 'utf8');
      expect(networkRaw).toContain('/api/profile');
      expect(networkRaw).not.toContain('supersecret123');
      expect(networkRaw).toContain('REDACTED');
    },
    TIMEOUT,
  );

  test(
    'a missing route is reported as ROUTE_NOT_FOUND rather than a render problem',
    async () => {
      const dir = fixture('route404', serverSource(HEALTHY_HANDLER));
      const { report } = await runInspection({ cwd: dir, route: '/missing' });

      expect(report.verdict).toBe('ROUTE_NOT_FOUND');
      expect(report.navigation.status).toBe(404);
    },
    TIMEOUT,
  );

  test(
    'an auth redirect is reported as a gate, not bypassed',
    async () => {
      const dir = fixture('auth', serverSource(AUTH_HANDLER));
      const { report } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('AUTHENTICATION_GATE');
      expect(report.navigation.redirected).toBe(true);
      expect(report.recommendation).toMatch(/will not bypass auth/i);
    },
    TIMEOUT,
  );
});

describe('server-layer failures', () => {
  test(
    'a dev server that exits is SERVER_START_FAILED, and the log is kept',
    async () => {
      const dir = fixture('exits', EXIT_SOURCE);
      const { report, runDir } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('SERVER_START_FAILED');
      expect(report.domain).toBe('setup');
      expect(report.exitCode).toBe(2);
      expect(report.browser.launched).toBe(false); // never got that far
      const log = fs.readFileSync(path.join(runDir, 'server.log'), 'utf8');
      expect(log).toMatch(/Cannot find module/);
    },
    TIMEOUT,
  );

  test(
    'a server that never listens times out instead of hanging forever',
    async () => {
      const dir = fixture('hangs', HANG_SOURCE);
      // Write a short timeout so the test does not wait the 60s default.
      fs.mkdirSync(path.join(dir, '.localhostfix'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.localhostfix', 'config.json'),
        JSON.stringify({ startupTimeoutMs: 4000 }),
      );
      const { report } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('SERVER_START_TIMEOUT');
      expect(report.domain).toBe('setup');
    },
    TIMEOUT,
  );

  test(
    'a project with no dev script reports DEV_COMMAND_NOT_FOUND',
    async () => {
      const dir = fixture('noscript', 'console.log("unused")', { scripts: { build: 'tsc' } });
      const { report } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('DEV_COMMAND_NOT_FOUND');
      expect(report.exitCode).toBe(2);
      expect(report.recommendation).toMatch(/dev script|devCommand/i);
    },
    TIMEOUT,
  );

  test(
    'a wrong configured port still succeeds via URL discovery and flags the mismatch',
    async () => {
      const dir = fixture('portmismatch', serverSource(HEALTHY_HANDLER));
      // Must be a port nothing is listening on: a configured port that IS
      // reachable would be reused on purpose, which is different behaviour.
      const freePort = await findFreePort();
      fs.mkdirSync(path.join(dir, '.localhostfix'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.localhostfix', 'config.json'),
        JSON.stringify({ expectedPort: freePort, startupTimeoutMs: 30000 }),
      );
      const { report } = await runInspection({ cwd: dir });

      expect(report.verdict).toBe('HEALTHY_RENDER');
      expect(report.server.portMismatch).toBe(true);
      expect(report.server.expectedPort).toBe(freePort);
      expect(report.server.actualUrl).not.toContain(`:${freePort}`);
      // The URL that actually worked came from the server's own output.
      expect(report.server.actualUrl).toMatch(/^http:\/\/localhost:\d+$/);
    },
    TIMEOUT,
  );

  test(
    'remote URLs are refused without an explicit override',
    async () => {
      const dir = fixture('remote', serverSource(HEALTHY_HANDLER));
      const { report } = await runInspection({ cwd: dir, urlOverride: 'https://example.com' });

      expect(report.evidence.some((e) => e.kind === 'remote-url-blocked')).toBe(true);
      expect(report.recommendation).toMatch(/localhost only/i);
    },
    TIMEOUT,
  );
});

describe('process hygiene', () => {
  test(
    'servers LocalhostFix starts are stopped, and its own port is freed',
    async () => {
      const dir = fixture('cleanup', serverSource(HEALTHY_HANDLER));
      const { report } = await runInspection({ cwd: dir });
      expect(report.server.startedByLocalhostFix).toBe(true);

      const url = report.server.actualUrl!;
      // Poll rather than sleeping a fixed interval: SIGTERM to actual exit
      // takes longer on a loaded machine or a CI runner, and a single check
      // after a fixed delay made this test flaky.
      const freedWithin = async (deadlineMs: number): Promise<boolean> => {
        const deadline = Date.now() + deadlineMs;
        for (;;) {
          const reachable = await fetch(url, { signal: AbortSignal.timeout(1000) })
            .then(() => true)
            .catch(() => false);
          if (!reachable) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      expect(await freedWithin(15_000)).toBe(true);
    },
    TIMEOUT,
  );
});
