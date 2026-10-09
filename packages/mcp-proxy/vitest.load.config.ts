import { defineConfig } from 'vitest/config'

/**
 * The tests that load every core or leave a stuck worker burning one, run on
 * their own after the package suites (`pnpm test:load`): one file at a time,
 * so the load each makes is the only load the next one sees besides the
 * machine's own.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/load/**/*.test.ts'],
    fileParallelism: false,
  },
})
