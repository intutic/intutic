import { defineConfig } from 'vitest/config'

// Vitest 4 dropped `vitest.workspace.*`; the same three globs now live under
// `test.projects`. Deliberately NOT named `vitest.config.ts`: Vitest finds a
// config by walking up from the package it runs in, so a root config with
// `projects` would be picked up by every package that has no config of its
// own and make each `turbo run test` try to run the whole workspace. Opt in
// from the repo root instead:
//
//   pnpm vitest run --config vitest.projects.config.ts
//
// Each project's own vitest.config.ts is unchanged and is still what
// `turbo run test` executes per package.
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'services/*/vitest.config.ts',
      // Gate scripts. Not a package glob — 'tools' is one directory, not many.
      'tools/gate-tests/vitest.config.ts',
    ],
  },
})
