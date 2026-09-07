import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/server/__tests__/**/*.test.ts'],
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      NODE_ENV: 'test',
    },
    // Run sequentially -- tests share a single MongoDB test database
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
