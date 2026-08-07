import { defineConfig } from 'vitest/config';

/**
 * Unit and integration tests have very different shapes, so they get very
 * different time budgets rather than one global number that has to suit both.
 *
 * Unit tests touch no browser, no servers, and no process inspection; the
 * whole suite finishes in milliseconds. A short timeout there means a genuine
 * hang fails fast instead of stalling CI for two minutes.
 *
 * Integration tests boot real dev servers and launch real Chromium. On a cold
 * GitHub macOS runner the first browser launch plus two full-page screenshots
 * has twice exceeded a 120s per-test budget, while reruns of the identical
 * commit passed — slowness, not a hang. The integration budget is sized from
 * that observed cold-run cost with margin, and is deliberately not so large
 * that a genuinely stuck test would sit unnoticed.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Cold CI browser and dev-server startup; see the note above.
          testTimeout: 240_000,
          hookTimeout: 120_000,
          // Real dev servers and browsers: keep concurrency low so ports and
          // CPU do not thrash, and so process-cleanup assertions stay
          // meaningful.
          fileParallelism: false,
          pool: 'forks',
        },
      },
    ],
  },
});
