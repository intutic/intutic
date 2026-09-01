/**
 * Domain enums for the Intutic governance platform.
 *
 * Each enum is defined as a frozen `as const` object with a corresponding
 * TypeScript union type extracted via `typeof Obj[keyof typeof Obj]`.
 * This pattern gives us runtime values (for comparisons, iteration) and
 * compile-time narrowing without Drizzle or Postgres dependencies.
 *
 * These mirror the Postgres enum types defined in
 * LLD 01-data-architecture §3.1.
 *
 * @module
 */

// ─── Risk Level ──────────────────────────────────────────────────────
// HLD §3.5, LLD §3.1 — risk_level enum

/** Risk severity classification for SOPs, anomalies, and incidents. */
export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const

/** Union of all risk level values. */
export type RiskLevel = typeof RiskLevel[keyof typeof RiskLevel]

// ─── Enforcement Action ──────────────────────────────────────────────
// HLD §3.3, LLD §3.1 — enforcement_action_type enum

/**
 * PCAS enforcement action applied to a tool call.
 *
 * BYPASS..KILL are listed in increasing severity. `REASK` sits between
 * `HIJACK` and `KILL`: the attempt is refused and the reason handed back to
 * the agent, which may retry a bounded number of times before the finding
 * escalates to a block.
 *
 * It exists because the proxy's promotion rule
 * (`packages/proxy/src/plugins/anomaly/mod.rs`) forbids a heuristic from
 * killing until its false-positive rate has been measured, and five detectors
 * were doing exactly that. Demoting them to `HIJACK` would have honoured the
 * rule and lost the enforcement; `REASK` keeps both.
 *
 * Mirrors `enforcement_action_type` — see migration 114.
 *
 * `OBSERVED` (migration 156) is deliberately OUTSIDE that severity ladder —
 * it does not mean "PCAS acted with this severity", it means "PCAS took no
 * action because the request never produced a response to act on". It is
 * `mapVerdict`'s (`services/control-plane/src/lib/valkeySubscriber.ts`)
 * target for the proxy's `"upstream_error"` verdict — a provider 5xx or an
 * unservable-model rejection. Before this value existed, `mapVerdict`'s
 * fail-closed default mapped every unrecognised verdict to `KILL`, so every
 * upstream_error trace was recorded as an enforcement block that never
 * happened: an honest failure record read as PCAS having stopped the
 * request. `BYPASS` was considered and rejected for the same reason in the
 * other direction — it means the call went through and completed, which an
 * upstream_error trace never did. Nothing existing fit, so this is the
 * smallest addition that lets "PCAS did not enforce anything here, the
 * provider itself failed" be recorded truthfully.
 */
export const EnforcementAction = {
  BYPASS: 'BYPASS',
  ENHANCE: 'ENHANCE',
  HIJACK: 'HIJACK',
  REASK: 'REASK',
  KILL: 'KILL',
  OBSERVED: 'OBSERVED',
} as const

/** Union of all enforcement action values. */
export type EnforcementAction = typeof EnforcementAction[keyof typeof EnforcementAction]

// ─── Token Utility ───────────────────────────────────────────────────
// HLD §3.6, LLD §3.1 — token_utility_type enum

/** Classification of whether a token expenditure was useful or wasted. */
export const TokenUtility = {
  USEFUL: 'USEFUL',
  WASTED: 'WASTED',
} as const

/** Union of all token utility values. */
export type TokenUtility = typeof TokenUtility[keyof typeof TokenUtility]

// ─── Budget Tier ─────────────────────────────────────────────────────
// HLD §3.3, LLD §3.1 — budget_tier_type enum

/** Budget authority level assigned to a user or agent session. */
export const BudgetTier = {
  JUNIOR: 'JUNIOR',
  SENIOR: 'SENIOR',
  STAFF: 'STAFF',
  PRINCIPAL: 'PRINCIPAL',
} as const

/** Union of all budget tier values. */
export type BudgetTier = typeof BudgetTier[keyof typeof BudgetTier]

// ─── Complexity Tier ─────────────────────────────────────────────────
// HLD §3.4, LLD §3.1 — complexity_tier enum

/** Task complexity classification for model routing. */
export const ComplexityTier = {
  TIER_0: 'TIER_0',
  TIER_1: 'TIER_1',
  TIER_2: 'TIER_2',
} as const

/** Union of all complexity tier values. */
export type ComplexityTier = typeof ComplexityTier[keyof typeof ComplexityTier]

// ─── Change Classification ──────────────────────────────────────────
// HLD §3.4, LLD §3.1 — change_classification enum

