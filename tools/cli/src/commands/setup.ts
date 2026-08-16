/**
 * `intutic setup` — the cohort setup wizard (LLD #70, model catalog & cohort
 * wizard): codescan → provider → credentials → verify → persist → judge
 * model → summary. Mirrors the dashboard's `SetupWizard.tsx` step order
 * (minus the parts that need a browser) and, wherever a step corresponds to
 * an existing flag-driven command, calls exactly what that command calls —
 * `detectHarnesses` (same as `intutic init`), the provider-credentials PUT
 * (same route `intutic credentials set` hits), `probeProviderCredential`
 * (same shared-types probe spec the dashboard's verify button uses). This is
 * a guided sequence over existing actions, not a parallel code path.
 *
 * `intutic init` stays exactly as it was — flag-driven, safe for CI, no
 * prompts. This command is the interactive counterpart for a human at a
 * keyboard.
 *
 * @module
 */

import * as p from '@clack/prompts'
import pc from 'picocolors'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROVIDER_REGISTRY,
  getProviderDefinition,
  judgeModelChoices,
  findCatalogModel,
  type ProviderDefinition,
} from '@intutic/shared-types'
import { findWorkspaceRoot } from './init.js'
import { detectHarnesses } from '../harness/detector.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { probeProviderCredential } from '../lib/providerProbe.js'

// Uses lib/api.ts's createApiClient, the same client every other CLI command
// (credentials.ts, org.ts, team.ts, gateway.ts, whoami.ts) uses -- NOT
// @intutic/clawde-sdk. clawde-sdk's own module doc is explicit that it
// mirrors the CLI's already-tested contracts for THIRD-PARTY embedders ("the
// CLI's own already-tested contracts, not re-derived"); the CLI depending on
// it would invert that relationship, and no other command here does.

/** Result of POST /api/v1/workspace/judge-model/test (mirrors the dashboard's useJudgeModel.ts). */
interface JudgeModelTestResult {
  ok: boolean
  model?: string
  provider?: string
  latencyMs?: number
  stage?: 'shape' | 'provider' | 'completion'
  error?: string
  upstreamStatus?: number
}

// Exported (not just module-private) so a test's SetupIO implementation can
// return the SAME unique-symbol value the SetupIO interface's method
// signatures reference -- TS treats two `Symbol('cancelled')` literals in
// different files as distinct unique-symbol types, so a test-local re-
// declaration would fail to satisfy the interface even though it is
// semantically "the same" cancellation marker.
export const CANCELLED = Symbol('cancelled')

/**
 * The subset of @clack/prompts this command uses, behind an interface so
 * tests can inject a scripted fake instead of driving a real terminal.
 * `select`/`text`/`password`/`confirm` return `CANCELLED` on Ctrl-C, mirroring
 * clack's own `isCancel` convention rather than throwing.
 */
export interface SetupIO {
  intro(msg: string): void
  outro(msg: string): void
  note(msg: string, title?: string): void
  log: { info(msg: string): void; success(msg: string): void; warn(msg: string): void; error(msg: string): void }
  select<T extends string>(opts: { message: string; options: Array<{ value: T; label: string; hint?: string }> }): Promise<T | typeof CANCELLED>
  text(opts: { message: string; placeholder?: string; defaultValue?: string }): Promise<string | typeof CANCELLED>
  password(opts: { message: string }): Promise<string | typeof CANCELLED>
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean | typeof CANCELLED>
}

