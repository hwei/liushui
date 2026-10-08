import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