/** Classification of how an SOP change affects the prior version. */
export const ChangeClassification = {
  STRENGTHEN: 'STRENGTHEN',
  CLARIFY: 'CLARIFY',
  NARROW: 'NARROW',
  WEAKEN: 'WEAKEN',
} as const

/** Union of all change classification values. */
export type ChangeClassification = typeof ChangeClassification[keyof typeof ChangeClassification]

// ─── Anomaly Type ────────────────────────────────────────────────────
// HLD §3.5, LLD §3.1 — anomaly_type enum (12-category runtime taxonomy)

/**
 * Runtime anomaly classification taxonomy.
 *
 * Re-exported from `@intutic/anomaly-taxonomy`, which is the source of truth.
 * It lives in its own package because the Rust proxy declares the same twelve
 * categories — the hot path cannot call into TypeScript — and the proxy's
 * tests parse that package to fail the build if the two ever diverge.
 *
 * Re-exported rather than redeclared so this file cannot become a third copy.
 */
export { AnomalyType } from '@intutic/anomaly-taxonomy'
export type {
  AnomalySeverity,
} from '@intutic/anomaly-taxonomy'

// ─── Harness Type ────────────────────────────────────────────────────
// HLD §3.14, §4.5 — Supported AI agent harness integrations
// Full matrix: HLD §3.14 Harness Onboarding Matrix (31 harnesses — 21
// hook/config-gated (19 base + Muse Code + Grok Build) + LangGraph +
// Wave 1's 8 SDK-gated Python frameworks + Xirp + Agentic Orchestrator —
// the two harnesses with no gate/config format of their own because they
// WRAP other already-gated harnesses rather than running tools themselves;
// see gateKind.ts's 'delegated' kind and gateRegistry.ts's NO_GATE rows for
// 'xirp' and 'agentic-orchestrator')