/** Real terminal IO, backed by @clack/prompts. */
export function createClackIO(): SetupIO {
  return {
    intro: (msg) => p.intro(msg),
    outro: (msg) => p.outro(msg),
    note: (msg, title) => p.note(msg, title),
    log: { info: p.log.info, success: p.log.success, warn: p.log.warn, error: p.log.error },
    async select(opts) {
      // p.select<Value>'s Option<Value> is a conditional type that doesn't
      // resolve against a still-generic T here (TS can't distribute
      // `Value extends Primitive ? … : never` over an unresolved type
      // parameter) -- the object shape is correct at runtime; the cast
      // below is narrowing past that inference gap, not around a real type
      // mismatch.
      const res = await p.select(opts as unknown as Parameters<typeof p.select>[0])
      return p.isCancel(res) ? CANCELLED : (res as never)
    },
    async text(opts) {
      const res = await p.text(opts)
      return p.isCancel(res) ? CANCELLED : (res as string)
    },
    async password(opts) {
      const res = await p.password(opts)
      return p.isCancel(res) ? CANCELLED : (res as string)
    },
    async confirm(opts) {
      const res = await p.confirm(opts)
      return p.isCancel(res) ? CANCELLED : (res as boolean)
    },
  }
}

export interface SetupOpts {
  dev?: boolean
}

async function promptCredentialFields(io: SetupIO, def: ProviderDefinition): Promise<Record<string, string> | null> {
  const values: Record<string, string> = {}
  for (const field of def.fields) {
    const raw =
      field.type === 'password'
        ? await io.password({ message: `${field.label}${field.required ? '' : ' (optional)'}` })
        : await io.text({ message: `${field.label}${field.required ? '' : ' (optional)'}`, placeholder: field.placeholder })
    if (raw === CANCELLED) return null
    if (!raw && field.required) {
      io.log.error(`${field.label} is required.`)
      return null
    }
    if (raw) values[field.key] = raw
  }
  return values
}

