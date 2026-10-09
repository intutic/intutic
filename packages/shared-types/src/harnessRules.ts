/**
 * harnessRules.ts — where each harness reads standing instructions, and so
 * where `intutic connect` writes the rule sets aimed at it and the governed
 * decisions log.
 *
 * Every entry cites the product's own documentation or source. The CLI's
 * adapters write through this map, `rulesDelivery.test.ts` (tools/cli) checks
 * that each adapter writes its rule sets to the entry's file and to no other,
 * and the docs table "Where rule sets go" (guide/how-it-works.md) is checked
 * against it. A harness with no instructions file says so here, and the
 * dashboard and the docs show that instead of the rule sets vanishing.
 *
 * Shapes:
 * - `section`: a file the user also writes. The rule sets go between the
 *   INTUTIC:RULES markers and the decisions log between the
 *   INTUTIC:DECISIONS_LOG markers; the rest of the file is the user's.
 * - `file`: a file of Intutic's own, in a directory the product reads every
 *   file of; the decisions log gets a second file of its own there
 *   (`decisionsPath`), opening with the same activation front matter.
 * - `none`: the product reads no instructions file. Neither the rule-set text
 *   nor the decisions log reaches the model; the rules the gate compiles from
 *   rule sets (if the harness has a gate) still apply.
 *
 * No entry is `CLAUDE.md`: it is the team's own file, and under Claude Code's
 * default setting a project `CLAUDE.md` stops Claude Code reading `AGENTS.md`.
 *
 * @module
 */

import { HarnessType } from './enums.js'

export type HarnessRulesTarget =
  | {
      kind: 'section'
      /** Relative to the workspace root, or to the home directory when `scope` is `user`. */
      path: string
      scope: 'workspace' | 'user'
      /** The documentation or source that says the product loads it. */
      source: string
    }
  | {
      kind: 'file'
      /** Relative to the workspace root. */
      path: string
      scope: 'workspace'
      /** The decisions log's file, next to `path`. */
      decisionsPath: string
      /** The product's front matter that makes the file always apply, given the file's title; none when it needs none. */
      frontMatter?: (title: string) => string
      source: string
    }
  | {
      kind: 'none'
      /** Why there is no file, in a sentence a reader of the docs or dashboard can act on. */
      reason: string
      source?: string
    }

const section = (path: string, source: string): HarnessRulesTarget => ({ kind: 'section', path, scope: 'workspace', source })
const file = (
  path: string,
  decisionsPath: string,
  source: string,
  frontMatter?: (title: string) => string,
): HarnessRulesTarget => ({ kind: 'file', path, scope: 'workspace', decisionsPath, source, ...(frontMatter ? { frontMatter } : {}) })
const none = (reason: string, source?: string): HarnessRulesTarget => ({ kind: 'none', reason, ...(source ? { source } : {}) })

/**
 * `AGENTS.md`, the cross-tool instructions file (https://agents.md), shared by
 * every harness that reads it and has no file of its own to prefer.
 */
const agentsMd = (source: string) => section('AGENTS.md', source)

const SDK_REASON =
  'An SDK framework: the agent’s instructions are part of your code, so there is no file to write. The SDK gate enforces the rules compiled from your rule sets.'

const DELEGATED_REASON =
  'It runs other harnesses (Claude Code, Codex, ...), and each of them gets the rule sets through its own file.'

