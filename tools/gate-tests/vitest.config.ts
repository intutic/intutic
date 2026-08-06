import { defineConfig } from 'vitest/config'

/**
 * Tests for the repo's gate scripts, which decide whether an unsupported claim
 * can ship and which sat outside every test runner: `vitest.workspace.ts` globs
 * `packages/*` and `services/*`, and the scripts live under `tools/`.
 *
 * ## Why this is a sibling directory rather than `tools/scripts` itself
 *
 * Making `tools/scripts` a package means giving it a `package.json`, and this
 * one needs `"type": "module"` for vitest — which reinterprets every `.js` file
 * beside it as ESM. `install-hooks.js` is CommonJS and runs from the root
 * `prepare` script, so that change breaks `pnpm install` for the whole repo.
 * The tests live here and reach the scripts by relative path instead.
 */
export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
