import { defineConfig } from 'vitest/config'

/**
 * This package had no test script and no config, so it appeared in neither
 * `turbo test` nor `vitest.workspace.ts` (which globs
 * `packages/star/vitest.config.ts`). The template every rule author copies was
 * the one package in the repo with no coverage at all.
 *
 * The tests here are TypeScript reading AssemblyScript as source. They do not
 * compile the guest — `asc` is a separate build step — because what needs
 * guarding is the contract between the host struct and the guest parser, and
 * that is checkable from the two sources without a toolchain.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