/** Supported AI agent harness/IDE integrations. */
export const HarnessType = {
  CURSOR: 'cursor',
  CLAUDE_CODE: 'claude-code',
  ANTIGRAVITY: 'antigravity',
  N8N: 'n8n',
  CODEX: 'codex',
  WINDSURF: 'windsurf',
  AIDER: 'aider',
  OPENHANDS: 'openhands',
  OPENCLAW: 'openclaw',
  HERMES: 'hermes',
  PI: 'pi',
  CLINE: 'cline',
  ROO_CODE: 'roo-code',
  CONTINUE: 'continue',
  CLAUDE_DESKTOP: 'claude-desktop',
  GOOSE: 'goose',
  OPEN_WEBUI: 'open-webui',
  GITHUB_COPILOT: 'github-copilot',
  LANGGRAPH: 'langgraph',
  /** Meta "Muse Code" — binary `muse`, model Muse Spark. Beta since 2026-08-05. */
  MUSE_CODE: 'muse-code',
  /** xAI Grok Build (binary `grok`, GA 2026-05, open-sourced 2026-07-15). */
  GROK: 'grok',
  /** DeepSeek's "dsh" (binary `dsh`, `@deepseek-ai/dsh`). Developer preview
   *  since 2026-08-13; gated via a Cordis plugin (`@intutic/gate/dsh`), not a
   *  generated hook file — see gateRegistry.ts's `dsh` row. */
  DEEPSEEK_HARNESS: 'dsh',
  /**
   * Spotify "Xirp" — macOS-only desktop orchestrator, beta since 2026-08-11.
   * NOT itself an AI agent: it spawns already-installed CLI harnesses
   * (Claude Code, Codex, Gemini CLI) each inside its own tmux session and
   * `git worktree`, preserving each wrapped harness's native, unmodified
   * config (per Xirp's own FAQ). Detected for reporting/reconciliation
   * purposes only — see `tools/cli/src/harness/xirp.ts` and
   * `gateRegistry.ts`'s NO_GATE row for why it writes no config of its own.
   */
  XIRP: 'xirp',
  /**
   * DoorDash's "Agentic Orchestrator" (binary `agentico`, Go, Apache-2.0,
   * `doordash-oss/agentic-orchestrator` — CONFIRMED real/public: live-verified
   * by running the actual released binary, not just reading its README).
   * Desktop app + CLI, cross-platform (macOS AND Linux — unlike Xirp's
   * macOS-only beta). NOT itself an AI agent: it wraps already-installed CLI
   * backends — Claude Code, Codex, and OpenCode (CONFIRMED via `agentico
   * server --help`'s `--providers` flag) — each running a feature in its own
   * `git worktree` under `~/.agentic-orchestrator/worktrees/` (CONFIRMED via
   * the project's own README). Detected for reporting/reconciliation
   * purposes only — see `tools/cli/src/harness/agenticOrchestrator.ts` and
   * `gateRegistry.ts`'s NO_GATE row for why it writes no config of its own
   * (`GateKind: 'delegated'`, same as Xirp).
   *
   * UNLIKE Xirp, one of its three wrapped backends is NOT itself a supported
   * Intutic harness: OpenCode has no adapter/gate anywhere in this registry.
   * A feature run against the `opencode:` provider therefore has ZERO
   * Intutic governance today, even though Claude Code- and Codex-backed
   * features are fully covered by their own existing gates. This is a real
   * gap, not merely unconfirmed — see TD-397.
   */
  AGENTIC_ORCHESTRATOR: 'agentic-orchestrator',
  // ─── Wave 1: Python-SDK-gated frameworks (no on-disk hook/config file) ───
  // Same family as LANGGRAPH: the blocking gate ships in intutic-clawde
  // (intutic_clawde.gate, python-raise contract), evaluated in-process before
  // the tool body runs. This adapter writes .env.intutic (proxy base-URL vars
  // only) — see gateRegistry.ts NO_GATE rows and harness/gateKind.ts.
  /** LangChain — covers BOTH the Python (`langchain`/`langchain-core`) and
   *  JS/TS (`langchain` npm package) ecosystems for detection purposes, since
   *  the framework itself ships in both. This env-adapter (`langchain.ts`) is
   *  Python-only, matching intutic-clawde's `langchain.py` gate adapter; a
   *  JS/TS tool-call gate for LangChain.js is a `@intutic/gate` TypeScript
   *  package concern for a different phase, not this one. */
  LANGCHAIN: 'langchain',
  CREWAI: 'crewai',
  /** Detected via any of autogen-agentchat / autogen-core / autogen-ext. */
  AUTOGEN: 'autogen',
  AG2: 'ag2',
  GOOGLE_ADK: 'google-adk',
  /** OpenAI Agents SDK — covers BOTH the Python (`openai-agents` on PyPI)
   *  and JS/TS (`@openai/agents` on npm) ecosystems, same dual-ecosystem
   *  pattern as LANGCHAIN above — but unlike LangChain, BOTH sides have a
   *  shipped gate: Python via `intutic_clawde.gate.adapters.openai_agents`
   *  (`intutic_tool_guardrail`), TypeScript via `@intutic/gate/openai`
   *  (packages/gate-js — tool input guardrails, `wrapAgent()` for
   *  mcpServers-derived tools, and the tracing-exporter DLP kill-switch).
   *  Detection (`tools/cli/src/harness/openaiAgents.ts`) matches Python
   *  manifests AND package.json `@openai/agents*` deps. */
  OPENAI_AGENTS: 'openai-agents',
  /** Detected via pydantic-ai / pydantic-ai-slim. */
  PYDANTIC_AI: 'pydantic-ai',
  SMOLAGENTS: 'smolagents',
  /** AWS Strands Agents (`strands-agents` on PyPI — the default framework in
   *  Bedrock AgentCore's own quickstarts). Detected via `strands-agents` in
   *  Python dependency manifests. Gate: `intutic_clawde.gate.adapters.strands`'s
   *  `IntuticHookProvider`, built on Strands' documented
   *  `BeforeToolCallEvent.cancel_tool` veto (verified against a real
   *  strands-agents==1.52.0 install). NOTE: the framework's DEFAULT model
   *  provider (Bedrock, SigV4-signed via boto3) is NOT routable through the
   *  Intutic proxy — see apps/docs/integrations/strands.md. */
  STRANDS: 'strands',
  // ─── T2: JS/TS SDK-gated frameworks (no on-disk hook/config file) ───────
  // Same family as LANGCHAIN/LANGGRAPH above, but JS/TS-native: the blocking
  // gate ships in @intutic/gate (packages/gate-js), a subpath adapter per
  // framework, evaluated in-process before the tool body runs. This
  // env-adapter writes .env.intutic (proxy base-URL vars only — see
  // gateRegistry.ts NO_GATE rows) — see also configWriter.ts's HARNESS_FILES.
  /** Detected via `@mastra/core`/`mastra` in `package.json`. Gate:
   *  `@intutic/gate/mastra`'s `intuticHooks()` — see that module's doc for
   *  the per-call-hooks-override bypass this framework's own design imposes. */
  MASTRA: 'mastra',
  /** Detected via `ai` (v6+) plus any `@ai-sdk/*` package in `package.json`.
   *  Gate: `@intutic/gate/vercel`'s `intuticToolApproval()`. Unlike most
   *  harnesses here, this framework has NO env-var LLM-egress routing — see
   *  `@intutic/gate/vercel`'s `withIntuticProxy()` and its module doc. */
  VERCEL_AI_SDK: 'vercel-ai-sdk',
  /** Vercel's "eve" (npm `eve`, github.com/vercel/eve) — filesystem-first
   *  durable backend AI agents; an agent is an `agent/` directory eve builds
   *  by walking the tree. Pre-1.0 PREVIEW (0.39.x). Detected via `eve` in
   *  `package.json` PLUS the characteristic `agent/` directory (a compound
   *  check — either alone is too generic; see tools/cli/src/harness/eve.ts).
   *  Gate: `@intutic/gate/eve`'s `intuticApproval()` on eve's per-tool /
   *  per-connection `approval` policy surface — see gateRegistry.ts's `eve`
   *  row and TD-410 for the preview-churn shield. */
  EVE: 'eve',
  /**
   * TrueFoundry's "TrueForge" (github.com/truefoundry/trueforge, MIT,
   * TS/Node) — an open-source agent-runtime library. Same JS/TS SDK-gated
   * family as MASTRA/VERCEL_AI_SDK/EVE above, but TrueForge ships in two
   * structurally different deployment modes with different detection and
   * different governance surfaces, so it gets two `HarnessType` rows rather
   * than one (see TRUEFORGE_SERVER's own doc below for why one enum value
   * can't answer `gateKindForHarness` two ways). THIS row
   * covers only the EMBEDDED mode: another team's Node process importing
   * `@truefoundry/trueforge-core` directly and driving its
   * `SessionHandle`/`TurnHandle` API in-process. Detected via
   * `@truefoundry/trueforge-core` in `package.json`. Gate:
   * `@intutic/gate/trueforge`'s `intuticApprovalResponder()` — confirmed
   * against the real published package (`@truefoundry/trueforge-core@0.1.4`)
   * that there is NO synchronous in-process approval callback anywhere in
   * it; the only approval mechanism, embedded or not, is the same
   * `tool.approval_required` / `user.tool_approval` turn-and-event contract
   * TrueForge's standalone server exposes over HTTP, so this adapter is
   * shaped like the AI_SDK_HARNESS/AI_SDK_WORKFLOW "approval responder"
   * family rather than MASTRA/VERCEL_AI_SDK's single-callback shape — see
   * that module's doc for the full record.
   *
   * TrueForge run as its OWN standalone/hosted server (`npx
   * @truefoundry/trueforge`, Docker Compose, or the Helm chart) is
   * deliberately NOT covered by this row — nobody embeds an Intutic gate
   * into a third-party OSS server process, so that deployment mode needs
   * governance running in an external Intutic-operated bridge service. See
   * TRUEFORGE_SERVER below.
   */
  TRUEFORGE: 'trueforge',
  // ─── A3: Vercel platform-agent runtimes (JS/TS SDK-gated, gate-js) ──────
  // Same family as MASTRA/VERCEL_AI_SDK, but the tool-execution model
  // differs enough to matter: harness tools run SERVER-SIDE in Vercel
  // Sandbox microVMs (the laptop proxy never sees sandbox egress), and
  // workflow tools run inside a DURABLE runtime that retries thrown errors
  // (refusals must be FatalError-compatible). See each adapter's module doc.
  /** Vercel `@ai-sdk/harness` (HarnessAgent — sandboxed coding-agent
   *  harnesses, e.g. `@ai-sdk/harness-claude-code`/`-grok-build`). Detected
   *  via `@ai-sdk/harness`, any `@ai-sdk/harness-*` adapter, or any
   *  `@ai-sdk/sandbox-*` provider in `package.json`. Gate:
   *  `@intutic/gate/harness`'s approval responder — the framework's
   *  `toolApproval` setting is a STATIC record without callback support, so
   *  per-call gating routes through the tool-approval flow; built-in sandbox
   *  tools are governed only by `permissionMode`, which DEFAULTS to
   *  'allow-all'. See gateRegistry.ts's NO_GATE row and TD-415..417. */
  AI_SDK_HARNESS: 'ai-sdk-harness',
  /** Vercel `@ai-sdk/workflow` (WorkflowAgent — durable workflow agents on
   *  the Workflow DevKit). Detected via `@ai-sdk/workflow` in `package.json`
   *  (the unscoped `workflow` package alone is deliberately NOT a trigger —
   *  it is the durable runtime with no agent surface, and the bare name is
   *  too generic). Gate: `@intutic/gate/workflow`'s `intuticNeedsApproval()`
   *  on each tool — WorkflowAgent itself has zero approval fields; refusals
   *  are FatalError-compatible so the durable runtime aborts rather than
   *  retry-looping a governance denial. See gateRegistry.ts's NO_GATE row
   *  and TD-418..419. */
  AI_SDK_WORKFLOW: 'ai-sdk-workflow',
  // ─── B2: AWS Bedrock AgentCore ───────────────────────────────────────────
  /**
   * AWS Bedrock AgentCore **Runtime** (GA 2025-10) — a managed hosting
   * environment for a customer's OWN agent code (any framework), NOT itself
   * an agent framework. Detected via the `bedrock-agentcore` SDK (PyPI
   * `bedrock-agentcore`, CONFIRMED at 1.22.0; npm `bedrock-agentcore`,
   * CONFIRMED at 0.4.3 — both live-checked via `pip index versions`/`npm
   * view` and by downloading and inspecting the real packages, not assumed)
   * OR the local dev-loop config files the `agentcore` CLI (npm
   * `@aws/agentcore`, CONFIRMED at 0.27.0) and the Python
   * `bedrock-agentcore-starter-toolkit` (CONFIRMED at 0.3.11) write:
   * `.bedrock_agentcore.yaml`, `agentcore/agentcore.json`, `aws-targets.json`
   * — all three confirmed by extracting the real published tarballs/wheels
   * and grepping their compiled/source output for the literal filenames.
   *
   * Classified `'delegated'` (see `gateKind.ts`), the SAME kind as XIRP and
   * AGENTIC_ORCHESTRATOR, for an analogous but distinct reason: Runtime
   * hosts the customer's chosen framework's code UNCHANGED, so a tool call
   * made inside it is governed by whichever already-supported framework
   * adapter that code uses (Strands, LangGraph, CrewAI, ...) — this
   * adapter's own `writeConfig` is a no-op, same as Xirp/Agentic
   * Orchestrator's. Unlike those two, Runtime does not SPAWN another
   * already-installed CLI harness as a subprocess; it hosts a customer's
   * framework-SDK code as the deployment target, so if that code uses no
   * framework this registry supports (raw boto3, a hand-rolled tool loop),
   * coverage is genuinely zero — the same honest gap AGENTIC_ORCHESTRATOR's
   * OpenCode backend has (TD-397). Deployment-target constraints that are
   * NOT a gate concern (environment-variable caps, VPC/NAT egress topology,
   * SigV4 traffic not being proxyable) are documented in
   * apps/docs/integrations/agentcore.md rather than encoded here.
   *
   * AgentCore **Gateway** (the MCP-tool-call interceptor path) deliberately
   * has NO enum entry here — same precedent QM set (see TD-400): it is a
   * deployed AWS resource (a Lambda attached to a Gateway), never something
   * `intutic init`/`intutic connect` finds on a developer's laptop. Its
   * coverage is the `tools/agentcore-interceptor` Lambda calling
   * `POST /api/v1/integrations/agentcore/gateway-check` — see TD-430.
   *
   * AgentCore **Policy** (Cedar/"Dogwood") has NO third-party HTTP policy
   * backend at all (confirmed against `GatewayPolicyEngineConfiguration`'s
   * real API reference: `arn` only ever names an AWS-native
   * `policy-engine/...` resource) — not integrable by design, not a gap.
   *
   * See apps/docs/integrations/agentcore.md and TD-430..432.
   */
  AGENTCORE_RUNTIME: 'agentcore-runtime',
  // ─── B3: TrueForge, standalone/hosted server (bridge-gated) ─────────────
  /**
   * TrueFoundry's "TrueForge" (github.com/truefoundry/trueforge, MIT,
   * TS/Node), run as its OWN standalone/hosted server process — `npx
   * @truefoundry/trueforge`, its Docker Compose stack, or its Helm chart —
   * rather than embedded into another team's Node process (see TRUEFORGE
   * above for that mode). Not detected by `intutic init`'s repo scan: there
   * is no per-repo `package.json` dependency or config file to find, because
   * this is an operator-configured DEPLOYMENT, not a library dependency of
   * whatever repo `intutic init` happens to run against. An operator points
   * `services/trueforge-bridge` at their running instance instead — see
   * that service's README and `apps/docs/integrations/trueforge.md`'s
   * server-mode section.
   *
   * Gate: classified `'bridge'` (see `gateKind.ts`), a shape distinct from
   * every other row in this enum. TrueForge exposes exactly one tool-call
   * governance surface, embedded or standalone alike (see TRUEFORGE's own
   * doc for how this was confirmed against the real package): a turn pauses
   * with a `tool.approval_required` event naming each pending call only as
   * `{id, source_event_id}`, resolved by starting a NEW turn
   * (`POST /{session_id}/turns`, `previous_turn_id` chained) carrying a
   * `user.tool_approval` input item. Nobody embeds an Intutic gate into a
   * third-party OSS server process, so unlike TRUEFORGE this mode cannot be
   * `'sdk'` — there is no host process of ours to run in. It also is not
   * `'hook'` (no on-disk file this deployment reads) or `'delegated'` (it
   * does not wrap another already-gated harness). The gate instead runs OUT
   * OF PROCESS, in `services/trueforge-bridge` — an Intutic-operated service
   * that watches each session's turn/event stream (SSE subscribe, or
   * `listTurnEventsRoute` polling as a fallback; there is no webhook —
   * TrueForge never pushes anything to an external system), resolves a
   * pending call's `source_event_id` back to the real tool name and
   * arguments via the referenced `model.message` event, evaluates it through
   * the same `packages/gate-js` machinery every other JS/TS-native row here
   * uses (`soprules.ts`'s `ruleMatches` plus `POST /api/v1/hook-gate`), and
   * answers with `{status:'allow'}` or `{status:'deny', reason}`.
   *
   * The load-bearing caveat, stated plainly rather than buried: whether a
   * tool call ever emits `tool.approval_required` in the first place is
   * controlled by each registered MCP server's own approval-tool-selector
   * config (`McpServerApprovalToolSelector`: `"@all" | "@write" |
   * "@destructive" | <tool name>`). A narrow/default selector means some
   * tool calls never pause and are invisible to the bridge — this is
   * TrueForge's own design, not something this gate kind can work around.
   * See `apps/docs/reference/harness-security-matrix.md` row 42 and
   * `apps/docs/integrations/trueforge.md`'s server-mode section for the full
   * scoping statement, including how this Hook(A) trust shape — the gate
   * co-resident in a wholly SEPARATE process reacting to a pull-only event
   * stream — is weaker than every other Hook(A) mark in this catalog, all
   * of which run co-resident with or embedded in the harness's own process.
   */
  TRUEFORGE_SERVER: 'trueforge-server',
} as const

