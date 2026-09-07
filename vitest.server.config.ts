import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/server/__tests__/**/*.test.ts'],
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      // Isolated from dev dummy data (childapp). .env.test or shell MONGO_URI overrides this.
      MONGO_URI: 'mongodb://localhost:27017/childapp_test',
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
