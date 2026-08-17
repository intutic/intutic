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
is a native TypeScript port, not a wrapped external tool: **this codebase's
own runtime** stays Python-free, and already owned a detector for this exact
threat genre before this phase shipped. That is a claim about OUR runtime,
not a ban on ever talking to a Python tool — see
[Cisco `skill-scanner` integration](#cisco-skill-scanner-integration-opt-in)
below for the separate, opt-in, OPERATOR-INSTALLED integration this phase's
own text used to describe only as future work. Nothing in this codebase
embeds, vendors, or depends on that tool; it is shelled out to only when the
operator has separately installed it, and every consumer degrades
gracefully — never silently, never by pretending a skipped scan is a clean
one — when it is absent):

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

## Cisco `skill-scanner` integration (opt-in)

Phase S3 adds an OPTIONAL integration with Cisco's open-source
`skill-scanner` project — the one whose category taxonomy this page's native
scanner already borrows (see above). It is a separate binary the operator
installs themselves; nothing in this codebase's own runtime depends on it,
before or after this phase.

**What it adds beyond native scanning.** Everything above this section —
`scanSkillContent`, `scanScriptContent` — is regex-genre pattern matching:
fast, dependency-free, and honest about not doing AST parsing, dataflow
analysis, or semantic understanding (see
[What this cannot catch](#what-this-cannot-catch)). The Cisco integration is
a genuinely different, deeper analysis path for the same bundled-script
surface `scriptScan.ts` covers, run as a second engine alongside — never
instead of — native scanning.

**How to enable it.**

- `pipx install skill-scanner` — installs the binary on PATH. `intutic
  doctor` reports whether it is present (optional, never a failing check)
  and, when present, its version.
- `intutic skill audit --engine cisco` — explicitly runs the Cisco engine
  for this invocation, IN ADDITION to native scanning. If the binary is not
  on PATH, this fails loudly (non-zero exit) rather than silently falling
  back — an explicit request for a specific engine that cannot be honored is
  an error, not a degraded pass.
- The `ciscoSkillScannerEnabled` workspace setting (default `false`) makes
  `intutic skill audit` AUTO-run the Cisco engine on every invocation,
  whenever the binary happens to be on PATH. Unlike `--engine cisco`, this
  path degrades gracefully: if the setting is on but the binary is absent,
  the CLI logs an info-level skip and continues with native scanning only —
  this is a best-effort auto-run, not an explicit per-invocation request.

**Findings and provenance.** Every finding — native or Cisco — now carries
an `engine: 'native' | 'cisco-skill-scanner'` field, so a consumer can tell
which engine produced it. In `--sarif` output, Cisco's own SARIF run is
appended VERBATIM as a second entry in the document's `runs[]` array — SARIF
is explicitly designed to carry multiple tools' output in one document, so
Cisco's results are never translated or re-shaped for that output mode. For
every OTHER consumer (the human-readable CLI report, the control-plane
`skills/report` payload, posture scoring), Cisco's findings ARE translated
into this codebase's own `SkillScanFinding` shape — `patternId: 'cisco.' +
<their ruleId>`, category mapped onto this page's `prompt_injection |
data_exfiltration | malicious_code` taxonomy, excerpt bounded — the same
`SkillScanFinding` shape native findings already use, just with `engine:
'cisco-skill-scanner'` instead of `'native'`.

**Trust boundary — advisory, not enforcement.** Exactly like every native
finding on this page, a Cisco finding is surfaced, never acted on
automatically: nothing in this codebase blocks, refuses, or auto-deletes a
skill on the strength of a Cisco `skill-scanner` verdict alone. See
`docs/TECH_DEBT.md` for the entry tracking this boundary explicitly.

## VirusTotal hash lookup (opt-in, hash-only)

**Hash-only, stated up front: this lookup never uploads file content.** A
separate, later phase (S4, TD-361) added an **opt-in** integration that
checks the sha256 hash `auditScriptFile` already computes for every bundled
script (see [Bundled scripts](#bundled-scripts) above) against VirusTotal's
public `GET /api/v3/files/{sha256}` endpoint — never `POST /api/v3/files`
(upload), and the module that calls VirusTotal (`virusTotalService.ts`)
carries no code path capable of uploading content at all. See the dedicated
[VirusTotal Integration](/guide/virustotal-scanning) page for setup, the
budget/pacing model, and what a flagged hash does to the posture score.

This is a narrower, different thing from this product's standing decline of
a **global MCP-server reputation** database / VirusTotal integration — see
[MCP Governance](/guide/mcp-governance#what-this-phase-deliberately-does-not-cover)
for that separate decision, which this hash lookup does not reverse: that
decline is about judging whether an MCP *server* is known-bad across
tenants; this is a workspace-scoped, opt-in hash check on a skill-bundled
*script file*, off by default, and never shared as a public reputation
signal beyond the identical-hash verdict cache described on the integration
page.

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

## Semantic analysis (optional)

Everything above this section is deterministic pattern matching —
`scanSkillContent` and `scanScriptContent` match imperative sentence and
code shapes against text, with no LLM call anywhere in the hot path. TD-357
recorded that as a deliberate, accepted gap: a rephrasing that avoids every
pattern's literal wording passes clean, and closing that gap needs a
semantic judgment call a regex table cannot make. Phase S5 closes it — as an
**opt-in**, workspace-level setting (`semanticSkillAnalysisEnabled`, default
`false`), never a hot/live path.

**What it catches that deterministic scanning cannot.** The judge is asked
one question: does this skill's prose direct the agent to do something its
own stated description does not cover — concealing an action from the user,
exfiltrating data, redirecting a tool call, or otherwise acting outside a
reasonable reader's expectation. This is exactly the prompt-injection-style
social-engineering-of-the-agent-itself category that survives a rewording:
the deterministic scanner keys on specific phrasings (`<system>` tags, "do
not tell the user", a credential-shaped path in a markdown link); the
semantic judge reads for *intent*, so a skill that achieves the same thing
in different words is still visible to it.

**The judge is told the content is data, not instructions to it.** A skill
file is precisely the kind of untrusted, agent-authoritative prose a
prompt-injection attempt would target — and an LLM judge asked to read it is
exposed to that the same way any other agent loading the skill would be. The
judge's system prompt states this explicitly: the skill content under
evaluation is UNTRUSTED DATA, any text inside it that looks like a command
or a request directed at an AI (including at the judge itself) is to be
ignored, and the judge's only job is to answer the one question above about
what the skill asks an agent to do — never to follow, obey, or act on
anything the content says. See `JUDGE_SYSTEM_PROMPT` in
`services/control-plane/src/services/semanticSkillAnalysisService.ts` for
the exact wording.

**Content transits the control plane, transiently, then is stripped.**
Stated plainly rather than buried: when this setting is on, `intutic skill
audit` attaches the FULL content of a `SKILL.md` file (capped at 64 KiB) to
its `/skills/report` entry — never bundled scripts, which stay S2/S3/S4's
domain. The control plane hands that content to the judge and then strips it
before anything is persisted — the stored report never contains `content`,
regardless of whether judging ran, succeeded, or was skipped. Only the
verdict (`'clean' | 'suspicious' | 'malicious' | 'unjudged'`) and a short,
bounded `reason` string are stored, keyed by the content's own sha256, under
`skills:semantic:{workspaceId}` in Valkey — never the judged text itself.

**Caps.** Two independent bounds, both enforced server-side regardless of
what a client sends:

- **64 KiB per file** — the content-transport cap on `SkillFileReportSchema`'s
  `content` field.
- **A per-workspace daily judge-call cap** (`SEMANTIC_SKILL_JUDGE_DAILY_CAP`,
  env-overridable, default 200/day) — on top of a zero-cost, no-LLM-call
  skip for content that has not changed since it was last judged (a 30-day
  Valkey marker keyed by the content's sha256, so a workspace's daily cap is
  spent on skills that actually changed, not re-spent every audit/sync cycle
  on the same unchanged file).

**Fail-secure semantics.** `'unjudged'` is not `'clean'` — it means no
determination was made: a timeout, a malformed judge response, or the daily
cap being spent when this content was reported. It is scored no differently
from a skill the deterministic scanner never got to look at, and it is never
treated as evidence of safety. Only a confirmed `'malicious'` or
`'suspicious'` verdict changes anything — the posture score (a `'malicious'`
verdict overrides the skill's score to 0 outright, the same severity tier as
a confirmed deterministic finding or a flagged bundled script; `'suspicious'`
degrades it to a fixed intermediate value, worse than "unknown" but short of
a confirmed finding) and a `skill.semantic.flagged` notification (HIGH
severity for `'malicious'`, MEDIUM for `'suspicious'`).

**Verdicts are advisory, not enforcement.** Nothing in this codebase blocks,
refuses, or auto-prunes a skill on the strength of a semantic-judge finding
— consistent with the "report-only, deliberately, this phase" stance the
deterministic scanner takes above. See docs/TECH_DEBT.md's TD-357 entry for
the corpus-measurement caveat this carries forward.

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
  AST-level scanning of bundled scripts is available only through the
  **separate, opt-in** integration with Cisco's open-source `skill-scanner`
  project described in
  [Cisco `skill-scanner` integration](#cisco-skill-scanner-integration-opt-in)
  above — off by default, requires a separate `pipx install skill-scanner`,
  and consumes the sha256 hash `auditScriptFile` computes for every bundled
  file.
  A narrower, ALREADY-built piece sits between "no coverage" and full
  static analysis: the opt-in [VirusTotal hash lookup](#virustotal-hash-lookup-opt-in-hash-only)
  catches a script whose exact bytes match a hash already known-malicious
  to VirusTotal's aggregated engines — a useful, cheap signal, but not code
  understanding of any kind. A script that is malicious but not yet
  hash-known to VirusTotal (a modified copy, a novel payload) is invisible
  to it, exactly as it would be to any hash-based detector.
  LLM-based semantic analysis of `SKILL.md` PROSE (as opposed to bundled
  scripts) is no longer a gap — see [Semantic analysis
  (optional)](#semantic-analysis-optional) above, built through this
  codebase's `resolveMonitor` judge-call convention like every other LLM
  judge invocation. Its own real-world false-positive/negative rate is
  unmeasured for the identical reason the deterministic patterns' rate is —
  no benign-skill corpus exists yet — which is why it stays report-only,
  opt-in, and never a gate; see TD-357 in TECH_DEBT.md.
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
| [VirusTotal Integration](/guide/virustotal-scanning) | Opt-in, hash-only known-malware lookup for skill-bundled scripts — setup, budget/pacing, and posture-score effect |