/** Union of all harness type values. */
export type HarnessType = typeof HarnessType[keyof typeof HarnessType]

/**
 * The real count of `HarnessType` members — one number, exported so no doc
 * or README prose ever has to state it by hand again (Wave 8,
 * audit-remediation). `check-harness-counts.js` (`lint:claims`) asserts
 * every harness-count claim in `apps/docs/**` and `README.md` matches
 * either this or `HARNESS_HEADLINE_COUNT` below, so this drifting out of
 * sync with prose is now a lint failure, not a silent staleness.
 */
export const HARNESS_COUNT = Object.keys(HarnessType).length

/**
 * `HARNESS_COUNT` minus the harnesses with a confirmed, currently-open
 * support gap — the number safe to use in headline/marketing copy
 * ("works with N coding agents") without overclaiming. Each exclusion is a
 * harness with its own `docs/TECH_DEBT.md` entry describing a REAL,
 * currently-unactionable gap (not a caveat, not a "documented, not a
 * defect" note):
 *
 * - `agentic-orchestrator` (TD-397): its OpenCode backend has no Intutic
 *   gate to delegate to at all — not actionable by this integration alone,
 *   closes only when OpenCode itself gets an adapter.
 * - `autogen` (TD-374): `InterventionHandler.on_send` is blind to
 *   `AssistantAgent`'s own tool calls — they never reach `Gate.guard()`.
 *
 * Deliberately does NOT exclude `mastra` — TD-380 is explicitly marked
 * "🟢 Documented, not a defect" in TECH_DEBT.md, a caveat about a call-site
 * hook override, not a coverage gap, so excluding it here would be the
 * exact overclaim-avoidance discipline applied backwards. Also does NOT
 * exclude `continue` over its headless-mode limitation (`cn -p` skips
 * PreToolUse hooks): that is a secondary invocation mode of a harness whose
 * primary (interactive) path is fully covered, not a reason to undercount
 * the harness itself.
 */
