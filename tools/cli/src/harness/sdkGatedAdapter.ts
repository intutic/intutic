/**
 * sdkGatedAdapter.ts — shared builder for harness adapters whose blocking
 * gate ships SDK-side in intutic-clawde, with no on-disk hook/config file to
 * write a tool-call gate into.
 *
 * LangGraph was the first of this family (see langgraph.ts) and is left as a
 * hand-written adapter since it predates this file; every adapter added
 * since is built from this shared factory instead of being hand-copied.
 * Copy-pasting harness writers is a proven defect generator in this codebase
 * — see gateBody.ts's module doc for the four production defects traced to
 * divergent hand-copies of one piece of logic — so the detect/writeConfig
 * shape below is defined once and each framework supplies only what
 * distinguishes it: its manifest keywords and the comment text pointing
 * developers at its intutic-clawde adapter module.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'

const CONFIG_FILE = '.env.intutic'

/** Dependency manifests scanned by default — same three langgraph.ts uses. */
const DEFAULT_MANIFEST_FILES = ['pyproject.toml', 'requirements.txt', 'uv.lock'] as const

/**
 * A manifest match test. A plain string is a case-insensitive substring test
 * (fine for distinctive package names like "crewai" or "google-adk"); a
 * RegExp is tested against the lower-cased manifest content directly, for
 * names short enough to false-positive as a substring (e.g. "ag2" inside
 * "flag2" or a version string) — see ag2.ts.
 */
export type ManifestMatcher = string | RegExp

export interface SdkGatedFrameworkSpec {
  /** HarnessType enum value this adapter detects/configures. */
  type: HarnessType
  /** Display name used in the generated comment, e.g. "CrewAI". */
  label: string
  /** A manifest matching ANY of these is a detection hit. */
  keywords: readonly ManifestMatcher[]
  /** Dependency manifests scanned for a match. Defaults to the langgraph.ts set. */
  manifestFiles?: readonly string[]
  /**
   * `pip install <pipInstall>` shown in the generated comment — the extra
   * name included, e.g. `"intutic-clawde[crewai]"`. Bare `"intutic-clawde"`
   * for a framework with no dedicated adapter module yet (its tools are
   * governed through the framework-agnostic `@guard`/`guard_tools` helpers
   * in the meantime).
   */
  pipInstall: string
  /** The intutic_clawde.gate(.adapters.<x>) import line shown in the comment. */
  importLine: string
  /** One line (no leading "# ") summarising how the imported symbol vetoes a call. */
  usageSummary: string
  /** apps/docs/integrations/<slug> */
  docsSlug: string
}

function matches(content: string, keywords: readonly ManifestMatcher[]): boolean {
  const lower = content.toLowerCase()
  return keywords.some((k) => (typeof k === 'string' ? lower.includes(k) : k.test(lower)))
}

/** Builds an `IHarnessAdapter` for one SDK-gated framework from its spec. */
export function makeSdkGatedAdapter(spec: SdkGatedFrameworkSpec): IHarnessAdapter {
  const manifestFiles = spec.manifestFiles ?? DEFAULT_MANIFEST_FILES

  return {
    type: spec.type,
    configFileName: CONFIG_FILE,

    async detect(workspaceRoot: string): Promise<boolean> {
      for (const manifest of manifestFiles) {
        try {
          const content = await readFile(join(workspaceRoot, manifest), 'utf-8')
          if (matches(content, spec.keywords)) return true
        } catch { /* manifest not present */ }
      }
      return false
    },

    async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
      const filePath = join(workspaceRoot, CONFIG_FILE)
      const envContent = [
        '# Intutic Governance Rules (auto-generated)',
        '# DO NOT EDIT — managed by intutic sync daemon',
        `# Last sync: ${newIso()}`,
        '# Source this file: source .env.intutic',
        '',
        `export ANTHROPIC_BASE_URL="${proxyUrl}"`,
        `export OPENAI_BASE_URL="${proxyUrl}"`,
        `export INTUTIC_PROXY_URL="${proxyUrl}"`,
        `export INTUTIC_SOP_COUNT=${sops.length}`,
        '',
        `# These env vars govern LLM egress only. ${spec.label} tools run in your own`,
        '# Python process, where no config or hook file can gate them — the',
        '# blocking tool gate ships SDK-side:',
        `#   pip install ${spec.pipInstall}`,
        `#   ${spec.importLine}`,
        `# ${spec.usageSummary}`,
        `# See https://docs.intutic.ai/integrations/${spec.docsSlug}`,
        '',
      ].join('\n')

      await mkdir(dirname(filePath), { recursive: true })
      const tmpEnv = filePath + '.intutic-tmp'
      await writeFile(tmpEnv, envContent, 'utf-8')
      await rename(tmpEnv, filePath)

      return filePath
    },

    async readCurrentHash(workspaceRoot: string): Promise<string | null> {
      try {
        return await hashFile(join(workspaceRoot, CONFIG_FILE))
      } catch {
        return null
      }
    },
  }
}
