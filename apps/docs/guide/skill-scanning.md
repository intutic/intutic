---
title: Skill Scanning
description: Content-scanning agent skill files (SKILL.md) and their bundled scripts for prompt-injection, data-exfiltration, and malicious-code shapes — what it catches, how it's scored, and what it deliberately does not cover yet.
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
| `intutic skill audit` | Walks `.agents/skills/**/SKILL.md` and `.claude/skills/**/SKILL.md`, scans each, prints findings, and reports them to the control plane. Auto-pruning a flagged line is opt-in via the `enableLocalSkillAuditDelete` workspace setting — the same gate that already covers the legacy rule-file audit (`CLAUDE.md`, `.cursorrules`, etc). Also enumerates and scans each skill's **bundled scripts** — see below. |
| Sync daemon | Scans `.agents/skills/**/SKILL.md` on every sync cycle and attaches the verdict to the agent's reported `skills` facet — no separate command needed. Also computes a `scripts: {total, scanned, flagged}` facet per skill from the same bounded bundled-file enumeration. |
| Agent posture score | The `skills` scoring dimension is content-aware: a skill scanned clean scores full marks, a skill with a confirmed finding scores zero, and a skill this report cannot vouch for either way (never scanned, or reported by an older daemon build) scores in between — see [What this cannot catch](#what-this-cannot-catch) for why "in between" and not "clean." A flagged bundled script pulls the whole skill to zero regardless of how `SKILL.md` itself scored; an unscanned (refused, over-cap, or unrecognized-language) bundled script pulls the skill down to the same "in between" band an unscanned `SKILL.md` gets. |

A file that cannot be read — permissions, vanished between discovery and the
read, not a regular file — is reported `scanned: false`, never folded into
`issuesDetected: 0` or `clean: true`. A scan that never ran says nothing
about the file's safety, and treating silence as a clean bill of health is
exactly the failure mode this distinction exists to avoid.

## Bundled scripts

A skill directory can ship executable files alongside its `SKILL.md` — a
`setup.sh` the instructions tell the agent to run, a `helper.py` it imports,
a downloaded binary. Until this phase (TD-356 in
[TECH_DEBT.md](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md)),
nothing in this codebase even enumerated those files: `intutic skill audit`
and the sync daemon's `collectSkills` both walked skill directories but only
ever opened the one `SKILL.md` inside each, so a sibling script was invisible
to every consumer.

That gap is closed by `packages/shared-types/src/scriptScan.ts` (bundled-file
counterpart to `skillScan.ts`, reusing its pattern shape, 3-category
taxonomy, and fixture discipline) plus two new functions in
`tools/cli/src/commands/skill.ts`:

- **`discoverSkillBundledFiles`** — a bounded, symlink-skipping walk of a
  skill directory's sibling files. Bounded by three caps
  (`@intutic/shared-types`): `MAX_SKILL_DIR_DEPTH` (3 — how deep the walk
  descends into subdirectories), `MAX_FILES_PER_SKILL` (40 — how many files
  it will ever return for one skill), and `MAX_SCRIPT_SCAN_BYTES` (256 KiB —
  the largest file it will read content from). Symlinks are never followed —
  a symlink inside a skill directory could point outside it, or outside the
  workspace entirely, which would turn a bounded, skill-scoped walk into an
  effectively unbounded one. The sync daemon's `collectSkills` applies the
  same three caps and the same symlink-skip discipline through its own,
  independent implementation (`collectSkillScripts`), the same way it already
  re-implements `SKILL.md` discovery independently of the CLI rather than
  importing from `tools/cli`.
- **`auditScriptFile`** — reads one discovered file, infers its language via
  `detectScriptLanguage` (extension first, shebang as a fallback), and
  **always** computes its sha256 hash — even for a file this scanner cannot
  itself interpret, such as a compiled binary. That hash is deliberate, not
  incidental: a later, separate, **opt-in** integration with Cisco's
  `skill-scanner` project (and a VirusTotal-style hash lookup) depends on
  every bundled file being hashed regardless of whether this phase's own
  regex patterns can say anything about its content. Content scanning itself
  (`scanScriptContent`) only runs when the language is recognized and the
  file is within the byte cap.

Refusal-not-pass applies here exactly as it does for `SKILL.md`: a file over
`MAX_SCRIPT_SCAN_BYTES` is reported `scanned: false` — a refusal, never a
silent skip and never a false "clean" — and the same is true of a file whose
language could not be determined. Both are still hashed.

`SCRIPT_SCAN_PATTERNS` seeds cover the shapes this kind of script most often
carries: a remote download piped straight into a shell (`curl … | sh`), a
base64-decoded payload piped into a shell, reading a credential-shaped path
(`.ssh`, `.aws/credentials`, `.env`) from a script, an outbound POST (or
piped stdin into `curl`) to an external URL, `chmod +x` of a just-downloaded
file, and two Python-specific idioms for the same decode-then-execute shape —
`subprocess`/`os.system` fed a base64-decoded payload, and
`eval(compile(...))`/`exec(base64.b64decode(...))`. Every pattern carries the
same fixture discipline as `skillScan.ts`'s table: at least one string that
must trigger it, at least three that must not, both checked at import time.

Findings from bundled scripts land in the same places as `SKILL.md`
findings — the CLI's console output, the `skills/report` payload (each row
now optionally carries `kind: 'skill_md' | 'script'` and, for scripts,
`language`), the `--sarif` output (one `intutic-skill-scan` rule catalog,
union of both pattern tables), and the sync daemon's per-skill `scripts:
{total, scanned, flagged}` facet, which the posture scorer folds into the
same `skills` dimension described above.

## Report-only, deliberately, this phase

Nothing in this codebase blocks, refuses, or auto-deletes a skill on the
strength of a finding from **this scanner** — that stays true after the
block-tier promotion below, which does not run `scanSkillContent` at all.
Findings from the CONTENT scan are surfaced — in the CLI output, in the
control-plane report, in the posture score — and nothing more, unless an
operator has explicitly opted into the existing `enableLocalSkillAuditDelete`
pruning gate. Enforcement of skill-file CONTENT is deliberately future,
unbuilt work; see
[TECH_DEBT.md](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md)
for the tracked follow-ups.

## Block-tier skill-directory protection

A second, separate control — not this scanner — now **refuses** a write or
edit whose target path lands under `.agents/skills/**` or `.claude/skills/**`.
It is worth being precise about the boundary: this mechanism looks only at
*where* a call is writing, never at what the content says, so it is
enforceable with none of the caveats above. It lives in
`services/sync-daemon/src/harness/protectedPaths.ts`
(`SKILL_SURFACE_PATTERNS`) and
`services/sync-daemon/src/lib/policySnapshot.ts`
(`SKILL_SURFACE_TIER_SEVERITY`), and follows the same "policy snapshot
dynamic-tier promotion" pattern this product already uses for
`DESTRUCTIVE_COMMAND_PATTERNS`.

**Two tiers, one path family:**

- **Floor (compiled in, always present): `warn`.** Two patterns — one per
  skill root — ship in every gate's static floor and fire on any Write/Edit
  whose target path matches, regardless of whether the machine has ever
  synced. This is the degraded-mode baseline: it is what a workspace gets
  with no policy snapshot, or an invalid one, and it can only be changed by a
  release. It stays `warn` for exactly that reason — a compiled-in rule has
  no one-sync-cycle undo, so it has to be the version that is safe to run
  unconditionally, forever.
- **Snapshot (delivered every sync cycle): `block`, the steady state.** The
  same two path patterns are re-shipped as `skill_surface.*.tier` entries
  through the policy-snapshot channel, at whatever severity
  `SKILL_SURFACE_TIER_SEVERITY` currently declares — `block` today. Because a
  gate evaluates every matching rule and a `block` verdict wins outright, a
  workspace with a valid, current snapshot sees the write refused even though
  the floor's own copy only warned; a workspace whose snapshot is absent,
  stale, or fails its digest/workspace check degrades cleanly back to the
  floor's `warn`, because the dynamic tier is dropped and only the compiled-in
  rules remain.

**Why `block`, unlike the destructive-command tier it borrows the mechanism
from.** `DESTRUCTIVE_COMMAND_PATTERNS` ships its `block`-eligible patterns at
`warn` first specifically to earn promotion from measured field data — those
patterns are unproven against real developer traffic, and a false positive
there has a real cost. Skill-directory path matching was never in that
position: it does not judge content, so there is no false-positive rate to
measure in the first place — TD-358's own text calls this out directly,
"path-matching... is not actually an exception to the measurement
requirement — it never needed one." And the cost of staying at `warn` here is
not neutral: a poisoned skill file written under warn-only is not a near-miss
waiting to be triaged, it is a file on disk that the very next agent session
loads and treats as instructions. A warn that lets that write proceed *is*
the incident, the same reasoning `SECRET_CONTENT_PATTERNS` already applies to
credential values written into files.

**One-sync-cycle retractability.** The whole reason this ships through the
snapshot rather than being promoted in place in the static floor is that it
can be undone without a release: flipping `SKILL_SURFACE_TIER_SEVERITY` back
to `'warn'` and letting the next sync cycle land it returns every workspace to
the floor-only behavior described above, exactly the retraction lever
`DESTRUCTIVE_TIER_SEVERITY` already provides for the destructive-command
tier.

**What this does not do.** It does not scan or judge skill CONTENT — that
remains the unchanged, unblocking scanner described above, gated on the
corpus measurement TD-358 tracks. It does not catch a skill file reached
through a shell redirect, a symlink, or a relative path walk (`subject:
'target'`, matching the tool's own path argument, not a bare mention in a
command string). And SHADOW-mode workspaces see the promotion downgraded to
`shadow` (observe, don't act) on the snapshot side, same as every other
snapshot-delivered rule — the floor's own `warn` copy is unaffected by
`interventionMode` either way.

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
- **Regex-genre pattern matching only — for `SKILL.md` prose AND for bundled
  scripts — never AST or dataflow analysis, and no semantic understanding.**
  This is the single most important limitation to be honest about, and it
  applies identically on both sides of this page: `scanSkillContent` matches
  imperative sentence shapes against markdown text; `scanScriptContent`
  matches source-code shapes (a `curl | sh` pipeline, a `subprocess.run(
  base64.b64decode(...))` call) against script text. Neither one parses a
  syntax tree, resolves what a variable holds, follows a function call to its
  definition, or tracks where a value came from before it reaches a
  dangerous sink. A rephrasing that avoids a pattern's literal wording passes
  clean; so does a script that reaches the exact same dangerous operation
  through a shape these patterns don't anticipate — an extra layer of
  indirection, a helper function hiding the call, string concatenation
  splitting a keyword across two variables. This is a deliberate scope
  choice for this phase, not an oversight: full AST/dataflow analysis of
  arbitrary source code is a meaningfully different (and much heavier)
  engineering problem than pattern-matching prose or matching known code
  shapes, and building it into this phase would have meant either rushing an
  unrelated detector in alongside these two, or quietly pretending regex
  patterns generalize to real static analysis, which they do not. Full
  AST-level scanning of bundled scripts is available only through a later,
  **separate, opt-in** integration with Cisco's open-source `skill-scanner`
  project — unbuilt as of this phase, and tracked in TECH_DEBT.md — which
  consumes the sha256 hash `auditScriptFile` computes for every bundled file.
  LLM-based semantic analysis of skill content is a further, still-separate
  gap: it is deliberately kept out of any hot/live path (see TECH_DEBT.md),
  and if it is ever built, it has to go through this codebase's
  `resolveMonitor` judge-call convention like every other LLM judge
  invocation, not bypass it because the input happens to be a skill file.
- **Bundled-script coverage, specifically, is a first pass, not a general
  scanner.** `SCRIPT_SCAN_PATTERNS` seeds a handful of well-known shapes
  (remote-download-piped-to-shell, decode-then-execute, credential-path
  reads, outbound exfiltration POSTs, chmod+exec of a downloaded file, and
  two Python-specific decode-then-execute idioms) — not a general-purpose
  malicious-code detector. A script that does something harmful through any
  other shape is not caught by this phase at all.
- **Encoded, split, or otherwise obfuscated payloads generally.** Beyond the
  narrow base64-decode-then-execute shapes these scanners do catch (one for
  markdown, three for scripts — a shell pipeline and two Python idioms), a
  payload assembled from pieces, or hidden behind an encoding these patterns
  don't anticipate, is not caught.

## Related

| Page | What it covers |
|---|---|
| [Governance Controls Checklist](/guide/governance-controls) | The house style for stating partial coverage honestly, applied across every control this product ships |
| [Graph Guardrails](/guide/graph-guardrails) | The deterministic detector taxonomy this scanner's discipline follows |
| [Policies & Enforcement](/guide/policies) | Where enforcement (as opposed to reporting) actually lives in this product |