export const HARNESS_HEADLINE_COUNT =
  HARNESS_COUNT - [HarnessType.AGENTIC_ORCHESTRATOR, HarnessType.AUTOGEN].length

// ─── Execution Mode ──────────────────────────────────────────────────
// HLD §3.4 — Agent execution modes

/** Agent execution mode controlling autonomy level. */
export const ExecutionMode = {
  STANDARD: 'STANDARD',
  PLAN_ONLY: 'PLAN_ONLY',
  SHADOW: 'SHADOW',
  AUTONOMOUS: 'AUTONOMOUS',
} as const

/** Union of all execution mode values. */
export type ExecutionMode = typeof ExecutionMode[keyof typeof ExecutionMode]

// ─── Incident Status ─────────────────────────────────────────────────
// HLD §3.6.1, LLD §3.1 — Governance incident lifecycle

/** Lifecycle state of a governance incident. */
export const IncidentStatus = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
} as const

/** Union of all incident status values. */
export type IncidentStatus = typeof IncidentStatus[keyof typeof IncidentStatus]

// ─── Plan Lifecycle State ────────────────────────────────────────────
// HLD §3.4.1 — Stored plan compliance trail lifecycle

/** Lifecycle state for stored execution plans. */
export const PlanLifecycleState = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
} as const

