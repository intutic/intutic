import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Load the machine or wait out a deadline: run alone by `pnpm test:load`.
    exclude: ['src/__tests__/load/**', 'node_modules/**', 'dist/**'],
  },
})
