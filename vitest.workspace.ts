import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'services/*/vitest.config.ts',
  // Gate scripts. Not a package glob — one directory, not many.
  'tools/gate-tests/vitest.config.ts',
])