/** Union of all plan lifecycle state values. */
export type PlanLifecycleState = typeof PlanLifecycleState[keyof typeof PlanLifecycleState]

// ─── Plan Execution Outcome ──────────────────────────────────────────
// HLD §3.4.1 — result category recorded when a plan is closed
// (lifecycleState -> COMPLETED). Meaningful only in that state; null
// otherwise — a REJECTED plan never executed, so it has no outcome.

/** Result category for a closed (COMPLETED) stored plan. */
export const PlanExecutionOutcome = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
  ABORTED: 'ABORTED',
} as const

/** Union of all plan execution outcome values. */
export type PlanExecutionOutcome = typeof PlanExecutionOutcome[keyof typeof PlanExecutionOutcome]

// ─── SOP Lifecycle State ─────────────────────────────────────────────
// HLD §3.4, LLD #6 §4.2 — 7-state FSM: DRAFT → PENDING_REVIEW → GENERATED
//   → HYPOTHESIZED → REFINED → VALIDATED → INVALIDATED

/** Lifecycle state for SOPs in the registry. */
export const SopLifecycleState = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  GENERATED: 'GENERATED',
  HYPOTHESIZED: 'HYPOTHESIZED',
  REFINED: 'REFINED',
  VALIDATED: 'VALIDATED',
  INVALIDATED: 'INVALIDATED',
} as const

