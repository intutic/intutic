# Benign-skill corpus provenance

350 real `SKILL.md` files, used by `../../skillScanCorpus.test.ts` to measure
the false-positive rate of `scanSkillContent` (`src/skillScan.ts`). Skill-CONTENT
enforcement was held at warn until this measurement existed.

Every source is **external and public**, and none was written or chosen for
this scanner. That is the property the measurement depends on, the same one
`packages/proxy/tests/corpus/PROVENANCE.md` states for the proxy's detectors.

## Sources

Each file was fetched from `raw.githubusercontent.com` at the pinned commit in
`MANIFEST.tsv` (fetched 2026-10-03). `fetch.sh` reproduces the corpus, and
`SHA256SUMS` lets you check it byte for byte.

| Directory | Upstream | Commit | Licence | Skills |
|---|---|---|---|---|
| `anthropics-skills/` | github.com/anthropics/skills | `8a1541c4a3ff` | Apache-2.0 (per-skill `LICENSE.txt`) | 14 |
| `obra-superpowers/` | github.com/obra/superpowers | `8ca22dba9a94` | MIT | 15 |
| `wshobson-agents/` | github.com/wshobson/agents | `156b7a5e7a8b` | MIT | 184 |
| `k-dense-scientific-skills/` | github.com/K-Dense-AI/claude-scientific-skills | `154988403bb5` | MIT | 137 |

The licence texts are vendored in `LICENSES/`, as Apache-2.0 §4 and MIT
require for redistribution. The files are unmodified.

### What was left out, and why

- **anthropics/skills:** `docx`, `pdf`, `pptx`, `xlsx` (their `LICENSE.txt`
  says "All rights reserved" and the README calls them source-available, not
  open source), plus `doc-coauthoring` and `template`, which have no
  per-skill licence file. Only skills whose own `LICENSE.txt` is the Apache
  2.0 text were included.
- **K-Dense-AI/claude-scientific-skills:** the repo is MIT, but many skills
  declare a different `license:` in their frontmatter, usually the licence of
  the library they wrap (GPL, BSD, CC-BY-NC, PolyForm, "Unknown"). To avoid
  arguing about which licence covers the skill text, only skills whose
  frontmatter `license:` starts with `MIT` or `Apache` were included (137 of
  177).
- **trailofbits/skills** (CC-BY-SA-4.0) and the **openai/skills** Figma and
  Notion skills (vendor terms) were not used. Neither licence is MIT or
  Apache-2.0.

Only `SKILL.md` is vendored, because that is the file the sync daemon's
per-cycle scan reads (`collectSkills` in `agentReporter.ts`) and the file a
skill-directory write usually targets. Bundled scripts are the job of
`scriptScan.ts`, which this corpus does not measure.

Before anything was committed, the corpus was checked for credential-shaped
values with `SECRET_VALUE_PATTERNS` and the usual Stripe, Slack, Google,
Hugging Face, OpenAI, JWT and npm shapes. The only matches were two
`sk_test_...` placeholders and one `password="secret"` example.

## Bias statement: read this before quoting a number from here

- **Curated, not representative.** These are published collections, mostly
  maintained, many reviewed. A developer's own `.claude/skills/` is a longer
  and messier tail. Treat every rate here as a **lower bound**.
- **Zero is a bound, not a proof.** No hits in 350 files puts the 95% upper
  bound on a pattern's per-skill false-positive rate at about 0.86% (the
  rule of three). That is enough to license a block that one sync cycle can
  retract (`SKILL_CONTENT_TIER_SEVERITY`). It is not enough to call any
  pattern perfect.
- **One source dominates.** wshobson/agents is 184 of the 350, and its skills
  read alike: long technical how-tos with code blocks. K-Dense (137) is mostly
  scientific-library wrappers. The discursive, process-style skills that carry
  the most imperative security language come mainly from obra/superpowers and
  anthropics/skills (29 between them), so that genre is thinly sampled.
- **No recall.** Every file is benign, so nothing here measures what the
  scanner catches. No vendored corpus of real poisoned skills exists.

## Refreshing

1. Pin new commits in `MANIFEST.tsv`. Use commit SHAs, never branch names.
2. Run `./fetch.sh --write-sums`.
3. Run the corpus test with `INTUTIC_WRITE_BASELINE=1`, **read every new
   hit in context**, and add it to `REVIEWED_FALSE_POSITIVES` only after
   confirming it is benign.
4. If a block-eligible pattern now fires, remove it from
   `SKILL_CONTENT_BLOCK_PATTERN_IDS` in the same change. The test enforces
   this.
