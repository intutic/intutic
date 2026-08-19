/**
 * jsSdkGatedAdapter.ts — shared builder for harness adapters whose blocking
 * gate ships SDK-side in `@intutic/gate` (packages/gate-js), with no on-disk
 * hook/config file to write a tool-call gate into.
 *
 * The JS/TS-native counterpart of `sdkGatedAdapter.ts` (Wave 1's Python
 * builder — see its module doc for why a shared factory exists instead of
 * hand-copying one adapter per framework: the same defect-generator argument
 * applies here). Two differences from the Python version drive most of this
 * file's shape:
 *
 *   1. **Manifest format.** Python's manifests (`pyproject.toml`,
 *      `requirements.txt`, `uv.lock`) are scanned as raw text for a
 *      case-insensitive substring/regex match. `package.json` is scanned as
 *      structured JSON — `dependencies`/`devDependencies`/`peerDependencies`
 *      — because a JS/TS framework detection needs a VERSION check (the
 *      Vercel AI SDK's `toolApproval` veto point is a v6+ API; the same
 *      package name existed at lower majors with a materially different
 *      surface), which a plain substring test cannot express.
 *   2. **The pointer comment.** Python frameworks point at
 *      `pip install intutic-clawde[...]` and a `from intutic_clawde...`
 *      import. These point at `npm install @intutic/gate` and an
 *      `import { ... } from '@intutic/gate/<subpath>'` line instead — the
 *      env file's prose says "your own Node.js process", not "your own
 *      Python process".
 *
 * @module
 */

import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'

const CONFIG_FILE = '.env.intutic'

/** One package.json dependency this framework requires to be detected.
 *  `minMajor`, when set, requires the declared range's leading version
 *  digits to be `>= minMajor` — a range this loose (`^7.0.0`, `~7.2.0`,
 *  `>=7.0.0`, a bare `7.0.0`) is exactly what real `package.json` files
 *  declare; anything the leading-digit scan cannot parse (`workspace:*`,
 *  `latest`, a git URL) is treated as NOT satisfying a `minMajor`
 *  requirement — silently assuming a floor is met is worse than asking the
 *  operator to pin a real version. */
export interface JsPackageRequirement {
  name: string
  minMajor?: number
}

export interface JsSdkGatedFrameworkSpec {
  /** HarnessType enum value this adapter detects/configures. */
  type: HarnessType
  /** Display name used in the generated comment, e.g. "Mastra". */
  label: string
  /** ALL of these must be present (and satisfy their `minMajor`, if set). */
  requires: readonly JsPackageRequirement[]
  /**
   * Additionally require at least one dependency whose name starts with
   * this prefix (e.g. `"@ai-sdk/"` for the Vercel AI SDK's provider
   * packages) — `ai` alone declares the tool-loop surface but ships no
   * model provider, so a workspace with `ai` and no `@ai-sdk/*` package
   * cannot actually call a model yet.
   */
  requiresPrefix?: string
  /** `npm install <npmInstall>` shown in the generated comment. */
  npmInstall: string
  /** The `@intutic/gate/<subpath>` import line shown in the comment. */
  importLine: string
  /** One line (no leading "# ") summarising how the imported symbol vetoes a call. */
  usageSummary: string
  /** apps/docs/integrations/<slug> */
  docsSlug: string
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

/**
 * Leading major version from a semver range string, without regex — plain
 * linear scans over the (short, locally-authored) range string, matching
 * `gate.ts`'s `trimTrailingSlashes`/`trimLeadingSlashes` style rather than
 * an unbounded-quantifier regex. Handles the common range prefixes
 * (`^`, `~`, `>=`, `<=`, `>`, `<`, `=`, a leading `v`, whitespace) by simply
 * skipping every non-digit character before the first digit run. Returns
 * `null` when no leading digit run exists at all (`"workspace:*"`,
 * `"latest"`, `"*"`, a git/URL range).
 */
export function leadingMajorVersion(range: string): number | null {
  let i = 0
  while (i < range.length && !isDigit(range[i]!)) i++
  let j = i
  while (j < range.length && isDigit(range[j]!)) j++
  if (j === i) return null
  return parseInt(range.slice(i, j), 10)
}

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function allDeps(manifest: PackageManifest): Record<string, string> {
  return { ...manifest.peerDependencies, ...manifest.devDependencies, ...manifest.dependencies }
}

/** Builds an `IHarnessAdapter` for one JS/TS SDK-gated framework from its spec. */
export function makeJsSdkGatedAdapter(spec: JsSdkGatedFrameworkSpec): IHarnessAdapter {
  return {
    type: spec.type,
    configFileName: CONFIG_FILE,

    async detect(workspaceRoot: string): Promise<boolean> {
      let manifest: PackageManifest
      try {
        const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf-8')
        manifest = JSON.parse(raw) as PackageManifest
      } catch {
        return false // no package.json, or unparseable — not a JS/TS workspace we can read
      }

      const deps = allDeps(manifest)

      for (const req of spec.requires) {
        const range = deps[req.name]
        if (range === undefined) return false
        if (req.minMajor !== undefined) {
          const major = leadingMajorVersion(range)
          if (major === null || major < req.minMajor) return false
        }
      }

      if (spec.requiresPrefix !== undefined) {
        const hasPrefixed = Object.keys(deps).some((name) => name.startsWith(spec.requiresPrefix!))
        if (!hasPrefixed) return false
      }

      return true
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
        '# Node.js process, where no config or hook file can gate them — the',
        '# blocking tool gate ships SDK-side:',
        `#   npm install ${spec.npmInstall}`,
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