/** Union of all SOP lifecycle state values. */
export type SopLifecycleState = typeof SopLifecycleState[keyof typeof SopLifecycleState]

// ─── SOP Type ────────────────────────────────────────────────────────
// TD-022 item 0.4 — SOP classification for hook pipeline

/** SOP type: standard markdown or executable V8 hook. */
export const SopType = {
  /** Standard SOP — markdown content enforced via SSL. */
  STANDARD: 'standard',
  /** Hook SOP — V8-executable script that fires at a pipeline phase. */
  HOOK: 'hook',
} as const

/** Union of all SOP type values. */
export type SopType = typeof SopType[keyof typeof SopType]

// ─── Hook Phase ──────────────────────────────────────────────────────
// TD-022 item 0.4 — Pipeline phase for hook-type SOPs

/** Pipeline phase where a hook-type SOP fires. */
export const HookPhase = {
  /** Before tool call evaluation. */
  PRE_TOOL: 'PRE_TOOL',
  /** After tool call evaluation. */
  POST_TOOL: 'POST_TOOL',
  /** Before forwarding to LLM provider. */
  PRE_RESPONSE: 'PRE_RESPONSE',
  /** After LLM response received. */
  POST_RESPONSE: 'POST_RESPONSE',
} as const

/** Union of all hook phase values. */
export type HookPhase = typeof HookPhase[keyof typeof HookPhase]

// ─── Routing Tier ────────────────────────────────────────────────────
// HLD §3.6, LLD §3.1 — Model routing tier classification

/** Model routing tier for cost optimization. */
export const RoutingTier = {
  FRONTIER: 'frontier',
  ECONOMY: 'economy',
  LOCAL: 'local',
} as const

/** Union of all routing tier values. */
export type RoutingTier = typeof RoutingTier[keyof typeof RoutingTier]

// ─── Workspace Role ──────────────────────────────────────────────────
// HLD §5.1, LLD #7 — RBAC role hierarchy

