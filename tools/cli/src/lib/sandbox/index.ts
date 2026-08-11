/**
 * Sandbox backend selection (LLD #63 §6).
 *
 * Picks the requested backend, or the best available one. The honesty rule:
 * a backend whose `health()` is false is never silently swapped for a weaker
 * one — the caller is told what is unavailable and why, and can decide.
 *
 * @module
 */

import { FirecrackerBackend, type FirecrackerOptions } from './firecracker.js'
import { OciBackend, type OciRuntime } from './oci.js'
import type { SandboxBackend } from './types.js'

export * from './types.js'
export { buildOciArgs, OciBackend } from './oci.js'
export { buildFirecrackerConfig, FirecrackerBackend } from './firecracker.js'

export type SandboxKind = 'oci' | 'firecracker'

/**
 * Resolve a container backend, preferring docker then podman. `env` holds the
 * values the runtime will read for `--env NAME` references (proxy vars, keys).
 */
export function ociBackend(env: Record<string, string>, runtime?: OciRuntime): OciBackend {
  return new OciBackend(runtime ?? 'docker', env)
}

/**
 * Firecracker options from env, with defaults. The kernel + rootfs are
 * operator-supplied (INTUTIC_FC_KERNEL / INTUTIC_FC_ROOTFS), like an OCI image
 * is operator-supplied — the backend's `health()` refuses if they are missing.
 */
export function firecrackerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FirecrackerOptions {
  return {
    kernelPath: env.INTUTIC_FC_KERNEL ?? '',
    rootfsPath: env.INTUTIC_FC_ROOTFS ?? '',
    tapDevice: env.INTUTIC_FC_TAP ?? 'tap-intutic',
    guestIp: env.INTUTIC_FC_GUEST_IP ?? '172.16.0.2',
    hostIp: env.INTUTIC_FC_HOST_IP ?? '172.16.0.1',
    prefixLen: Number.parseInt(env.INTUTIC_FC_PREFIX ?? '30', 10),
    vcpus: Number.parseInt(env.INTUTIC_FC_VCPUS ?? '1', 10),
    memMib: Number.parseInt(env.INTUTIC_FC_MEM ?? '512', 10),
  }
}

/**
 * Select a backend by kind. Both backends gate on their own `health()`; the
 * caller refuses when a backend is unavailable rather than downgrading to a
 * weaker one (the honesty rule, LLD #63 §6).
 */
export function selectBackend(
  kind: SandboxKind,
  env: Record<string, string>,
  runtime?: OciRuntime,
): SandboxBackend {
  switch (kind) {
    case 'oci':
      return ociBackend(env, runtime)
    case 'firecracker':
      return new FirecrackerBackend(firecrackerOptionsFromEnv(), env)
    default:
      throw new Error(`unknown sandbox backend '${kind as string}'`)
  }
}
