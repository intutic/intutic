---
title: Skill Scanning
description: Content-scanning agent skill files (SKILL.md) for prompt-injection, data-exfiltration, and malicious-code shapes — what it catches, how it's scored, and what it deliberately does not cover yet.
---

# Skill Scanning <Badge type="tip" text="Open-Core" />

An agent skill is a directory a harness loads on its own initiative —
`.claude/skills/**/SKILL.md` for Claude Code, `.agents/skills/**/SKILL.md`
for Intutic's own bundled skills — containing a markdown file of
instructions the agent treats as authoritative, the same way it treats the
system prompt. Nothing in this codebase read that content before this
feature. `intutic skill audit`, the sync daemon's periodic report, and the
dashboard's agent posture ring now do.

## What gets scanned, and by what

`scanSkillContent` (`@intutic/shared-types`, `skillScan.ts`) runs a table of
regex patterns against a skill's raw markdown — front matter included, since
front matter is just text at the top of the file, not stripped before the
scan. Three threat categories, borrowed from Cisco's open-source
`skill-scanner` taxonomy (the categorisation, not the implementation — this
is a native TypeScript port, not a wrapped external tool, since this
codebase has zero Python runtime dependencies and already owns a detector
for this exact threat genre):

- **Prompt injection** — hidden instruction blocks (`<system>`, `<important>`
  tags), instructions to conceal an action from the user, redirects away
  from another tool or skill, HTML comments carrying a directive invisible
  in rendered markdown.
- **Data exfiltration** — instructions to read a credential-shaped path
  (`~/.ssh/id_rsa`, `.env`, `.aws/`) or route its contents into an unrelated
  output, and markdown links/images whose URL itself names a credential —
  the auto-rendered-image exfiltration vector, since an image fires an
  outbound request with no user action.
- **Malicious code** — an instruction to decode an obfuscated (base64/atob)
  payload and execute or eval it.

Most of these patterns are a direct port of `packages/proxy/src/tool_poison.rs`,
the proxy's existing detector for poisoned **tool descriptions** — the same
threat genre (prose an agent treats as authoritative, published by a party
the user never reviewed), adapted from tool-description context to
markdown/skill-file context. A few are new, for markdown's own attack
surface (hidden HTML comments, image-based exfiltration links) that a JSON
tool description never has.

Every pattern ships with fixtures — strings that must trigger it, and at
least three that must not — checked at import time, not from a test someone
could skip. A pattern whose own fixtures disagree with it fails to import,
for every consumer, immediately.

## Where it runs

| Surface | What it does |
|---|---|
| `intutic skill audit` | Walks `.agents/skills/**/SKILL.md` and `.claude/skills/**/SKILL.md`, scans each, prints findings, and reports them to the control plane. Auto-pruning a flagged line is opt-in via the `enableLocalSkillAuditDelete` workspace setting — the same gate that already covers the legacy rule-file audit (`CLAUDE.md`, `.cursorrules`, etc). |
| Sync daemon | Scans `.agents/skills/**/SKILL.md` on every sync cycle and attaches the verdict to the agent's reported `skills` facet — no separate command needed. |
| Agent posture score | The `skills` scoring dimension is content-aware: a skill scanned clean scores full marks, a skill with a confirmed finding scores zero, and a skill this report cannot vouch for either way (never scanned, or reported by an older daemon build) scores in between — see [What this cannot catch](#what-this-cannot-catch) for why "in between" and not "clean." |

A file that cannot be read — permissions, vanished between discovery and the
read, not a regular file — is reported `scanned: false`, never folded into
`issuesDetected: 0` or `clean: true`. A scan that never ran says nothing
about the file's safety, and treating silence as a clean bill of health is
exactly the failure mode this distinction exists to avoid.

## Report-only, deliberately, this phase

Nothing in this codebase blocks, refuses, or auto-deletes a skill on the
strength of a finding from this scanner. Findings are surfaced — in the CLI
output, in the control-plane report, in the posture score — and nothing
more, unless an operator has explicitly opted into the existing
`enableLocalSkillAuditDelete` pruning gate. Enforcement on top of these
patterns is deliberately future, unbuilt work; see
[TECH_DEBT.md](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md)
for the tracked follow-ups.

## What this cannot catch

**A scan that returns no findings does not guarantee a skill is secure.**
This is the same candor this project's other partial-coverage controls are
held to — see [Governance Controls Checklist](/guide/governance-controls) for
the house style this page follows.

Specifically:

- **The false-positive rate on real skill markdown is unmeasured.** The
  seed patterns this scanner ports are measured at 0 false positives — but
  on 10,753 real **tool descriptions**, a corpus `tool_poison.rs` vendors at
  `packages/proxy/tests/corpus/tooldesc/`. Skill markdown is a different,
  longer, more discursive genre, written for a human reader as much as an
  agent, and it routinely contains exactly the kind of imperative security
  language ("block any call that…", "never embed secrets…") this scanner's
  patterns key on. One known-benign fixture — the `intutic-rule-author`
  skill this project bundles into every workspace, which is full of that
  exact language — is checked clean in this codebase's own test suite. One
  fixture is not a corpus. A benign-skill corpus comparable in size and
  provenance to the tool-description one does not exist yet, and until it
  does, this scanner's real-world false-positive rate is a claim nobody can
  back with a number.
- **Recall against real attacks is not measured either**, for the same
  reason `tool_poison.rs` does not claim one: the positive fixtures are
  hand-built from a published attack taxonomy, so they show the documented
  shapes are covered, not what fraction of real attacks would be caught.
- **Deterministic pattern matching only — no semantic understanding.** A
  rephrasing that avoids every pattern's literal wording passes clean. This
  is by design for this phase: LLM-based semantic analysis of skill content
  is deliberately kept out of any hot/live path (see TECH_DEBT.md); if it is
  ever built, it has to go through this codebase's `resolveMonitor`
  judge-call convention like every other LLM judge invocation, not bypass it
  because the input happens to be a skill file.
- **Bundled scripts are out of scope.** A skill can ship executable files
  alongside its `SKILL.md` — a Python or shell script the instructions tell
  the agent to run. This scanner reads markdown only; scanning bundled
  executables is a different problem (static analysis of arbitrary code,
  not pattern-matching prose) and is explicitly deferred — see TECH_DEBT.md.
- **Encoded, split, or otherwise obfuscated payloads generally.** Beyond the
  one narrow base64-decode-then-execute shape this scanner does catch, a
  payload assembled from pieces, or hidden behind an encoding this scanner's
  patterns don't anticipate, is not caught.

## Related

| Page | What it covers |
|---|---|
| [Governance Controls Checklist](/guide/governance-controls) | The house style for stating partial coverage honestly, applied across every control this product ships |
| [Graph Guardrails](/guide/graph-guardrails) | The deterministic detector taxonomy this scanner's discipline follows |
| [Policies & Enforcement](/guide/policies) | Where enforcement (as opposed to reporting) actually lives in this product |
