/**
 * Fixture dev servers. Each is a tiny standalone Node HTTP server written to
 * a temp directory with a package.json, so the full AgentView pipeline
 * (spawn → discover URL → probe → inspect) runs exactly as it would on a
 * real project. No external network access.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Fixture {
  dir: string;
  cleanup(): void;
}

const PAGE_SHELL = (body: string, head = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title>${head}</head>
<body>${body}</body></html>`;

/** A healthy page with real content and interactive elements. */
export const healthyBody = `
<div id="root">
  <h1>Fixture Application</h1>
  <p>This page renders correctly with a meaningful amount of visible text so
     that the blank-render heuristic does not flag it. It also has controls.</p>
  <nav><a href="/about">About</a> <a href="/contact">Contact</a></nav>
  <button type="button">Primary action</button>
  <ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>
</div>`;

export function makeFixture(name: string, serverSource: string, extra: { scripts?: Record<string, string> } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentview-${name}-`));
  fs.writeFileSync(path.join(dir, 'server.mjs'), serverSource);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: `fixture-${name}`, private: true, scripts: extra.scripts ?? { dev: 'node server.mjs' } },
      null,
      2,
    ),
  );
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Server source builder. `handler` is inlined into the fixture file, so it
 * must be self-contained JS. Port 0 lets the OS pick a free port, which the
 * server then advertises the way a real dev server does — exercising
 * AgentView's URL-from-logs discovery.
 */
export function serverSource(handler: string, opts: { announce?: string } = {}): string {
  return `import http from 'node:http';
const handler = ${handler};
const server = http.createServer(handler);
server.listen(0, () => {
  const port = server.address().port;
  console.log(${opts.announce ?? '`  ➜  Local:   http://localhost:${port}/`'});
});
`;
}

export const HEALTHY_HANDLER = `(req, res) => {
  if (req.url === '/missing') { res.writeHead(404, {'content-type':'text/html'}); res.end('<h1>404</h1>'); return; }
  res.writeHead(200, {'content-type':'text/html'});
  res.end(${JSON.stringify(PAGE_SHELL(healthyBody))});
}`;

/** Renders an empty app root — the classic blank page. */
export const BLANK_HANDLER = `(req, res) => {
  res.writeHead(200, {'content-type':'text/html'});
  res.end(${JSON.stringify(PAGE_SHELL('<div id="root"></div>'))});
}`;

/** Throws during page scripting, leaving the root empty. */
export const CRASH_HANDLER = `(req, res) => {
  res.writeHead(200, {'content-type':'text/html'});
  res.end(${JSON.stringify(
    PAGE_SHELL(
      '<div id="root"></div><script>throw new ReferenceError("userProfile is not defined")</script>',
    ),
  )});
}`;

/** Shell renders fine, but its data request returns 500. */
export const API_500_HANDLER = `(req, res) => {
  if (req.url.startsWith('/api/')) { res.writeHead(500, {'content-type':'application/json'}); res.end('{"error":"boom"}'); return; }
  res.writeHead(200, {'content-type':'text/html'});
  res.end(${JSON.stringify(
    PAGE_SHELL(
      healthyBody + '<script>fetch("/api/profile?token=supersecret123").catch(() => {})</script>',
    ),
  )});
}`;

/** Redirects to a login page dominated by a password form. */
export const AUTH_HANDLER = `(req, res) => {
  if (req.url !== '/login') { res.writeHead(302, {location: '/login'}); res.end(); return; }
  res.writeHead(200, {'content-type':'text/html'});
  res.end(${JSON.stringify(
    PAGE_SHELL(
      '<form><h1>Sign in</h1><input type="email" placeholder="Email"><input type="password" placeholder="Password"><button>Sign in</button></form>',
    ),
  )});
}`;

/** Exits immediately — simulates a dev command that cannot start. */
export const EXIT_SOURCE = `console.error('Error: Cannot find module "./missing-config"');
process.exit(1);
`;

/** Starts but never listens — simulates a hung startup. */
export const HANG_SOURCE = `console.log('starting…');
setInterval(() => {}, 1000);
`;
