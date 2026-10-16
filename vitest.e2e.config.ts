import { defineConfig } from 'vitest/config';

/** End-to-end tests: they talk to the built server over real stdio transport. */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
