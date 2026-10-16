/**
 * Release flag, copied from packages/shared-types/src/release.ts (the
 * canonical one): this package has no runtime dependency on
 * @intutic/shared-types. `node tools/scripts/release-content.js --check`
 * fails when the two disagree, so flip both at launch.
 */

/** The hosted control plane has launched, so it is the default. */
export const CLOUD_RELEASED = false

/** The hosted control plane's API host; the dashboard host serves the web app, not the API. */
export const HOSTED_CONTROL_PLANE_URL = 'https://api.intutic.ai'

/** The control plane used when nothing names one: the hosted one once released, else none. */
export const DEFAULT_CONTROL_PLANE_URL: string | undefined = CLOUD_RELEASED ? HOSTED_CONTROL_PLANE_URL : undefined

/** What a client that needs a control plane says when it has no address. */
export const NO_CONTROL_PLANE_URL = 'No Intutic control plane URL: pass it to the client or set INTUTIC_CONTROL_PLANE_URL.'
