/**
 * `intutic judge configure` — generate the local artifacts an on-prem
 * LLM-as-judge needs (model catalog & cohort wizard).
 *
 * Judges run only on self-hosted models (owner rule, 2026-10-03): the picker
 * offers `selfHostedJudgeModelChoices()`, and a custom reference that names a
 * hosted provider (`isHostedModelRef`) is refused.
 *
 * Deliberately local-artifacts-only: it writes a `litellm_config.yaml` and
 * the decide engine's configuration (`~/.intutic/decide/engine.json`), and
 * prints env / Helm snippets for the operator to apply themselves. It never
 * calls a remote API to flip anything on.
 *
 * The gateway variables it prints are deprecated since 3.0: the gateway maps
 * the typed band to the decide rule `local-judge` with a warning, and 4.0
 * removes them. engine.json is where 3.0 keeps the model a decide rule asks
 * (`--engine-url`, default Ollama on this machine); its key stays in
 * `INTUTIC_DECIDE_API_KEY` and is never written. `local_judge` is deliberately NOT
 * exposed through `PATCH /api/v1/gateways/:id/config`
 * (the control plane) — this command respects that
 * boundary by construction, not by omission.
 *
 * The catalog's `ref` (`${provider}/${id}`, e.g. `ollama/llama3.1`) is
 * already LiteLLM's own `litellm_params.model` format, so a selected catalog
 * entry needs no translation — see `infra/compose/litellm_config.yaml` for
 * the hand-written example this generates the same shape as.
 *
 * @module
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import pc from 'picocolors'
import {
  checkSelfHostedDecisionHost,
  DECIDE_DEFAULT_ENGINE_URL,
  DECIDE_ENGINE_FILE_PATH,
  resolveDecideEngineConfig,
  selfHostedJudgeModelChoices,
  isHostedModelRef,
  SELF_HOSTED_MODEL_PROVIDER_IDS,
  findCatalogModel,
  normalizeModelRef,
} from '@intutic/shared-types'
import { createClackIO, type SetupIO } from './setup.js'

export interface JudgeConfigureOpts {
  /** Where to write the generated litellm_config.yaml. */
  out?: string
  /** Where this machine reaches the model server, for the decide engine. */
  engineUrl?: string
  /** The home directory engine.json goes under (default: the user's). */
  home?: string
}

/** The gateway variables the env block prints, all deprecated since 3.0. */
export const DEPRECATED_JUDGE_ENV = [
  'INTUTIC_GATEWAY_LOCAL_JUDGE',
  'LITELLM_LOCAL_URL',
  'LITELLM_LOCAL_API_KEY',
  'LITELLM_LOCAL_JUDGE_MODEL',
  'LITELLM_LOCAL_TYPED_JUDGE_MODEL',
  'INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO',
  'INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI',
] as const

/**
 * Writes the decide engine's configuration to `file` (mode 0600 in a 0700
 * directory, replaced whole by a rename): `url`, `adapter`, `model`,
 * `timeoutMs`, `parallel` and `structured`. Other keys an existing file holds
 * are kept. Never the key, which is environment only.
 */
export function writeDecideEngineFile(file: string, url: string, model: string): Record<string, unknown> {
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
  } catch {
    // No file, or one that does not parse: start afresh.
  }
  const cfg = resolveDecideEngineConfig({ url, adapter: 'logprobs', model }, {})
  const doc = {
    ...existing,
    url: cfg.url,
    adapter: cfg.adapter,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    parallel: cfg.parallel,
    structured: cfg.structured,
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return doc
}

/** Printed instead of paths into Intutic's own source tree, which customers do not have. */
const ON_PREM_JUDGE_DOCS = 'https://docs.intutic.ai/external/on-prem-judge'

/**
 * The credential line for a provider-prefixed model: a self-hosted server
 * (Ollama) needs its URL, `${PROVIDER}_API_BASE`; any other prefix gets the
 * `${PROVIDER}_API_KEY` env var LiteLLM reads for that provider's key.
 */
function credentialLine(providerId: string): string {
  const env = providerId.toUpperCase()
  return SELF_HOSTED_MODEL_PROVIDER_IDS.has(providerId)
    ? `      api_base: os.environ/${env}_API_BASE\n`
    : `      api_key: os.environ/${env}_API_KEY\n`
}

/**
 * Build the litellm_config.yaml content for one judge model — the SAME
 * shape `infra/compose/litellm_config.yaml` hand-writes for its default
 * entry, generated instead of copy-pasted.
 */
export function buildLiteLLMConfigYaml(modelRef: string): string {
  const { provider, id } = normalizeModelRef(modelRef)
  const litellmModel = provider ? `${provider}/${id}` : id
  const alias = id || modelRef
  const credLine = provider ? credentialLine(provider) : ''

  return (
    `# Generated by \`intutic judge configure\`: one judge model. To serve more,\n` +
    `# add model_list entries of the same shape; see ${ON_PREM_JUDGE_DOCS}\n\n` +
    `model_list:\n` +
    `  - model_name: ${alias}\n` +
    `    litellm_params:\n` +
    `      model: ${litellmModel}\n` +
    credLine +
    `\n` +
    `general_settings:\n` +
    `  master_key: os.environ/LITELLM_MASTER_KEY\n`
  )
}

