import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { runInspection } from '../../src/inspect/run.js';
import { InspectionReportSchema } from '../../src/artifacts/report-schema.js';
import { HEALTHY_HANDLER, makeFixture, serverSource, type Fixture } from '../fixtures/servers.js';

const TIMEOUT = 120_000;
const fixtures: Fixture[] = [];
function fixture(name: string, source: string): string {
  const f = makeFixture(name, source);
  fixtures.push(f);
  return f.dir;
}
afterAll(() => {
  for (const f of fixtures) f.cleanup();
});

const CLI = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'dist', 'cli', 'main.js');

/** Run the built CLI in a fresh process and parse its JSON report. */
function runCliJson(cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, 'inspect', '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, ...env },
  });
  if (!result.stdout) {
    throw new Error(`CLI produced no JSON. stderr: ${result.stderr?.slice(0, 500)}`);
  }
  return JSON.parse(result.stdout);
}

describe('report.json contract', () => {
  test(
    'a healthy run validates against the published schema',
    async () => {
      const dir = fixture('schema-ok', serverSource(HEALTHY_HANDLER));
      const { runDir } = await runInspection({ cwd: dir });
      const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));

      const parsed = InspectionReportSchema.safeParse(raw);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'an early failure still writes a schema-valid report',
    async () => {
      // No package.json anywhere: fails at the very first layer.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhostfix-empty-'));
      try {
        const { runDir } = await runInspection({ cwd: dir });
        const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
        const parsed = InspectionReportSchema.safeParse(raw);
        expect(parsed.success).toBe(true);
        expect(raw.verdict).toBe('PROJECT_NOT_RECOGNIZED');
        expect(raw.recommendation.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    'the markdown report names the verdict, the layers, and a next action',
    async () => {
      const dir = fixture('schema-md', serverSource(HEALTHY_HANDLER));
      const { runDir } = await runInspection({ cwd: dir });
      const md = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');

      expect(md).toMatch(/# LocalhostFix Frontend Inspection/);
      expect(md).toMatch(/Result: \*\*HEALTHY_RENDER\*\*/);
      expect(md).toMatch(/## Layers/);
      expect(md).toMatch(/## Recommended next action/);
      expect(md).toMatch(/desktop\.png/);
      // Must not overstate what a successful render proves.
      expect(md).toMatch(/not automatically a correct page/);
    },
    TIMEOUT,
  );
});

describe('port ownership', () => {
  test(
    'a dev server advertising a port owned by someone else is a conflict, not a healthy render',
    async () => {
      // A foreign server occupies a port; the fixture dev server advertises
      // that port in its logs while actually listening elsewhere. Trusting
      // the advertised URL would inspect the wrong application entirely.
      const foreign = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h1>A completely different application</h1></body></html>');
      });
      await new Promise<void>((resolve) => foreign.listen(0, resolve));
      const foreignPort = (foreign.address() as { port: number }).port;

      try {
        const dir = fixture(
          'conflict',
          serverSource(HEALTHY_HANDLER, {
            announce: `\`  ➜  Local:   http://localhost:${foreignPort}/\``,
          }),
        );
        fs.mkdirSync(path.join(dir, '.localhostfix'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, '.localhostfix', 'config.json'),
          JSON.stringify({ startupTimeoutMs: 6000 }),
        );

        const { report } = await runInspection({ cwd: dir });

        expect(report.verdict).toBe('SERVER_PORT_CONFLICT');
        expect(report.domain).toBe('setup');
        expect(report.evidence.some((e) => e.kind === 'foreign-port-owner')).toBe(true);
        // It must refuse to kill the foreign process.
        expect(report.recommendation).toMatch(/will not terminate a process it did not start/i);
      } finally {
        await new Promise<void>((resolve) => foreign.close(() => resolve()));
      }
    },
    TIMEOUT,
  );
});

describe('browser layer', () => {
  test(
    'a missing Chromium build is reported as a setup problem with the install command',
    async () => {
      // Playwright resolves its browser cache location at import time, so the
      // only faithful simulation is a fresh process pointed at an empty cache.
      const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'localhostfix-nobrowser-'));
      try {
        const dir = fixture('nobrowser', serverSource(HEALTHY_HANDLER));
        const report = runCliJson(dir, { PLAYWRIGHT_BROWSERS_PATH: emptyCache });

        expect(report.verdict).toBe('BROWSER_NOT_INSTALLED');
        expect(report.domain).toBe('setup');
        expect(report.exitCode).toBe(2);
        // The server layer was fine — the report must say so rather than
        // blaming the application.
        expect(report.server.reachable).toBe(true);
        expect(report.browser.launched).toBe(false);
        expect(report.recommendation).toMatch(/playwright install chromium/);
      } finally {
        fs.rmSync(emptyCache, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
