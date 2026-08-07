import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runInspection } from '../../src/inspect/run.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { discoverServers } from '../../src/server/discovery.js';
import { nextAdapter, genericAdapter } from '../../src/frameworks/adapter.js';

/**
 * Regression suite for the dogfood finding that motivated this tool:
 *
 *   A healthy page answering on localhost is NOT evidence that it belongs to
 *   the project being worked on. LocalhostFix once reported HEALTHY_RENDER for a
 *   completely different application that happened to own port 3000.
 *
 * Servers here are spawned as real child processes with an explicit `cwd`, so
 * directory attribution is genuine rather than simulated. These tests must
 * never be weakened.
 */

const TIMEOUT = 120_000;
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SERVER_SOURCE = (title: string) => `import http from 'node:http';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>${title}</title></head><body>' +
    '<div id="root"><h1>${title}</h1><p>This page has enough visible text and controls that the blank heuristic is satisfied comfortably.</p><button>Act</button><a href="/x">Link</a></div>' +
    '</body></html>');
});
server.listen(Number(process.env.PORT ?? 0), () => {
  console.log('LISTENING ' + server.address().port);
});
`;

/**
 * Spawn a server as a child process whose working directory is `cwd` and
 * whose command line contains `scriptName` — the two signals LocalhostFix uses
 * to attribute a listener to a project.
 */
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

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server ${scriptName} never listened`)), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/LISTENING (\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
  return port;
}

/** A healthy server belonging to some OTHER directory entirely. */
async function startForeignServer(): Promise<{ port: number; cwd: string }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'localhostfix-otherproject-'));
  cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const port = await spawnServer(cwd, 'other-app-server.mjs', 'A Completely Different Product');
  return { port, cwd };
}

function makeProject(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhostfix-project-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'my-project', private: true, dependencies: { next: '16.0.0' } }),
  );
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const findings = (doctor: { sections: { findings: { level: string; text: string }[] }[] }) =>
  doctor.sections.flatMap((s) => s.findings.map((f) => `${f.level}:${f.text}`)).join('\n');

describe('a healthy page on the configured port owned by another project', () => {
  test(
    'discovery refuses to select it',
    async () => {
      const foreign = await startForeignServer();
      const project = makeProject();

      const result = await discoverServers({
        projectRoot: project,
        adapter: nextAdapter,
        configuredPort: foreign.port,
      });

      expect(result.selected).toBeNull();
      expect(result.foreignServers.map((f) => f.port)).toContain(foreign.port);
      expect(result.projectServers).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    'doctor names the offending project and does not report health',
    async () => {
      const foreign = await startForeignServer();
      const project = makeProject({
        '.localhostfix/config.json': JSON.stringify({ expectedPort: foreign.port }),
      });

      const doctor = await runDoctor({ cwd: project, fix: false, startServer: false });
      const flat = findings(doctor);

      expect(flat).toMatch(/belongs to a different project/i);
      expect(flat).toContain(foreign.cwd);
      expect(doctor.exitCode).not.toBe(0);
      expect(doctor.recommendations.join(' ')).toMatch(/wrong application|another project/i);
      // It must never present that foreign server as this project's own.
      expect(flat).not.toMatch(/Current project is listening on[\s\S]*?belongs to a different/);
    },
    TIMEOUT,
  );

  test(
    'inspect never returns HEALTHY_RENDER for the foreign app',
    async () => {
      const foreign = await startForeignServer();
      // No dev command: the only route to "success" would be wrongly
      // accepting the foreign server.
      const project = makeProject({
        '.localhostfix/config.json': JSON.stringify({
          expectedPort: foreign.port,
          startupTimeoutMs: 3000,
        }),
      });
      fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'my-project', private: true, dependencies: { next: '16.0.0' }, scripts: {} }),
      );

      const { report } = await runInspection({ cwd: project });

      expect(report.verdict).not.toBe('HEALTHY_RENDER');
      expect(report.exitCode).not.toBe(0);
      expect(report.render.visibleElementCount).toBeNull();
    },
    TIMEOUT,
  );
});

describe("the project's own server on a non-standard port", () => {
  test(
    'is found by directory attribution even though the configured port is different',
    async () => {
      const project = makeProject();
      const realPort = await spawnServer(project, 'next-server.mjs', 'The Real App');

      const result = await discoverServers({
        projectRoot: project,
        adapter: nextAdapter,
        configuredPort: 3000, // deliberately wrong
      });

      expect(result.selected?.port).toBe(realPort);
      expect(result.selected?.relation).toBe('inside');
      expect(result.projectServers.map((s) => s.port)).toContain(realPort);
    },
    TIMEOUT,
  );

  test(
    'inspect renders the project server rather than the configured port',
    async () => {
      const foreign = await startForeignServer();
      const project = makeProject({
        '.localhostfix/config.json': JSON.stringify({ expectedPort: foreign.port }),
      });
      const realPort = await spawnServer(project, 'next-server.mjs', 'The Real App');

      const { report } = await runInspection({ cwd: project });

      expect(report.verdict).toBe('HEALTHY_RENDER');
      expect(report.url).toContain(`:${realPort}`);
      expect(report.render.title).toBe('The Real App');
      // The foreign server was seen and deliberately not used.
      expect(report.server.skippedForeign.map((f) => f.url).join(' ')).toContain(`${foreign.port}`);
    },
    TIMEOUT,
  );
});

describe('several servers inside one project', () => {
  test(
    'the framework dev server wins over a stale static server',
    async () => {
      // Exactly the dogfooded situation: a leftover static server and the
      // real Next.js dev server, both running in the project directory.
      const project = makeProject();
      const stalePort = await spawnServer(project, 'static-file-server.mjs', 'Stale Static Build');
      const devPort = await spawnServer(project, 'next-server.mjs', 'The Real App');

      const result = await discoverServers({ projectRoot: project, adapter: nextAdapter });

      expect(result.projectServers.map((s) => s.port).sort()).toEqual([stalePort, devPort].sort());
      expect(result.selected?.port).toBe(devPort);
      expect(result.selectionReason).toBe('matches-framework-dev-command');
      expect(result.ambiguous).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'indistinguishable servers are reported as ambiguous rather than guessed',
    async () => {
      // Under the generic adapter both are plain `node` processes, so there
      // is no principled way to choose. LocalhostFix must say so.
      const project = makeProject();
      fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'my-project', private: true, scripts: { dev: 'node a.mjs' } }),
      );
      const portA = await spawnServer(project, 'server-a.mjs', 'App A');
      const portB = await spawnServer(project, 'server-b.mjs', 'App B');

      const result = await discoverServers({ projectRoot: project, adapter: genericAdapter });

      expect(result.projectServers.map((s) => s.port).sort()).toEqual([portA, portB].sort());
      expect(result.ambiguous).toBe(true);
      expect(result.selected).toBeNull();
      expect(result.preferred).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    'inspect surfaces the ambiguity and tells the user how to resolve it',
    async () => {
      const project = makeProject();
      fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'my-project', private: true, scripts: { dev: 'node server-a.mjs' } }),
      );
      await spawnServer(project, 'server-a.mjs', 'App A');
      await spawnServer(project, 'server-b.mjs', 'App B');

      const { report } = await runInspection({ cwd: project });

      expect(report.verdict).toBe('MULTIPLE_PROJECT_SERVERS');
      expect(report.domain).toBe('setup');
      expect(report.recommendation).toMatch(/--url/);
      expect(report.evidence.some((e) => e.kind === 'candidate')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'an explicit --url resolves the ambiguity',
    async () => {
      const project = makeProject();
      fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'my-project', private: true, scripts: { dev: 'node server-a.mjs' } }),
      );
      const portA = await spawnServer(project, 'server-a.mjs', 'App A');
      await spawnServer(project, 'server-b.mjs', 'App B');

      const { report } = await runInspection({
        cwd: project,
        urlOverride: `http://localhost:${portA}`,
      });

      expect(report.verdict).toBe('HEALTHY_RENDER');
      expect(report.render.title).toBe('App A');
    },
    TIMEOUT,
  );
});

describe('a system daemon whose working directory is /', () => {
  test('is never attributed to the project', async () => {
    // Guards the AirPlay-on-port-7000 regression: cwd "/" contains every
    // project on the machine and must not count as a match.
    const project = makeProject();
    const result = await discoverServers({ projectRoot: project, adapter: nextAdapter });
    expect(result.projectServers.every((s) => s.cwd !== '/')).toBe(true);
    expect(result.selected?.cwd).not.toBe('/');
  }, TIMEOUT);
});
