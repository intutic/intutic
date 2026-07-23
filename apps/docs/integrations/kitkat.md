# Kitkat Agent Custom Skill

Integrate Intutic governance within developer environments using a workspace-level custom agent skill.

Claude Code, Cursor, Google Antigravity, OpenAI Codex, and other compatible agentic coding assistants natively load specialized instructions, guidelines, and system personalities from a structured customization directory in the workspace.

---

## How it works

Instead of merging rules globally into host machine config files, you can place a pre-configured `SKILL.md` directly into your workspace. When the AI agent connects, it automatically reads the Kitkat skill rules to structure its prompts, FinOps attributes, and safety overrides locally.

---

## Setup

### 1. Create the skill directory

Create the target skill directory at the root of your workspace:

```bash
mkdir -p .agents/skills/intutic-governance-kitkat
```

### 2. Download the SKILL.md file

Download the pre-configured skill instruction template and save it directly in that directory:

<a href="/downloads/SKILL.md" download="SKILL.md" class="download-button" style="display: inline-block; padding: 6px 12px; background: var(--vp-c-brand); color: white; border-radius: 4px; text-decoration: none; font-weight: 500; font-size: 0.85rem; margin-top: 8px; margin-bottom: 12px;">Download SKILL.md</a>

### 3. Connect to Intutic

Boot the sync daemon and proxy to begin intercepting requests:

```bash
intutic connect
```

*Your agentic assistant will now detect the Kitkat governance persona, apply token predictions, and prompt-intercept through the local proxy port (`4000`).*

---

## 🤖 AI-First Autonomous Self-Configuration

Intutic is designed **AI-first**: AI coding agents (such as Claude Code, Antigravity, Cursor, or custom framework agents) can configure, audit, and manage their own governance sessions directly through terminal commands or in-stream slash commands without needing human intervention.

### In-Stream Slash Commands (`@intutic` / `/intutic`)

When interacting with model providers through the Intutic proxy, agents can issue commands directly inside prompt payloads by prepending `@intutic` or `/intutic`. The proxy intercepts these commands **pre-flight in <5ms**, executes the governance action, and returns formatted response blocks:

#### 1. Cost & Task Attribution
* **`@intutic initialize`**: Queries linked task providers (Linear, Jira, GitHub Issues) and recommends open ticket candidates for the current session.
* **`@intutic start [<ticket_id>] [--sops=<names>] [--auto-judge]`**: Locks cost attribution to a ticket and scopes active local SOP directories.
  * *Example:* `@intutic start 12 --sops=security-rules --auto-judge`

#### 2. FinOps & Token Projections
* **`@intutic predict <prompt>`**: Calculates pre-flight input/output token projections and USD cost before submitting the request to upstream LLM providers.
* **`@intutic recommend`**: Analyzes the active conversation state and suggests context-pruning strategies to eliminate wasted token loops.

#### 3. Policy Verification & Automated E2E Judging
* **`@intutic verify <prompt>`**: Audits the prompt pre-flight against active SOPs and guidelines, returning pass/fail verdicts before submitting requests to the LLM.
* **`@intutic review <prompt>`**: Evaluates prompt quality, actionability, and ambiguity scores.
* **`@intutic judge <prompt>`**: Runs real-time LLM-as-a-judge compliance checkers on model responses out-of-band.
* **`@intutic status`**: Displays active session statistics, spent token budget, and average compliance score.
* **`@intutic budget`**: Displays daily spend limits and remaining quota.