function envBlock(modelAlias: string): string {
  return [
    "# The gateway's .env (beside docker-compose.gateway.yml in the release bundle) or your own env file.",
    '# Deprecated since 3.0 and removed in 4.0; the gateway maps them to the decide rule local-judge:',
    'INTUTIC_GATEWAY_LOCAL_JUDGE=true',
    'LITELLM_LOCAL_URL=http://litellm:4000',
    'LITELLM_LOCAL_API_KEY=${LITELLM_MASTER_KEY}',
    `LITELLM_LOCAL_JUDGE_MODEL=${modelAlias}`,
  ].join('\n')
}

function helmSnippet(modelAlias: string, configPath: string): string {
  return [
    '# intutic-gateway chart values. The chart renders LiteLLM\'s config from the file',
    `# this command wrote: add \`--set-file litellm.config=${configPath}\` to helm install.`,
    'proxy:',
    '  localJudge: true',
    'litellm:',
    '  enabled: true',
    `  judgeModel: "${modelAlias}"`,
    '  # A Secret with LITELLM_MASTER_KEY and the variables the config reads (e.g. OLLAMA_API_BASE):',
    '  secretName: litellm-env',
  ].join('\n')
}

export async function runJudgeConfigure(opts: JudgeConfigureOpts, io: SetupIO = createClackIO()): Promise<void> {
  io.intro(pc.bold('Intutic — On-Prem Judge Configuration'))
  io.log.info(
    'This writes local files only — it never calls a remote API. local_judge is deliberately ' +
      'not remotely configurable; apply what this generates yourself. Judges run only on ' +
      'self-hosted models: hosted APIs (Anthropic, OpenAI, Gemini, OpenRouter, Ollama Cloud…) are refused.',
  )
  io.log.warn(
    `Deprecated since 3.0: ${DEPRECATED_JUDGE_ENV.join(', ')}. The gateway maps them to the decide ` +
      'rule local-judge with a warning, and 4.0 removes them. This command also writes the decide ' +
      `engine configuration (~/${DECIDE_ENGINE_FILE_PATH.join('/')}). See ${ON_PREM_JUDGE_DOCS}`,
  )

  const engineUrl = (opts.engineUrl ?? DECIDE_DEFAULT_ENGINE_URL).trim()
  const host = checkSelfHostedDecisionHost(engineUrl, process.env.INTUTIC_SELF_HOSTED_DECISION_HOSTS)
  if (!host.ok) {
    io.log.error(
      `The decide engine URL ${engineUrl} is not a self-hosted host (${host.reason}). Use a loopback or ` +
        'private address, or list the host in INTUTIC_SELF_HOSTED_DECISION_HOSTS.',
    )
    io.outro('Nothing written.')
    return
  }

  // Self-hosted catalog entries, plus a free-text alias for anything else the
  // operator's own LiteLLM serves (vLLM, a renamed Ollama model…).
  const CUSTOM = '__custom__'
  const choices = selfHostedJudgeModelChoices()
  const pick = await io.select({
    message: 'Which self-hosted model should the on-prem judge use?',
    options: [
      ...choices.slice(0, 30).map((m) => ({ value: m.ref, label: `${m.displayName} (${m.provider})` })),
      { value: CUSTOM, label: 'Enter a custom self-hosted model reference (ollama/model, or a local alias)…' },
    ],
  })
  // io.select returns setup.ts's private CANCELLED symbol on Ctrl-C, not
  // exported for identity comparison here — `typeof pick !== 'string'` is
  // the correct guard regardless, since every real answer is a string.
  if (typeof pick !== 'string') {
    io.outro('Cancelled.')
    return
  }

  let modelRef = pick
  if (pick === CUSTOM) {
    const custom = await io.text({ message: 'Model reference (e.g. ollama/llama3.1, or a local alias like my-org/local-qwen)' })
    if (typeof custom !== 'string' || !custom.trim()) {
      io.outro('Cancelled.')
      return
    }
    modelRef = custom.trim()
    if (isHostedModelRef(modelRef)) {
      io.log.error(
        `'${modelRef}' is a hosted model. Judges run only on self-hosted models — use an Ollama model ` +
          'or an alias your own LiteLLM serves.',
      )
      io.outro('Nothing written.')
      return
    }
  }

  if (!findCatalogModel(modelRef)) {
    io.log.warn(`'${modelRef}' is not in the known model catalog — proceeding as a custom/local alias.`)
  }

  const yaml = buildLiteLLMConfigYaml(modelRef)
  const outPath = resolve(opts.out ?? './litellm_config.yaml')
  writeFileSync(outPath, yaml, 'utf-8')
  io.log.success(`Written to ${outPath}`)

  const { id: modelAlias } = normalizeModelRef(modelRef)
  const engineFile = join(opts.home ?? homedir(), ...DECIDE_ENGINE_FILE_PATH)
  writeDecideEngineFile(engineFile, engineUrl, modelAlias || modelRef)
  io.log.success(`Decide engine: ${modelAlias || modelRef} at ${engineUrl}, written to ${engineFile}`)

  io.note(envBlock(modelAlias || modelRef), 'Environment')
  io.note(helmSnippet(modelAlias || modelRef, outPath), 'Helm values')

  io.log.info(`Full walkthrough, including the optional typed stage: ${ON_PREM_JUDGE_DOCS}`)

  io.outro(pc.bold('Done. Apply the env/Helm values above, then restart the gateway.'))
}
