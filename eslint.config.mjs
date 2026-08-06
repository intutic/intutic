import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/.dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.config.*',
    ],
  },
  {
    rules: {
      // Relax rules for initial setup — tighten over time
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Off globally because the CLI writes to stdout by design and the
      // daemon/db packages have not been swept yet — see TD-297. Where a
      // package claims a zero, the zero is enforced by an override below
      // rather than by the claim.
      'no-console': 'off',
    },
  },
  {
    // TD-045/TD-046 asserted "0 console.* calls remain in control plane" and
    // closed. Twenty-one had accumulated by the time anyone looked, because
    // nothing held the invariant: this rule was off, and — more to the point —
    // `services/control-plane` had no `lint` script at all, so `turbo lint`
    // never opened one of its files. Both halves are fixed; either alone would
    // have left the claim resting on nothing.
    files: ['services/control-plane/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    /*
     * The harness writers emit shell scripts from TypeScript template literals,
     * so `\$` appears constantly — `\$1`, `\${ts}`, `"\$entry"` — to stop the
     * template engine eating a shell variable. ESLint reports 158 of them as
     * "unnecessary escape", which is true of `\$1` in isolation and beside the
     * point: the escaping in these files is one deliberate scheme, applied
     * uniformly, and half-removing it is how a generated hook script silently
     * starts interpolating at build time instead of at run time. Removing them
     * changes no emitted byte, so the churn buys nothing and costs the
     * uniformity that makes `\${…}` obviously deliberate.
     *
     * What makes this a judgement rather than an excuse:
     * `__tests__/harness/generatedShellIntegrity.test.ts` now generates all five
     * scripts and asserts they parse under `bash -n`, keep their shell parameter
     * expansions, write parseable JSON to the audit log, and match a byte-level
     * snapshot. The property the rule was gesturing at is measured directly.
     *
     * That test is not decoration. Writing it found `\"` where `\\"` was needed
     * in three of the five writers — which emitted quote-less JSON that
     * `drainHookEvents` could not parse and then truncated the audit log over.
     * ESLint had flagged those too, inside this same 158, and turning the rule
     * off without the test would have buried a live defect.
     *
     * Scoped to the harness directory, never globally: the same rule caught two
     * real ones in `packages/mcp-proxy/src/dlp.ts`, which are fixed.
     */
    files: ['services/sync-daemon/src/harness/**/*.ts'],
    rules: {
      'no-useless-escape': 'off',
    },
  },
);
