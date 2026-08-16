/**
 * CLI-side provider credential verification (LLD #70, model catalog &
 * cohort wizard).
 *
 * `buildVerificationProbe`/`classifyProbeResponse` in `@intutic/shared-types`
 * describe WHAT request proves a credential works; this is the CLI's
 * executor. Unlike the control plane's equivalent
 * (`services/control-plane/src/lib/providerVerify.ts`), which probes a
 * credential already stored in Valkey, the CLI legitimately holds the raw
 * key the operator just typed, in memory, before it is ever sent anywhere —
 * so it probes with that value directly.
 *
 * @module
 */

import { buildVerificationProbe, classifyProbeResponse, getProviderDefinition, type ProbeVerdict } from '@intutic/shared-types'

export interface ProviderProbeOutcome {
  status: ProbeVerdict | 'unsupported'
  httpStatus?: number
  detail: string
}

/**
 * Verify a credential the caller holds locally (not yet, or not necessarily,
 * saved anywhere). `fields` matches the provider's registry field shape,
 * e.g. `{apiKey: '...'}` for Anthropic, `{apiKey, endpoint, deploymentName}`
 * for Azure OpenAI.
 */
export async function probeProviderCredential(
  providerId: string,
  fields: Record<string, string>,
  timeoutMs = 10_000,
): Promise<ProviderProbeOutcome> {
  const def = getProviderDefinition(providerId)
  if (!def) {
    return { status: 'unsupported', detail: `Unknown provider '${providerId}'` }
  }

  const probe = buildVerificationProbe(providerId, fields)
  if (!probe) {
    return {
      status: 'unsupported',
      detail: `${def.displayName} cannot be verified automatically yet — double-check the credential by hand`,
    }
  }

  try {
    const res = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      ...(probe.body ? { body: probe.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const verdict = classifyProbeResponse(res.status)
    return {
      status: verdict,
      httpStatus: res.status,
      detail:
        verdict === 'valid'
          ? `${def.displayName} credential looks valid`
          : verdict === 'invalid'
            ? `${def.displayName} rejected the credential (HTTP ${res.status})`
            : `${def.displayName} returned HTTP ${res.status} — could not confirm either way`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'unknown', detail: `Could not reach ${def.displayName} to verify: ${message}` }
  }
}
