# Rule Author Agent Skill

Teach any AI coding agent to turn natural-language business rules into compiled WASM governance policies enforced by the local Intutic proxy.

Where the [Kitkat skill](/integrations/kitkat) teaches an agent to *operate* Intutic governance, the Rule Author skill teaches it to *extend* it: the agent converts a plain-English rule ("block any agent call that touches the prod database") into an AssemblyScript policy, compiles it with the open-core [`@intutic/wasm-sdk`](/external/wasm-rules), dry-runs it against mock contexts, and installs it into `~/.intutic/wasm/` — where the proxy hot-loads it within ~5 seconds. The full loop runs locally with no control plane.

---

## How it works

1. **You state a rule** in the agent chat: *"never allow shell tool calls containing `rm -rf`"* — or [`/fix`](/integrations/kitkat) tells you one is missing. When the proxy scores your governance posture and finds no custom policy, it recommends *"add a WASM rule under `~/.intutic/wasm` to codify a custom guardrail"*; that recommendation is this workflow's other entry point. Run `/fix` again after installing to confirm the score moved — if it did not, the rule is not loading, and `intutic policy list-local` plus the sandbox limits below are where to look.
2. **The agent authors** an AssemblyScript rule against the WASM SDK's `RequestContext` contract.
3. **Compile:** `intutic policy compile --src assembly/index.ts --out build/rule.wasm`
4. **Dry-run:** `intutic policy test` against both a should-block and a should-allow mock — the skill requires both to pass before install.
5. **Install:** `intutic policy install --wasm build/rule.wasm --name <name> --priority NN` — validated by instantiation first, then copied to the local rules directory the proxy rescans every ~5 s.

Local rules merge with any centrally synced rules most-restrictive-wins: a KILL from either source ends the request, so a local rule can add restrictions but can never neutralize a central one.

---

## Setup

### Automatic (sync daemon)

Workspaces running `intutic connect` receive the skill automatically: the sync daemon writes `.agents/skills/intutic-rule-author/SKILL.md` into the workspace if it is not already present. It never overwrites your local edits.

### Manual

Create the skill directory and download the skill file into it:

```bash
mkdir -p .agents/skills/intutic-rule-author
```

<a href="/downloads/RULE_AUTHOR_SKILL.md" download="SKILL.md" class="download-button" style="display: inline-block; padding: 6px 12px; background: var(--vp-c-brand); color: white; border-radius: 4px; text-decoration: none; font-weight: 500; font-size: 0.85rem; margin-top: 8px; margin-bottom: 12px;">Download SKILL.md</a>

---

## Guardrails built into the skill

- The agent must produce **both** a should-block and a should-allow mock and verify them with `intutic policy test` before installing.
- `intutic policy install` refuses rules that fail instantiation — a broken rule enforces nothing, because the proxy sandbox fails open.
- Secrets in rule sources are flagged by `intutic skill audit`.
- Allow-overrides are structurally impossible: the verdict lattice only adds blocks.

See the [WASM rules guide](/guide/wasm-rules) for the full authoring contract and sandbox limits.