/** Workspace member role for RBAC. OWNER > ADMIN > EM > DEVELOPER > VIEWER. */
export const WorkspaceRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  EM: 'EM',
  DEVELOPER: 'DEVELOPER',
  VIEWER: 'VIEWER',
} as const

/** Union of all workspace role values. */
export type WorkspaceRole = typeof WorkspaceRole[keyof typeof WorkspaceRole]

// ─── MCP Proxy Settings ──────────────────────────────────────────────
// WS-5 — Q1 fail behavior, Q2 deployment model, Q3 bypass enforcement
// TD-151, TD-152, TD-153, TD-154, TD-155

/**
 * MCP proxy fail behavior when the Intutic control plane is unreachable.
 * - `open`   (default): pass through the tool call + emit a warning event
 * - `closed`: block the tool call with a user-visible error message
 *
 * Note: `closed` only affects harnesses with MCP proxy injection (9/20 —
 * 10 config paths across 9 harnesses, see sync-daemon mcpAutoWrite.ts).
 * For harnesses without MCP proxy injection (e.g. n8n, pi, codex,
 * open-webui), see TD-151.
 */
export const McpProxyFailBehavior = {
  OPEN:   'open',
  CLOSED: 'closed',
} as const
export type McpProxyFailBehavior = typeof McpProxyFailBehavior[keyof typeof McpProxyFailBehavior]

/**
 * MCP proxy deployment model.
 * - `per-session` (default, Phase 4): new proxy process per MCP connection
 * - `daemon`      (Phase 5): long-lived daemon, per-session shims delegate via Unix socket
 *
 * See TD-153 — daemon requires macOS notarization. Both modes are active: the
 * mcp-proxy honours `daemon` by answering policy lookups over the daemon socket.
 */
export const McpProxyMode = {
  PER_SESSION: 'per-session',
  DAEMON:      'daemon',
} as const
export type McpProxyMode = typeof McpProxyMode[keyof typeof McpProxyMode]

/**
 * Bypass enforcement tier — how aggressively the sync-daemon defends harness configs
 * against manual edits.
 * - `rewrite`    (default): drift watcher detects edits → immediate config rewrite (~1s)
 * - `immutable`  (opt-in):  after each write, sets macOS `chflags uchg` (user-immutable flag)
 * - `alert-only`: no rewrite; drift creates a governance incident only (audit mode)
 *
 * See TD-154 for immutable-flag UX risk notes.
 */
export const BypassEnforcementTier = {
  REWRITE:    'rewrite',
  IMMUTABLE:  'immutable',
  ALERT_ONLY: 'alert-only',
} as const
export type BypassEnforcementTier = typeof BypassEnforcementTier[keyof typeof BypassEnforcementTier]

// ─── Phase 5 Enums ───────────────────────────────────────────────────
// LLD #27: Production Hardening & SOC 2

/** TurboVec behavioral drift classification. @see HLD §7.7 */
export const DriftClassification = {
  POSITIVE_DRIFT: 'POSITIVE_DRIFT',
  NEGATIVE_DRIFT: 'NEGATIVE_DRIFT',
  NEUTRAL_DRIFT:  'NEUTRAL_DRIFT',
} as const
export type DriftClassification = typeof DriftClassification[keyof typeof DriftClassification]

/** Drift detection mode — TurboVec cosine-distance or compliance-score fallback. */
export const DriftDetectionMode = {
  TURBOVEC:                  'turbovec',
  COMPLIANCE_SCORE_FALLBACK: 'compliance_score_fallback',
} as const
export type DriftDetectionMode = typeof DriftDetectionMode[keyof typeof DriftDetectionMode]

/**
 * Migration 163: which of `sop_amendments`' three producers wrote a row.
 * INCIDENT_MINING (`dreamCycleService.runDreamCycle`, `runId` prefixed
 * `dcr_`) and METACLAW (`promptEvolutionService.runEvolutionCycle`, `runId`
 * prefixed `mcr_`, has a matching `metaclaw_runs` row — the only source a
 * clause diff is meaningful for) are both manually/dashboard-triggered.
 * HEALTH_CRON (`sopHealthCron.ts`, `runId` NULL) is the only one currently
 * on a schedule — its output was invisible to every UI before this column
 * existed, since the sole proposals feed filtered `runId IS NOT NULL`.
 */
export const AmendmentSource = {
  INCIDENT_MINING: 'INCIDENT_MINING',
  METACLAW: 'METACLAW',
  HEALTH_CRON: 'HEALTH_CRON',
} as const
export type AmendmentSource = typeof AmendmentSource[keyof typeof AmendmentSource]

