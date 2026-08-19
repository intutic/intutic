/**
 * `intutic predict-cost` — pre-flight cost estimate for a prompt/task, before
 * it runs.
 *
 * Deliberately a CLI command and not a dashboard widget: cost prediction is
 * useful at the moment a prompt or task is *about to* run, which is the
 * CLI/SDK context (a developer or an agent harness deciding what to send),
 * not dashboard browsing after the fact. It calls `POST /api/v1/predict-cost`
 * (`services/control-plane/src/routes/intelligence.ts`), which estimates
 * output tokens from the workspace's own Valkey-backed baseline (falling
 * back to a per-model default multiplier under 3 samples) and prices the
 * result with `ProviderPricingService` — the same DB-backed rate table (with
 * a parity-gated static fallback) every other cost figure in the control
 * plane uses, not a private copy.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient, type ApiClient } from '../lib/api.js'
import pc from 'picocolors'

// ─── Types (mirror tokenIntelligenceService.ts's CostPrediction) ──────────

export interface CostPrediction {
  inputTokens: number
  estimatedOutputTokens: number
  estimatedReasoningTokens: number | null
  estimatedCostUsd: number
  confidence: 'high' | 'medium' | 'low'
  basedOnSamples: number
}

interface PredictCostOpts {
  model?: string
  taskType?: string
  tokens?: string
  file?: string
  json?: boolean
  dev?: boolean
}

// ─── Shared client resolution ──────────────────────────────────────────────

async function getClientAndWorkspace(
  opts: PredictCostOpts,
): Promise<{ client: ApiClient; workspaceId: string }> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(
      'Not authenticated. This command needs an Intutic control plane, which open core does not include. To run the proxy without one: `intutic start`.',
    )
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  return { client: createApiClient(controlPlaneUrl, creds.apiKey), workspaceId: creds.workspaceId }
}

// ─── Formatting ─────────────────────────────────────────────────────────

function formatConfidence(confidence: CostPrediction['confidence']): string {
  switch (confidence) {
    case 'high':
      return pc.green('high')
    case 'medium':
      return pc.yellow('medium')
    case 'low':
      return pc.dim('low')
  }
}

/**
 * `intutic predict-cost --model <m> [--task-type t] [--tokens n | --file f]`
 *
 * `--tokens` and `--file` are mutually exclusive input-size sources, and one
 * of them is required client-side before any request is made — an empty
 * `inputText`/`inputTokenCount` pair would silently estimate against zero
 * input tokens, which is not a prediction, it's a wrong number with a
 * confident shape.
 */
export async function runPredictCost(opts: PredictCostOpts): Promise<void> {
  if (!opts.model || opts.model.trim().length === 0) {
    log.error('--model is required (e.g. --model claude-sonnet-4-5).')
    process.exit(1)
  }

  if (opts.tokens && opts.file) {
    log.error('--tokens and --file are mutually exclusive — pass exactly one.')
    process.exit(1)
  }

  if (!opts.tokens && !opts.file) {
    log.error('One of --tokens <n> or --file <path> is required to size the input.')
    process.exit(1)
  }

  let inputTokenCount: number | undefined
  let inputText: string | undefined

  if (opts.tokens) {
    const parsed = Number(opts.tokens)
    if (!Number.isFinite(parsed) || parsed < 0) {
      log.error(`--tokens must be a non-negative number, got: ${opts.tokens}`)
      process.exit(1)
    }
    inputTokenCount = Math.round(parsed)
  } else if (opts.file) {
    try {
      inputText = await fs.readFile(opts.file, 'utf-8')
    } catch (err) {
      log.error(`Could not read --file ${opts.file}: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  const model = opts.model.trim()
  const taskType = opts.taskType?.trim() || 'coding'

  const { client, workspaceId } = await getClientAndWorkspace(opts)

  try {
    const prediction = await client.post<CostPrediction>('/api/v1/predict-cost', {
      workspaceId,
      model,
      inputTokenCount,
      inputText,
      taskType,
    })

    if (opts.json) {
      console.log(JSON.stringify(prediction, null, 2))
      return
    }

    log.header('Intutic — Cost Prediction')
    log.field('Model', model)
    log.field('Task type', taskType)
    console.log('')
    log.field('Input tokens', prediction.inputTokens.toLocaleString())
    log.field('Estimated output tokens', prediction.estimatedOutputTokens.toLocaleString())
    log.field(
      'Estimated reasoning tokens',
      prediction.estimatedReasoningTokens != null
        ? prediction.estimatedReasoningTokens.toLocaleString()
        : pc.dim('none'),
    )
    console.log('')
    log.field('Estimated cost', pc.bold(`$${prediction.estimatedCostUsd.toFixed(6)}`))
    log.field('Confidence', formatConfidence(prediction.confidence))
    log.field(
      'Based on',
      prediction.basedOnSamples > 0
        ? `${prediction.basedOnSamples} prior sample(s)`
        : pc.dim('no baseline — default per-model multiplier'),
    )
  } catch (err) {
    log.error(`Failed to predict cost: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