export const HARNESS_RULES_FILES: Readonly<Record<HarnessType, HarnessRulesTarget>> = {
  // `.claude/rules/*.md` without `paths:` front matter load at launch like
  // `.claude/CLAUDE.md`. Not `CLAUDE.md` itself: a project `CLAUDE.md` stops
  // Claude Code reading `AGENTS.md` under its default setting.
  [HarnessType.CLAUDE_CODE]: file(
    '.claude/rules/intutic-governance.md',
    '.claude/rules/intutic-decisions.md',
    'https://code.claude.com/docs/en/memory',
  ),
  // `.mdc` files with `alwaysApply: true`; `.cursorrules` is gone from the docs.
  [HarnessType.CURSOR]: file(
    '.cursor/rules/intutic-governance.mdc',
    '.cursor/rules/intutic-decisions.mdc',
    'https://cursor.com/docs/context/rules',
    (title) => `description: ${title}\nalwaysApply: true`,
  ),
  // `trigger: always_on`; `.windsurfrules` is the legacy single file.
  [HarnessType.WINDSURF]: file(
    '.windsurf/rules/intutic-governance.md',
    '.windsurf/rules/intutic-decisions.md',
    'https://docs.devin.ai/desktop/cascade/memories',
    () => 'trigger: always_on',
  ),
  // Gemini CLI reads `GEMINI.md` by default; Antigravity reads it and `AGENTS.md`.
  [HarnessType.ANTIGRAVITY]: section('GEMINI.md', 'https://antigravity.google/docs/rules'),
  // No file is loaded unless listed under `read:` in `.aider.conf.yml`, which
  // connect does with each file's absolute path.
  [HarnessType.AIDER]: file('.intutic/aider-sops.md', '.intutic/aider-decisions.md', 'https://aider.chat/docs/usage/conventions.html'),
  // A repository microagent with no triggers is always active.
  [HarnessType.OPENHANDS]: file(
    '.openhands/microagents/intutic-governance.md',
    '.openhands/microagents/intutic-decisions.md',
    'https://docs.openhands.dev/overview/skills',
  ),
  [HarnessType.CODEX]: agentsMd('https://learn.chatgpt.com/docs/agent-configuration/agents-md'),
  [HarnessType.MUSE_CODE]: agentsMd('https://dev.meta.ai/docs/muse-code/configuration'),
  [HarnessType.GROK]: agentsMd(
    'https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/prompt/agents_md.rs',
  ),
  [HarnessType.OPENCODE]: agentsMd('https://opencode.ai/docs/rules/'),
  [HarnessType.PI]: agentsMd(
    'https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/configuration.md',
  ),
  // A `.hermes.md` or `HERMES.md` between the working directory and the git
  // root takes the place of `AGENTS.md`.
  [HarnessType.HERMES]: agentsMd(
    'https://github.com/NousResearch/hermes-agent/blob/8ac5c74432d1f217033993c8370e911b2c91b04a/agent/prompt_builder.py',
  ),
  // `.roo/rules/` would hide a `.roorules` or `.clinerules` of the user's
  // (Roo reads those only while `.roo/rules/` is empty); `AGENTS.md` is read
  // unless `roo-cline.useAgentRules` is off.
  [HarnessType.ROO_CODE]: agentsMd(
    'https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/sections/custom-instructions.ts',
  ),
  [HarnessType.DEEPSEEK_HARNESS]: agentsMd(
    'https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/context/agent-instructions/README.md',
  ),
  [HarnessType.GITHUB_COPILOT]: section(
    '.github/copilot-instructions.md',
    'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
  ),
  // Every `.md` directly inside `.clinerules/`; no front matter means always active.
  [HarnessType.CLINE]: file(
    '.clinerules/intutic-governance.md',
    '.clinerules/intutic-decisions.md',
    'https://github.com/cline/cline/blob/fa840c741c3fc2eb49e7e0a4484895a99dae5cc5/docs/customization/cline-rules.mdx',
  ),
  // `alwaysApply: true`: the IDE extension and the `cn` CLI both apply it.
  [HarnessType.CONTINUE]: file(
    '.continue/rules/intutic-governance.md',
    '.continue/rules/intutic-decisions.md',
    'https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/docs/customize/deep-dives/rules.mdx',
    (title) => `name: ${title}\nalwaysApply: true`,
  ),
  [HarnessType.GOOSE]: section(
    '.goosehints',
    'https://github.com/block/goose/blob/0f4768025f517f5812f6d962a90aa52d509863cf/documentation/docs/guides/context-engineering/using-goosehints.md',
  ),
  // OpenClaw loads bootstrap files from its own agent workspace, never from
  // a project; connect writes to the one `agents.defaults.workspace` names.
  [HarnessType.OPENCLAW]: {
    kind: 'section',
    path: '.openclaw/workspace/AGENTS.md',
    scope: 'user',
    source: 'https://github.com/openclaw/openclaw/blob/98457908cf3e4fbbd0354b530e0aa0d15b560158/docs/concepts/agent-workspace.md',
  },
  [HarnessType.N8N]: none(
    'n8n loads no instructions file or setting: an AI Agent node’s system message is part of the workflow. The workflow gate enforces the rules compiled from your rule sets.',
  ),
  [HarnessType.CLAUDE_DESKTOP]: none('Claude Desktop keeps instructions in the app (project instructions), not in a file Intutic can write.'),
  [HarnessType.OPEN_WEBUI]: none('Open WebUI keeps system prompts in its own settings, not in a file Intutic can write.'),
  [HarnessType.XIRP]: none(DELEGATED_REASON),
  [HarnessType.AGENTIC_ORCHESTRATOR]: none(DELEGATED_REASON),
  [HarnessType.AGENTCORE_RUNTIME]: none('It hosts your own framework code; the framework’s SDK gate enforces the rules compiled from your rule sets.'),
  [HarnessType.TRUEFORGE_SERVER]: none('A server governed by the TrueForge bridge; it reads no instructions file.'),
  [HarnessType.LANGGRAPH]: none(SDK_REASON),
  [HarnessType.LANGCHAIN]: none(SDK_REASON),
  [HarnessType.CREWAI]: none(SDK_REASON),
  [HarnessType.AUTOGEN]: none(SDK_REASON),
  [HarnessType.AG2]: none(SDK_REASON),
  [HarnessType.GOOGLE_ADK]: none(SDK_REASON),
  [HarnessType.OPENAI_AGENTS]: none(SDK_REASON),
  [HarnessType.PYDANTIC_AI]: none(SDK_REASON),
  [HarnessType.SMOLAGENTS]: none(SDK_REASON),
  [HarnessType.STRANDS]: none(SDK_REASON),
  [HarnessType.AGENT_FRAMEWORK]: none(SDK_REASON),
  [HarnessType.MASTRA]: none(SDK_REASON),
  [HarnessType.VERCEL_AI_SDK]: none(SDK_REASON),
  [HarnessType.EVE]: none(SDK_REASON),
  [HarnessType.TRUEFORGE]: none(SDK_REASON),
  [HarnessType.AI_SDK_HARNESS]: none(SDK_REASON),
  [HarnessType.AI_SDK_WORKFLOW]: none(SDK_REASON),
}

