# @intutic/gate

Pre-execution tool gate for JS/TS agent frameworks without a shipped Intutic
harness. Port of the Python SDK's gate subpackage
(`packages/intutic-clawde/intutic_clawde/gate/`) — see that package for the
canonical description of the enforcement contract this one mirrors.

This package is the **core** library only. Framework-specific adapters are
built on top of it: `@intutic/gate/dsh` (a Cordis plugin for DeepSeek's "dsh"
harness) ships in this package already; Mastra and the Vercel AI SDK adapters
are sibling phases of the same plan. LangChain.js has no dedicated adapter
planned and instead uses the generic `wrapTool`/`wrapTools` helper directly.

## Quick start

```ts
import { Gate, GateClient, install, wrapTools } from '@intutic/gate'

const gate = new Gate(
  { workspaceId: process.env.INTUTIC_WORKSPACE_ID },
  GateClient.fromEnv({ harness: 'my-framework' }),
)
install(gate) // process-wide default; wrapTool()/wrapTools() pick it up

const guardedTools = wrapTools(myTools) // array or {name: tool} record
```

On a refused call, the wrapped tool throws `IntuticGateRefusal` (message
prefixed `[Intutic Governance] BLOCKED:`) BEFORE the real implementation
runs — this package's throw-based refusal contract, the same one
`services/sync-daemon/src/harness/gateBody.ts`'s emitted gates and
`packages/mcp-proxy/src/policy.ts` use elsewhere in this repo's gate
vocabulary.

## Public API surface

| Export | From | What it is |
|---|---|---|
| `Gate`, `GateConfig` | `gate.ts` | The four-tier evaluator. `new Gate(cfg, client?)`, `await gate.guard(toolName, toolInput)`. |
| `install(gate)`, `active()` | `gate.ts` | Process-wide default gate, so wrapped tools don't need the instance threaded through every call site. |
| `IntuticGateRefusal`, `GateError`, `GateConnectionError` | `errors.ts` | Thrown on refusal. `.reason`, `.code`, `.incidentId` carry the structured verdict; `.message` carries the `[Intutic Governance] BLOCKED: ...` text. |
| `GateClient` | `client.ts` | Control-plane client (`hookGate`, `emit`, `GateClient.fromEnv(...)`). |
| `wrapTool(fn \| tool, opts?)`, `wrapTools(list \| record, gate?)` | `wrapTools.ts` | Generic wrapping for a plain async function or an `{ execute, ... }`-shaped tool object. **This is the integration point for any JS framework without a dedicated adapter — LangChain.js included.** |
| `intuticHeaders(opts?)` | `headers.ts` | Headers for a proxy-pointed HTTP/OpenAI-compatible client (`x-session-id`, `x-workspace-id`, `x-intutic-harness`). |
| `loadSnapshot`, `evaluate`, `Snapshot`, `guardDisabledFromEnv` | `snapshot.ts` | Tier A1: reads `~/.intutic/hooks/policy-snapshot.rules`. |
| `parseRules`, `firstMatch`, `fetchRules`, `SopRule` | `soprules.ts` | Tier A3: SOP-authored `WHERE`-clause rules. |
| `checkCommand`, `checkImages`, `checkWrittenManifest`, `ImageVerdict` | `imagecheck.ts` | Tier A2: container-image provenance on deploy commands. |
| `classify`, `isDeploy`, `isTest`, `touchesInfra` | `actions.ts` | Command classifier shared by A2's deploy trigger. |

### A note for sibling adapter phases

`Gate.guard()` is **async** (`Promise<void>`), unlike the Python SDK's
synchronous `Gate.guard()` — the network-backed tiers (SOP-rule fetch,
`POST /hook-gate`) use `fetch` here rather than Python's blocking
`urllib.request`. Every adapter built on this package must `await` it.

### What Tier A1 does and does not cover

Like the Python SDK it ports, this package's snapshot reader (Tier A1) reads
**only** `~/.intutic/hooks/policy-snapshot.rules`. It does **not** separately
compile in the "static floor" patterns
(`services/sync-daemon/src/harness/protectedPaths.ts`'s
`staticFloorPatterns()` — the bypass/secret-content/skill-surface pattern
tables) the way the shipped shell/JS gate emitters do (`INTUTIC_FLOOR`,
concatenated ahead of the snapshot's own rules in `gateBody.ts`'s
`intuticGate()`). Only what actually flows through the `.rules` file —
SOP-authored rules, the destructive-command tier, and the tier-promoted
skill-surface rules — is enforced by Tier A1 here. This gap already exists in
`intutic_clawde`; it is preserved, not introduced, by this port. See
`src/__tests__/fidelity.test.ts` for exactly which parts of the shipped
contract Tier A1 DOES reproduce, verified against the real pattern tables.

## Subpath convention for later phases

`@intutic/gate/dsh` now exists (`src/dsh.ts` — a Cordis plugin for DeepSeek's
"dsh" harness; see its own module doc for the veto contract, and
`services/sync-daemon/src/harness/dshHooks.ts` for how it gets registered
into a dsh profile). `@intutic/gate/vercel` and `@intutic/gate/mastra` do not
exist yet — they are sibling phases of this plan. When they are built, follow
the SAME convention `dsh.ts` already establishes (also
`services/sync-daemon`'s existing subpath convention — see that package's
`package.json`):

1. One source file per adapter: `src/vercel.ts`, `src/mastra.ts`, `src/dsh.ts`.
2. An `exports` entry per adapter in `package.json`:
   ```json
   "./vercel": { "import": "./dist/vercel.js", "types": "./dist/vercel.d.ts" }
   ```
3. A matching `typesVersions` entry so editors resolve types from source
   pre-build:
   ```json
   "typesVersions": { "*": { "vercel": ["src/vercel.ts"] } }
   ```
4. Each adapter file imports from `./gate.js`, `./errors.js`, etc. (this
   package's core, already built) rather than re-implementing any tier —
   the whole point of splitting core from adapters is that the four-tier
   evaluation logic lives in exactly one place.

No stub files are checked in for these yet; the `exports` map above documents
the shape they should take rather than pre-committing to file names a later
phase might want to change.

## Fidelity suite

`src/__tests__/fidelity.test.ts` builds a synthetic `.rules` snapshot from a
point-in-time copy of the REAL pattern tables in
`services/sync-daemon/src/harness/protectedPaths.ts`
(`src/__tests__/fixtures/protectedPathsFixtures.ts` — see that file's header
for why it is a copy rather than a live cross-package import, and how to
re-sync it) and asserts `evaluate()` reproduces the same block/warn/shadow
verdict as each pattern's own `matches`/`notMatches` fixtures, for every
pattern whose `subject` a `.rules` file can actually carry (`command`,
`target`, `tool`, `any` — `content`-subject patterns, i.e.
`SECRET_CONTENT_PATTERNS`, are out of scope: they never reach the snapshot
channel in the first place, matching the Python SDK's own limitation).
