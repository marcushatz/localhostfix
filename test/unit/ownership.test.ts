import { describe, expect, test } from 'vitest';
import { classifyCwd } from '../../src/server/ownership.js';
import { rankProjectServers } from '../../src/server/lifecycle.js';
import { genericAdapter, nextAdapter, viteAdapter } from '../../src/frameworks/adapter.js';
import type { ProjectServer } from '../../src/server/ownership.js';

const ROOT = '/Users/dev/projects/app';

describe('classifyCwd', () => {
  test('the same directory is inside', () => {
    expect(classifyCwd(ROOT, ROOT)).toBe('inside');
    expect(classifyCwd(ROOT + '/', ROOT)).toBe('inside');
  });

  test('a subdirectory is inside, which covers monorepo packages', () => {
    expect(classifyCwd(`${ROOT}/apps/web`, ROOT)).toBe('inside');
  });

  test('a parent directory only contains the project — it is not a match', () => {
    // Regression: treating "contains" as a match made every system daemon
    // look like the project's dev server.
    expect(classifyCwd('/', ROOT)).toBe('contains');
    expect(classifyCwd('/Users/dev', ROOT)).toBe('contains');
    expect(classifyCwd('/Users/dev/projects', ROOT)).toBe('contains');
  });

  test('an unrelated project is unrelated', () => {
    expect(classifyCwd('/Users/dev/projects/other-app', ROOT)).toBe('unrelated');
    expect(classifyCwd('/opt/homebrew', ROOT)).toBe('unrelated');
  });

  test('sibling directories sharing a name prefix are not inside', () => {
    expect(classifyCwd(`${ROOT}-backup`, ROOT)).toBe('unrelated');
  });

  test('macOS /private aliasing is normalized', () => {
    expect(classifyCwd('/private/var/folders/x/app', '/var/folders/x/app')).toBe('inside');
  });
});

function server(url: string, commandLine: string | null): ProjectServer {
  return { url, owner: { pid: 1, command: 'x' }, commandLine };
}

describe('rankProjectServers', () => {
  test("the framework's real dev server is preferred over a stray static server", () => {
    // Real case: a leftover `python -m http.server` and the actual Next.js
    // dev server were both listening inside the project directory.
    const servers = [
      server('http://localhost:4620', '/opt/homebrew/.../Python -m http.server 4620'),
      server('http://localhost:3005', 'next-server (v16.2.9)'),
    ];
    expect(rankProjectServers(servers, nextAdapter)[0]?.url).toBe('http://localhost:3005');
  });

  test('vite dev servers are preferred for vite projects', () => {
    const servers = [
      server('http://localhost:8080', 'python3 -m http.server'),
      server('http://localhost:5173', 'node /repo/node_modules/.bin/vite'),
    ];
    expect(rankProjectServers(servers, viteAdapter)[0]?.url).toBe('http://localhost:5173');
  });

  test('ordering is preserved when nothing matches', () => {
    const servers = [server('http://localhost:1', 'ruby app.rb'), server('http://localhost:2', null)];
    expect(rankProjectServers(servers, nextAdapter).map((s) => s.url)).toEqual([
      'http://localhost:1',
      'http://localhost:2',
    ]);
  });

  test('node processes are preferred for generic projects', () => {
    const servers = [
      server('http://localhost:9', 'Python -m http.server'),
      server('http://localhost:8', 'node server.mjs'),
    ];
    expect(rankProjectServers(servers, genericAdapter)[0]?.url).toBe('http://localhost:8');
  });
});
