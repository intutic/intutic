/**
 * The default sandbox image, built locally from the Dockerfile the CLI ships.
 *
 * There is no registry copy to pull: the default used to be
 * `intutic/sandbox:latest`, a name nothing publishes, so `intutic exec
 * --sandbox` failed on the pull for everyone who did not pass
 * `--sandbox-image`. The image is small and built from `resources/sandbox`,
 * which is in the npm package, so the first sandboxed run builds it and tags it
 * with the CLI version; later runs, and upgrades to the same version, reuse it.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from '../logger.js'

const { version } = createRequire(import.meta.url)('../../../package.json') as { version: string }

/** The image `--sandbox-image` defaults to: built locally, tagged with this CLI's version. */
export const DEFAULT_SANDBOX_IMAGE = `intutic/sandbox:${version}`

/** Directory holding the shipped Dockerfile and entrypoint. */
export function sandboxBuildContext(): string {
  // src/lib/sandbox/image.ts and dist/lib/sandbox/image.js are the same depth.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../../resources/sandbox')
}

/** Runs a container-runtime command; resolves with its exit code. */
export type RuntimeRunner = (runtime: string, args: string[], inheritOutput: boolean) => Promise<number>

const spawnRuntime: RuntimeRunner = (runtime, args, inheritOutput) =>
  new Promise((resolve) => {
    const child = spawn(runtime, args, { stdio: inheritOutput ? 'inherit' : 'ignore' })
    child.on('error', () => resolve(127))
    child.on('exit', (code) => resolve(code ?? 1))
  })

/**
 * Make sure `image` can be run. Only the default image is built here; any
 * other name is the user's own and the runtime pulls it as usual.
 *
 * Throws with a message for the user when the default image is missing and
 * cannot be built.
 */
export async function ensureSandboxImage(
  runtime: string,
  image: string,
  run: RuntimeRunner = spawnRuntime,
  context: string = sandboxBuildContext(),
): Promise<void> {
  if (image !== DEFAULT_SANDBOX_IMAGE) return
  if ((await run(runtime, ['image', 'inspect', image], false)) === 0) return

  if (!existsSync(path.join(context, 'Dockerfile'))) {
    throw new Error(
      `the sandbox Dockerfile is not part of this installation (${context}). ` +
        'Install the CLI from npm, or pass --sandbox-image with your own image.',
    )
  }
  log.info(`Building the sandbox image ${image} (first sandboxed run with this CLI version)…`)
  if ((await run(runtime, ['build', '-t', image, context], true)) !== 0) {
    throw new Error(`${runtime} build of ${image} failed; see the output above`)
  }
}
