/**
 * The control plane a generated hook posts its events to when
 * `~/.intutic/env/runtime.env` names none.
 *
 * runtime.env's `INTUTIC_HOST` (written from the URL `intutic connect`
 * resolved) wins at run time; this is only the value baked in for before it
 * exists: the control plane the writer was given, else the hosted one once it
 * is released (`CLOUD_RELEASED`, packages/shared-types/src/release.ts), else
 * none. With none, the hook's direct
 * post has nowhere to go and fails quietly; the event is still in its local
 * events log, which the daemon drains to the control plane it is connected
 * to, if any.
 *
 * @module
 */

import { CLOUD_RELEASED, HOSTED_CONTROL_PLANE_URL } from '@intutic/shared-types'

export function hookHostFallback(controlPlaneUrl?: string): string {
  return controlPlaneUrl || (CLOUD_RELEASED ? HOSTED_CONTROL_PLANE_URL : '')
}
