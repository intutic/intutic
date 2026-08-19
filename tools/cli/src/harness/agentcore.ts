/**
 * agentcore.ts — AWS Bedrock AgentCore Runtime adapter (detection-only, no
 * config file of its own).
 *
 * AgentCore (GA 2025-10) is a 13-module platform, not one thing. This
 * adapter covers exactly one module: **Runtime**, a managed hosting
 * environment that runs a customer's OWN agent code (any framework)
 * unchanged. Because it is just running the customer's own code, the
 * blocking tool-call gate is whichever ALREADY-SUPPORTED framework adapter
 * that code uses — Strands (strands.ts), LangGraph (langgraph.ts), CrewAI
 * (crewai.ts), etc. This adapter's `writeConfig` is therefore a no-op, the
 * same shape as xirp.ts/agenticOrchestrator.ts: it exists so
 * `intutic status`/`intutic init` can report "this workspace deploys to
 * AgentCore Runtime" and point at the deployment-target caveats documented
 * in apps/docs/integrations/agentcore.md (environment-variable caps, VPC/NAT
 * egress topology, Bedrock's SigV4 traffic not being proxyable) — none of
 * which belong in a repo-written file, since the actual proxy env vars are
 * already written by whichever inner framework's own adapter detects.
 *
 * UNLIKE Xirp/Agentic Orchestrator, Runtime does not spawn an
 * already-installed CLI harness as a subprocess — it hosts framework-SDK
 * code as a deployment target. If that code uses no framework this registry
 * supports (raw boto3, a hand-rolled tool loop), coverage is genuinely zero,
 * the same honest gap Agentic Orchestrator's OpenCode backend has (TD-397).
 *
 * # Detection signals (all live-verified against real published artifacts —
 * see packages/shared-types/src/enums.ts's HarnessType.AGENTCORE_RUNTIME doc
 * for exactly how)
 *
 * 1. `bedrock-agentcore` in a Python manifest (pyproject.toml/
 *    requirements.txt/uv.lock) — the PyPI SDK package (CONFIRMED 1.22.0).
 * 2. `bedrock-agentcore-starter-toolkit` in a Python manifest — the optional
 *    CLI/dev-loop toolkit (CONFIRMED 0.3.11); a weaker signal than #1 since a
 *    project can depend on the SDK without the starter toolkit, but not the
 *    reverse in practice.
 * 3. `bedrock-agentcore` or `@aws/agentcore` in package.json dependencies —
 *    the npm TypeScript SDK (CONFIRMED 0.4.3) and CLI (CONFIRMED 0.27.0).
 * 4. `.bedrock_agentcore.yaml` at the workspace root — the config file the
 *    Python starter toolkit's `agentcore configure`/`agentcore launch`
 *    commands write (confirmed via `bedrock_agentcore_starter_toolkit/cli/
 *    runtime/_configure_impl.py` and every other CLI subcommand module that
 *    reads it).
 * 5. `agentcore/agentcore.json` or `aws-targets.json` at the workspace root —
 *    the config files the npm `@aws/agentcore` CLI writes (confirmed via the
 *    literal strings in the published `dist/cli/index.mjs` bundle).
 *
 * No ReDoS surface: every check below is a plain substring/property test
 * over locally-read files, never a regex over untrusted network input.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'

/** Python manifests scanned for the SDK/toolkit package names. */
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'uv.lock'] as const

/** Config files the `agentcore` CLIs (npm + Python starter toolkit) write. */
const CONFIG_FILE_SIGNALS = ['.bedrock_agentcore.yaml', 'agentcore/agentcore.json', 'aws-targets.json'] as const

async function hasAnyConfigFile(workspaceRoot: string): Promise<boolean> {
  for (const rel of CONFIG_FILE_SIGNALS) {
    try {
      await access(join(workspaceRoot, rel))
      return true
    } catch {
      /* not here */
    }
  }
  return false
}

async function hasPythonManifestSignal(workspaceRoot: string): Promise<boolean> {
  for (const manifest of PYTHON_MANIFESTS) {
    try {
      const content = (await readFile(join(workspaceRoot, manifest), 'utf-8')).toLowerCase()
      if (content.includes('bedrock-agentcore') || content.includes('bedrock_agentcore')) return true
    } catch {
      /* manifest not present */
    }
  }
  return false
}

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function hasNodeManifestSignal(workspaceRoot: string): Promise<boolean> {
  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf-8')
    const manifest = JSON.parse(raw) as PackageManifest
    const deps = { ...manifest.peerDependencies, ...manifest.devDependencies, ...manifest.dependencies }
    return 'bedrock-agentcore' in deps || '@aws/agentcore' in deps
  } catch {
    return false // no package.json, or unparseable
  }
}

export const agentcoreAdapter: IHarnessAdapter = {
  type: HarnessType.AGENTCORE_RUNTIME,
  // No config file of its own — see module doc. The proxy env vars a
  // customer's deployed agent needs are already written by whichever inner
  // framework's own adapter (strands.ts, langgraph.ts, ...) detects.
  configFileName: '',

  async detect(workspaceRoot: string): Promise<boolean> {
    if (await hasAnyConfigFile(workspaceRoot)) return true
    if (await hasPythonManifestSignal(workspaceRoot)) return true
    return hasNodeManifestSignal(workspaceRoot)
  },

  // AgentCore Runtime introduces no config format of its own to gate — see
  // module doc. Nothing to write; whichever inner framework's own adapter is
  // present (if any) is what writes real governance content.
  async writeConfig(_workspaceRoot: string, _sops: SyncSopEntry[], _proxyUrl: string): Promise<string | null> {
    return null
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    return null
  },
}