/** The workspace-relative file a harness's rule sets go to; null when they go nowhere in the workspace. */
export function rulesFileOf(harness: HarnessType): string | null {
  const target = HARNESS_RULES_FILES[harness]
  return target && target.kind !== 'none' && target.scope === 'workspace' ? target.path : null
}

/** Every harness whose rule sets go to the workspace file `path`. */
export function harnessesReading(path: string): HarnessType[] {
  return (Object.keys(HARNESS_RULES_FILES) as HarnessType[]).filter((h) => rulesFileOf(h) === path)
}

/**
 * Where the governed decisions log goes for a harness: its own marked
 * section of a shared file, a file of its own next to the rules file, or
 * nowhere (null) when the product reads no instructions file.
 */
export function decisionsTargetOf(
  harness: HarnessType,
): { kind: 'section'; path: string; scope: 'workspace' | 'user' } | { kind: 'file'; path: string; frontMatter?: (title: string) => string } | null {
  const target = HARNESS_RULES_FILES[harness]
  if (!target || target.kind === 'none') return null
  if (target.kind === 'section') return { kind: 'section', path: target.path, scope: target.scope }
  return { kind: 'file', path: target.decisionsPath, ...(target.frontMatter ? { frontMatter: target.frontMatter } : {}) }
}

/** The front matter a harness's own rules files open with, given the file's title; '' when it needs none. */
export function rulesFrontMatterOf(harness: HarnessType, title: string): string {
  const target = HARNESS_RULES_FILES[harness]
  return target?.kind === 'file' && target.frontMatter ? target.frontMatter(title) : ''
}
