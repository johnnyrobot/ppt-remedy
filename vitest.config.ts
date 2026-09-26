import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
