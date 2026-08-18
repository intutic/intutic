/**
 * Cross-platform "is this binary on PATH" check, without invoking the binary
 * itself.
 *
 * Hoisted out of `sandbox/firecracker.ts` — originally a private helper
 * there, checking for the `firecracker` binary — once a second external-tool
 * integration (`ciscoScanner.ts`, the opt-in Cisco `skill-scanner`
 * integration, Phase S3) needed the identical check. A shared, single
 * implementation here, rather than a second copy that could quietly drift
 * from the first (different shell quoting, different exit-code handling).
 *
 * @module
 */

import { spawn } from 'node:child_process'

/**
 * Resolves `true` iff `bin` is found on PATH.
 *
 * Uses `command -v`, a POSIX shell builtin, via `sh -c` rather than spawning
 * `bin` itself with `--version` or similar — a lookup-only check must never
 * actually execute the tool being probed. `bin` is expected to be a fixed,
 * code-controlled binary name (`firecracker`, `skill-scanner`), never
 * user-supplied input threaded into this shell string.
 */
export function binaryOnPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}
