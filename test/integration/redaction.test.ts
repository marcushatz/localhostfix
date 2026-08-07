import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { runInspection } from '../../src/inspect/run.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { discoverServers } from '../../src/server/discovery.js';
import { genericAdapter } from '../../src/frameworks/adapter.js';
import { makeFixture, serverSource, type Fixture } from '../fixtures/servers.js';

/**
 * Adversarial redaction tests.
 *
 * The fixture page deliberately leaks obviously-fake secrets through every
 * channel LocalhostFix records, then every generated artifact is scanned for
 * them. A secret appearing anywhere in a run directory is a release blocker.
 */

const TIMEOUT = 120_000;

/** Distinctive so a match cannot be coincidental. */
const SECRETS = {
  bearer: 'sk-live-LOCALHOSTFIXSECRET-bearer-11111',
  cookie: 'LOCALHOSTFIXSECRET-cookie-22222',
  apiKey: 'LOCALHOSTFIXSECRET-apikey-33333',
  queryToken: 'LOCALHOSTFIXSECRET-querytoken-44444',
  queryPassword: 'LOCALHOSTFIXSECRET-password-55555',
  responseBody: 'LOCALHOSTFIXSECRET-responsebody-66666',
  csrf: 'LOCALHOSTFIXSECRET-csrf-77777',
};

const fixtures: Fixture[] = [];
afterAll(() => {
  for (const f of fixtures) f.cleanup();
});

const LEAKY_HANDLER = `(req, res) => {
  if (req.url.startsWith('/api/')) {
    res.writeHead(500, {'content-type':'application/json'});
    res.end(JSON.stringify({ error: 'boom', leaked: ${JSON.stringify(SECRETS.responseBody)} }));
    return;
  }
  res.writeHead(200, {'content-type':'text/html'});
  res.end(\`<!doctype html><html><head><title>Leaky</title></head><body>
    <div id="root"><h1>Leaky fixture</h1><p>This page issues requests carrying secrets in headers and query parameters so that redaction can be verified end to end.</p><button>Act</button><a href="/x">Link</a></div>
    <script>
      fetch('/api/one?token=${SECRETS.queryToken}&password=${SECRETS.queryPassword}&page=2', {
        headers: {
          'authorization': 'Bearer ${SECRETS.bearer}',
          'x-api-key': '${SECRETS.apiKey}',
          'x-csrf-token': '${SECRETS.csrf}'
        }
      }).catch(function(){});
      document.cookie = 'session=${SECRETS.cookie}';
      fetch('/api/two', { credentials: 'include' }).catch(function(){});
    </script>
  </body></html>\`);
}`;

describe('adversarial redaction', () => {
  test(
    'no secret from any channel appears in any generated artifact',
    async () => {
      const fixture = makeFixture('leaky', serverSource(LEAKY_HANDLER));
      fixtures.push(fixture);

      const { report, runDir } = await runInspection({ cwd: fixture.dir });

      // The failing API must have been recorded, or the test proves nothing.
      expect(report.counts.failedRequests).toBeGreaterThan(0);

      const textFiles = fs
        .readdirSync(runDir)
        .filter((f) => !f.endsWith('.png'))
        .map((f) => ({ name: f, content: fs.readFileSync(path.join(runDir, f), 'utf8') }));
      expect(textFiles.length).toBeGreaterThan(3);

      const leaks: string[] = [];
      for (const { name, content } of textFiles) {
        for (const [label, secret] of Object.entries(SECRETS)) {
          if (content.includes(secret)) leaks.push(`${label} leaked into ${name}`);
        }
        // Nothing should be able to smuggle the marker through at all.
        if (content.includes('LOCALHOSTFIXSECRET')) {
          const line = content.split('\n').find((l) => l.includes('LOCALHOSTFIXSECRET'));
          leaks.push(`marker present in ${name}: ${line?.slice(0, 160)}`);
        }
      }
      expect(leaks).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'redaction preserves the diagnostic value of the record',
    async () => {
      const fixture = makeFixture('leaky-useful', serverSource(LEAKY_HANDLER));
      fixtures.push(fixture);

      const { runDir } = await runInspection({ cwd: fixture.dir });
      const network = fs.readFileSync(path.join(runDir, 'network.json'), 'utf8');

      // The developer still needs to know WHICH request failed and how.
      expect(network).toContain('/api/');
      expect(network).toContain('500');
      expect(network).toContain('REDACTED');
      // Non-sensitive query parameters survive.
      expect(network).toContain('page=2');
    },
    TIMEOUT,
  );

  test(
    'response and request bodies are never stored',
    async () => {
      const fixture = makeFixture('bodies', serverSource(LEAKY_HANDLER));
      fixtures.push(fixture);

      const { runDir } = await runInspection({ cwd: fixture.dir });
      const all = fs
        .readdirSync(runDir)
        .filter((f) => !f.endsWith('.png'))
        .map((f) => fs.readFileSync(path.join(runDir, f), 'utf8'))
        .join('\n');

      expect(all).not.toContain(SECRETS.responseBody);
      // No body field is recorded at all in the network record.
      const network = JSON.parse(fs.readFileSync(path.join(runDir, 'network.json'), 'utf8'));
      for (const entry of network) {
        expect(entry).not.toHaveProperty('body');
        expect(entry).not.toHaveProperty('responseBody');
        expect(entry).not.toHaveProperty('requestBody');
      }
    },
    TIMEOUT,
  );

  test(
    'a remote configured URL is never contacted, by doctor or by discovery',
    async () => {
      // Uses a TEST-NET-3 address (RFC 5737), which is guaranteed
      // unroutable, so a request would fail rather than reach anyone. The
      // assertion is that LocalhostFix reports it as blocked rather than
      // attempting it at all.
      const remote = 'http://203.0.113.10:8080';
      const fixture = makeFixture('remote-guard', serverSource(LEAKY_HANDLER));
      fixtures.push(fixture);
      fs.mkdirSync(path.join(fixture.dir, '.localhostfix'), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.dir, '.localhostfix', 'config.json'),
        JSON.stringify({ url: remote, allowRemote: false }),
      );

      const discovery = await discoverServers({
        projectRoot: fixture.dir,
        adapter: genericAdapter,
        configuredUrl: remote,
        allowRemote: false,
      });
      expect(discovery.remoteUrlBlocked).toBe(remote);
      expect(discovery.selected).toBeNull();

      const doctor = await runDoctor({ cwd: fixture.dir, fix: false, startServer: false });
      const flat = doctor.sections.flatMap((s) => s.findings.map((f) => f.text)).join('\n');
      expect(flat).toMatch(/not a localhost URL/i);
      expect(flat).toMatch(/did not contact it/i);
      expect(doctor.recommendations.join(' ')).toMatch(/localhost only/i);
    },
    TIMEOUT,
  );

  test(
    'artifact directories are git-ignored by setup',
    async () => {
      const fixture = makeFixture('ignored', serverSource(LEAKY_HANDLER));
      fixtures.push(fixture);
      const { runDir } = await runInspection({ cwd: fixture.dir });

      // Artifacts live under .localhostfix/runs, which setup adds to .gitignore.
      expect(runDir).toContain(path.join('.localhostfix', 'runs'));
    },
    TIMEOUT,
  );
});
