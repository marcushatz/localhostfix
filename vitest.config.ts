import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Real dev servers and browsers: keep concurrency low so ports and CPU
    // do not thrash, and so process-cleanup assertions stay meaningful.
    fileParallelism: false,
    pool: 'forks',
  },
});
