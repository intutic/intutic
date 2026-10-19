/**
 * The docs-tables gate (tools/scripts/check-doc-tables.js): tables and
 * diagrams that restate a code enum must say what the code says. These run
 * the real script against a small fixture tree with the same shapes as the
 * real sources, and break one thing at a time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-doc-tables.js')

function runGate(root: string): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

const ENUMS = `export const EnforcementAction = {
  BYPASS: 'BYPASS',
  HIJACK: 'HIJACK',
  KILL: 'KILL',
  OBSERVED: 'OBSERVED',
} as const

export const SopLifecycleState = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  GENERATED: 'GENERATED',
  VALIDATED: 'VALIDATED',
  INVALIDATED: 'INVALIDATED',
} as const
`
const SOP = `export const VALID_SOP_TRANSITIONS: ReadonlyArray<{ from: S; to: S; description: string }> = [
  { from: 'DRAFT', to: 'PENDING_REVIEW', description: 'a' },
  { from: 'PENDING_REVIEW', to: 'DRAFT', description: 'b' },
  { from: 'PENDING_REVIEW', to: 'GENERATED', description: 'c' },
  { from: 'GENERATED', to: 'VALIDATED', description: 'd' },
  { from: 'VALIDATED', to: 'INVALIDATED', description: 'e' },
  { from: 'VALIDATED', to: 'PENDING_REVIEW', description: 'f' },
] as const
`
// The chain on one line, the rest box-drawn below it, as the real diagrams are.
const DIAGRAM = [
  'DRAFT ↔ PENDING_REVIEW → GENERATED → VALIDATED',
  `${' '.repeat(14)}↑${' '.repeat(24)}│${' '.repeat(5)}│`,
  `${' '.repeat(14)}│${' '.repeat(24)}↓${' '.repeat(5)}│`,
  `${' '.repeat(14)}│${' '.repeat(18)}INVALIDATED │`,
  `${' '.repeat(14)}└${'─'.repeat(8)} re-review ${'─'.repeat(11)}┘`,
].join('\n')
const MOD_RS = `pub const ALL_KINDS: [AnomalyKind; 3] = [AnomalyKind::LoopDetected, AnomalyKind::ToolAbuse, AnomalyKind::TokenWaste];

impl AnomalyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LoopDetected => "LOOP_DETECTED",
            Self::ToolAbuse => "TOOL_ABUSE",
            Self::TokenWaste => "TOKEN_WASTE",
        }
    }
}

impl DetectorRegistry {
    pub fn with_defaults() -> Self {
        use detectors::*;
        Self {
            detectors: vec![
                Box::new(ConsecutiveRepeatDetector::default()),
                Box::new(CodeAsActionDetector),
            ],
        }
    }
}
`
const DETECTORS_RS = `pub struct ConsecutiveRepeatDetector;

impl AnomalyDetector for ConsecutiveRepeatDetector {
    fn id(&self) -> &'static str {
        "consecutive_repeat"
    }

    fn kind(&self) -> AnomalyKind {
        AnomalyKind::LoopDetected
    }
}

impl AnomalyDetector for CodeAsActionDetector {
    fn id(&self) -> &'static str {
        "code_as_action"
    }

    fn kind(&self) -> AnomalyKind {
        AnomalyKind::ToolAbuse
    }

    fn detect(&self) {
        let kind = AnomalyKind::TokenWaste;
    }
}
`
const OPERATIONS = {
  operations: [{ ts: 'listProviderModels', py: 'list_provider_models', cli: 'credentials models' }],
  offline: [{ ts: 'verifyEvidenceArchive', py: 'verify_evidence_archive', cli: 'compliance verify' }],
  excluded: { login: 'session establishment', 'policy compile|install': 'local', 'traces (no credentials)': 'local log' },
}
const CLAWDE_PAGE = `# clawde

### What's covered

\`listProviderModels\` (\`list_provider_models\`) returns the models. \`verifyEvidenceArchive\` (\`verify_evidence_archive(path)\`) checks an archive.

Not covered, on purpose: session establishment (\`intutic login\`), \`traces\` with no credentials, and \`policy compile\` and \`install\`.

## Events
`
const TIER_PAGE = `# Tier Matrix

| | Self-serve | Self-host |
|---|:---:|:---:|
| [SIEM export](/guide/siem-export) | | ✓ |
| Runs in your VPC or an air-gapped network | | ✓ |
`
const PLAN_SKU_MAP = `export const planSkuMap: Record<string, PlanSku> = {
  free: {
    displayName:                   'Free',
    billing:                       'none',
    siemExportEnabled:             false,
  },
  self_serve: {
    displayName:                   'Self-serve',
    billing:                       'usage',
    siemExportEnabled:             false,
  },
  ent_lic: {
    displayName:                   'Self-host',
    billing:                       'license',
    siemExportEnabled:             true,
  },
} as const
`

const ACTION_TABLE = '| Action | What happens |\n|---|---|\n| **BYPASS** | passes |\n| **HIJACK** | steered |\n| **KILL** | blocked |\n'
const STATE_TABLE = '| State | Meaning |\n|---|---|\n| `DRAFT` | a |\n| `PENDING_REVIEW` | b |\n| `GENERATED` | c |\n| `VALIDATED` | d |\n| `INVALIDATED` | e |\n'

let root: string
const put = async (rel: string, body: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), body)
}
const edit = async (rel: string, from: string, to: string) => {
  const text = await readFile(join(root, rel), 'utf8')
  if (!text.includes(from)) throw new Error(`fixture ${rel} has no ${JSON.stringify(from)}`)
  await writeFile(join(root, rel), text.replace(from, to))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'doctables-'))
  await put('packages/shared-types/src/enums.ts', ENUMS)
  await put('packages/shared-types/src/sop.ts', SOP)
  await put('packages/proxy/src/plugins/anomaly/mod.rs', MOD_RS)
  await put('packages/proxy/src/plugins/anomaly/detectors.rs', DETECTORS_RS)
  // The graph detectors' own file, which the gate reads beside detectors.rs.
  await put('packages/proxy/src/plugins/anomaly/graph_detectors.rs', '// No graph detectors in this fixture.\n')
  await put('packages/shared-types/fixtures/control-plane-operations.json', JSON.stringify(OPERATIONS))
  for (const p of ['concepts/enforcement-actions.md', 'guide/concepts.md', 'guide/policies.md']) {
    await put(`apps/docs/${p}`, `# Page\n\nEvery call gets one of three verdicts:\n\n${ACTION_TABLE}`)
  }
  await put('apps/docs/guide/how-it-works.md', `# How it works\n\n${ACTION_TABLE}\nSOPs follow a 5-state lifecycle:\n\n\`\`\`\n${DIAGRAM}\n\`\`\`\n\n${STATE_TABLE}`)
  for (const p of ['concepts/sops.md', 'guide/sops.md', 'reference/sop-format.md']) {
    await put(`apps/docs/${p}`, `# SOPs\n\n\`\`\`\n${DIAGRAM}\n\`\`\`\n`)
  }
  await put(
    'apps/docs/guide/graph-guardrails.md',
    '# Graph\n\n| Detector | Fires on | Category |\n|---|---|---|\n| Consecutive repeat | 5 in a row | `LOOP_DETECTED` |\n| Code as action | bundled egress | `TOOL_ABUSE` / `TOKEN_WASTE` |\n\nThat is **3 of the 3** runtime anomaly categories.\n',
  )
  await put('apps/docs/reference/clawde-sdk.md', CLAWDE_PAGE)
  await put('apps/docs/guide/tier-matrix.md', TIER_PAGE)
  await put(
    'apps/docs/data/plans.json',
    JSON.stringify([
      { id: 'self_serve', name: 'Self-serve', billing: 'usage' },
      { id: 'ent_lic', name: 'Self-host', billing: 'license' },
    ]),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const fails = async (says: string) => {
  const r = await runGate(root)
  expect(r.status, r.out).toBe(1)
  expect(r.out).toContain(says)
}

describe('docs tables and diagrams', () => {
  it('passes a tree where every table and diagram matches its source, open-core checkout included', async () => {
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('4 diagram(s) checked against the 6 transitions')
    expect(r.out).toContain('2 row(s) for 2 registered detector(s)')
    expect(r.out).toContain('[SKIP] services/control-plane/src/lib/planSkuMap.ts is not in this checkout')
  })

  it('fails an enforcement-action table missing an action, or naming one the enum lacks', async () => {
    await edit('apps/docs/guide/policies.md', '| **HIJACK** | steered |', '| **REDIRECT** | steered |')
    await fails('apps/docs/guide/policies.md:5: the enforcement-action table lists REDIRECT')
    await fails('apps/docs/guide/policies.md:5: the enforcement-action table is missing HIJACK')
  })

  it('fails an action count that is not the ladder', async () => {
    await edit('apps/docs/guide/concepts.md', 'one of three verdicts', 'one of four verdicts')
    await fails('"one of four verdicts" — the ladder has 3 actions (BYPASS, HIJACK, KILL)')
  })

  it('fails a lifecycle diagram whose box-drawn arrow no longer reaches its state', async () => {
    await edit('apps/docs/guide/sops.md', '↑', '│')
    await fails('apps/docs/guide/sops.md:4: the lifecycle diagram does not draw VALIDATED → PENDING_REVIEW')
  })

  it('fails a lifecycle diagram that draws a transition the code does not allow', async () => {
    await edit('apps/docs/reference/sop-format.md', 'GENERATED → VALIDATED', 'GENERATED ↔ VALIDATED')
    await fails('apps/docs/reference/sop-format.md:4: the lifecycle diagram draws VALIDATED → GENERATED')
  })

  it('fails a state table missing a state, and a wrong state count', async () => {
    await edit('apps/docs/guide/how-it-works.md', '| `INVALIDATED` | e |\n', '')
    await edit('apps/docs/guide/how-it-works.md', '5-state lifecycle', '6-state lifecycle')
    await fails('the SOP lifecycle table is missing INVALIDATED')
    await fails('"6-state lifecycle" — SopLifecycleState has 5 states')
  })

  it('fails a detector row with the wrong category, and a registered detector with no row', async () => {
    await edit('apps/docs/guide/graph-guardrails.md', '`TOOL_ABUSE` / `TOKEN_WASTE`', '`TOOL_ABUSE`')
    await fails('the "Code as action" row says TOOL_ABUSE; code_as_action reports TOKEN_WASTE / TOOL_ABUSE')
    await edit('apps/docs/guide/graph-guardrails.md', '| Consecutive repeat | 5 in a row | `LOOP_DETECTED` |\n', '')
    await fails('detector consecutive_repeat is registered')
  })

  it('fails a category count that is not the registered detectors\'', async () => {
    await edit('apps/docs/guide/graph-guardrails.md', '**3 of the 3**', '**2 of the 3**')
    await fails('the registered detectors report 3 of the 3 kinds in ALL_KINDS')
  })

  it("fails a What's covered method with the wrong Python name, and an excluded command left unnamed", async () => {
    await edit('apps/docs/reference/clawde-sdk.md', '(`list_provider_models`)', '(`list_models`)')
    await edit('apps/docs/reference/clawde-sdk.md', '`traces` with no credentials, ', '')
    await fails("gives `listProviderModels`'s Python name as `list_models`")
    await fails('does not name `traces`')
  })

  it('fails a command called not covered that a method covers', async () => {
    await edit('apps/docs/reference/clawde-sdk.md', 'and `policy compile`', '`credentials models`, and `policy compile`')
    await fails('says `credentials models` is not covered')
  })

  it('checks the tier-matrix ticks against planSkuMap.ts where it exists', async () => {
    await put('services/control-plane/src/lib/planSkuMap.ts', PLAN_SKU_MAP)
    const ok = await runGate(root)
    expect(ok.status, ok.out).toBe(0)
    expect(ok.out).toContain('4 tick(s) against their flags')
    await edit('apps/docs/guide/tier-matrix.md', '| [SIEM export](/guide/siem-export) | | ✓ |', '| [SIEM export](/guide/siem-export) | ✓ | ✓ |')
    await fails('"SIEM export" is ticked for Self-serve, but self_serve.siemExportEnabled is false')
  })

  it('fails tier-matrix columns that are not the paid plans', async () => {
    await edit('apps/docs/guide/tier-matrix.md', '| | Self-serve | Self-host |', '| | Self-serve | Enterprise |')
    await fails('the plan columns are Self-serve, Enterprise; the paid plans are Self-serve, Self-host')
  })
})
