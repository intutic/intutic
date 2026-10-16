/**
 * Release flags: which Intutic products have shipped.
 *
 * Only the open core is released. Until a flag is flipped:
 *
 *   - CLOUD_RELEASED (the hosted control plane): nothing defaults to
 *     {@link HOSTED_CONTROL_PLANE_URL}. A control plane is used only when one
 *     is named (INTUTIC_CONTROL_PLANE_URL, --control-plane-url, --dev, or the
 *     URL a login saved), and a command that needs one and has none says so
 *     ({@link NO_CONTROL_PLANE_MESSAGE}).
 *   - SELF_HOST_RELEASED (the self-hosted / on-prem distribution): its
 *     commands (the on-prem judge's Helm values) are hidden from CLI help.
 *   - Either one ({@link CONTROL_PLANE_PRODUCT_RELEASED}): the commands that
 *     only work against a control plane (login, connect, org, keys, ...) are
 *     hidden from CLI help. Hidden, not removed: they still run.
 *
 * README passages about an unreleased product sit in `<!-- UNRELEASED:cloud`
 * or `<!-- UNRELEASED:self-host` comment blocks.
 *
 * Launch: flip the flag here, its twins in the Python SDK
 * (packages/intutic-clawde/intutic_clawde/release.py: CLOUD_RELEASED /
 * SELF_HOST_RELEASED) and the Terraform provider
 * (packages/terraform-provider-intutic/internal/provider/release.go:
 * cloudReleased / selfHostReleased), and the local copies in
 * packages/clawde-sdk/src/release.ts and packages/gate-js/src/release.ts
 * (which have no runtime dependency on this package); run
 * `node tools/scripts/release-content.js --unwrap <kind>` for the READMEs;
 * update the SDK doc comments that say "this release has no default control
 * plane" (and regenerate the SDK reference); then release. `node tools/scripts/release-content.js --check` (in
 * `pnpm lint:claims`) fails while the copies disagree.
 */

/** The hosted control plane (api.intutic.ai) has launched. */
export const CLOUD_RELEASED = false

/** The self-hosted / on-prem distribution has launched. */
export const SELF_HOST_RELEASED = false

/** Some control plane product has launched, so the commands that need one are listed. */
export const CONTROL_PLANE_PRODUCT_RELEASED = CLOUD_RELEASED || SELF_HOST_RELEASED

/** The hosted control plane's API host. The default only when {@link CLOUD_RELEASED}. */
export const HOSTED_CONTROL_PLANE_URL = 'https://api.intutic.ai'

/** What a command that needs a control plane says when none is configured. */
export const NO_CONTROL_PLANE_MESSAGE =
  'No control plane configured. Open core runs locally (intutic start). ' +
  'To use a control plane, set INTUTIC_CONTROL_PLANE_URL or pass --control-plane-url.'