export async function runSetup(opts: SetupOpts, io: SetupIO = createClackIO()): Promise<void> {
  io.intro(pc.bold('Intutic — Guided Setup'))

  // ── Step 1: codescan — reuse exactly what `intutic init` uses ──
  const workspaceRoot = findWorkspaceRoot()
  if (workspaceRoot) {
    const harnesses = await detectHarnesses(workspaceRoot)
    const detected = harnesses.filter((h) => h.detected)
    if (detected.length > 0) {
      io.note(detected.map((h) => `${pc.green('✔')} ${h.type}`).join('\n'), 'Detected harnesses')
    } else {
      io.log.warn('No harnesses detected in this workspace — Intutic still works via proxy redirect.')
    }
  } else {
    io.log.warn('Not inside a workspace (no .git/ or package.json found) — skipping harness detection.')
  }

  // ── Step 2: mode ──
  const creds = await loadCredentials()
  const mode = await io.select({
    message: 'How do you want to configure this provider?',
    options: [
      {
        value: 'connected',
        label: 'Connected to Intutic',
        hint: creds ? `authenticated as ${creds.email}` : 'requires `intutic login` first',
      },
      { value: 'local', label: 'Local / offline (no control plane)', hint: 'writes an env file you export yourself' },
    ],
  })
  if (mode === CANCELLED) return io.outro('Cancelled.')

  if (mode === 'connected' && !creds) {
    io.log.error('Not authenticated. Run `intutic login` first, or choose Local / offline.')
    return io.outro('Cancelled.')
  }

  // ── Step 3: provider ──
  const providerId = await io.select({
    message: 'Which LLM provider do you want to configure?',
    options: PROVIDER_REGISTRY.map((def) => ({
      value: def.id,
      label: def.displayName,
      hint: def.routingLive ? 'live' : 'not yet routable',
    })),
  })
  if (providerId === CANCELLED) return io.outro('Cancelled.')
  const def = getProviderDefinition(providerId)!

  // ── Step 4: credentials ──
  io.note(`Enter your ${def.displayName} credential.${def.docsUrl ? ` Get one at ${def.docsUrl}` : ''}`, def.displayName)
  const fields = await promptCredentialFields(io, def)
  if (!fields) return io.outro('Cancelled.')

  // ── Step 5: verify (informational — 401/403 is the only hard stop) ──
  io.log.info('Verifying credential…')
  const probeResult = await probeProviderCredential(providerId, fields)
  if (probeResult.status === 'invalid') {
    io.log.error(probeResult.detail)
    const proceed = await io.confirm({ message: 'Save it anyway?', initialValue: false })
    if (proceed !== true) return io.outro('Cancelled.')
  } else if (probeResult.status === 'valid') {
    io.log.success(probeResult.detail)
  } else {
    io.log.warn(probeResult.detail)
  }

  // ── Step 6: persist ──
  if (mode === 'connected') {
    const client = createApiClient(resolveControlPlaneUrl(opts.dev), creds!.apiKey)
    try {
      await client.put(`/api/v1/workspace/provider-credentials/${encodeURIComponent(providerId)}`, fields)
      io.log.success(`${def.displayName} credential saved to your workspace.`)
    } catch (err) {
      io.log.error(`Failed to save credential: ${err instanceof Error ? err.message : String(err)}`)
      return io.outro('Setup incomplete.')
    }
  } else {
    const envLines = Object.entries(fields).map(([k, v]) => `INTUTIC_${providerId.toUpperCase()}_${k.toUpperCase()}=${v}`)
    const envPath = join(workspaceRoot ?? process.cwd(), '.intutic.env')
    writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 })
    io.note(envLines.map((l) => l.replace(/=.*/, '=<redacted>')).join('\n'), `Written to ${envPath}`)
    io.log.warn(`${envPath} contains a secret — do not commit it. Source it yourself before running your harness.`)
  }

  // ── Step 7: judge model ──
  const wantJudge = await io.confirm({
    message: "Set up an LLM-as-judge model for this workspace's checks?",
    initialValue: false,
  })
  let judgeModel: string | null = null
  if (wantJudge === true) {
    const choices = judgeModelChoices({ saasRoutableOnly: mode === 'connected' })
    const CUSTOM = '__custom__'
    const pick = await io.select({
      message: 'Judge model',
      options: [
        ...choices.slice(0, 20).map((m) => ({ value: m.ref, label: `${m.displayName} (${m.provider})` })),
        { value: CUSTOM, label: 'Enter a custom model name…' },
      ],
    })
    if (pick !== CANCELLED) {
      judgeModel = pick === CUSTOM ? null : pick
      if (pick === CUSTOM) {
        const custom = await io.text({ message: 'Custom judge model name' })
        judgeModel = custom === CANCELLED ? null : custom || null
      }
    }
  }

  if (judgeModel) {
    if (!findCatalogModel(judgeModel)) {
      io.log.warn(`'${judgeModel}' is not in the known model catalog — treating it as a custom/BYO alias.`)
    }
    if (mode === 'connected') {
      const client = createApiClient(resolveControlPlaneUrl(opts.dev), creds!.apiKey)
      try {
        await client.put('/api/v1/workspace/settings', { managedJudgeModel: judgeModel })
        io.log.success(`Judge model set to ${judgeModel}.`)
      } catch (err) {
        io.log.error(`Failed to save judge model: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Same round-trip the dashboard's JudgeModelPanel Test button runs
      // (POST /api/v1/workspace/judge-model/test, workspace.ts) — a real,
      // tiny completion through the exact path a workspace judge would
      // take. Reported, not gating: the setting is already saved above, the
      // same way the dashboard's Save and Test are independent actions.
      io.log.info('Verifying the judge model…')
      try {
        const testResult = await client.post<JudgeModelTestResult>('/api/v1/workspace/judge-model/test', {
          model: judgeModel,
        })
        if (testResult.ok) {
          io.log.success(
            `Judge model verified — routes via ${testResult.provider}, ${testResult.latencyMs}ms round-trip.`,
          )
        } else {
          io.log.warn(
            `Judge model test failed at the ${testResult.stage} stage: ${testResult.error}` +
              (testResult.stage === 'provider'
                ? ' (this only means it cannot be tested right now — the setting above is already saved)'
                : ''),
          )
        }
      } catch (err) {
        io.log.warn(`Could not run the judge model test: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      io.note(
        `On-prem judge setup isn't finished by this command — run:\n  intutic judge configure`,
        'Next step',
      )
    }
  }

  io.outro(pc.bold('Setup complete.'))
}
