/**
 * The Python SDK's TypedDicts and the Terraform provider's response structs
 * name only fields the control plane sends.
 *
 * Both decode control-plane responses with no schema of their own: a
 * TypedDict is a type hint and Go's JSON decoder fills a struct field the
 * response lacks with its zero value, so a renamed or invented field reads as
 * `None`, `""` or `false` forever and nothing fails. Each type below is
 * pinned to the response schema (`src/responses/`) it decodes, which the
 * control plane's tests hold to the real routes: every field the type
 * declares must be a field of that schema at the given place. The TypeScript
 * SDK's types are held to the same schemas at compile time
 * (`packages/clawde-sdk/__tests__/response-types/`).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { ZodTypeAny } from 'zod'
import * as R from '../responses/index.js'

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(`${PACKAGES}${path}`, 'utf8')

/** Field names a Python TypedDict class declares (`name: type` lines of its body). */
export function typedDictFields(src: string, name: string): string[] {
  const start = src.search(new RegExp(`^class ${name}\\(`, 'm'))
  if (start === -1) throw new Error(`no TypedDict ${name}`)
  const body = src.slice(src.indexOf('\n', start) + 1)
  const fields: string[] = []
  for (const line of body.split('\n')) {
    if (line.trim() && !/^\s/.test(line)) break
    const m = line.match(/^ {4}([A-Za-z_]\w*)\s*:/)
    if (m) fields.push(m[1]!)
  }
  return fields
}

/** JSON names a Go struct's fields carry (`json:"name"` tags). */
export function goStructFields(src: string, name: string): string[] {
  const start = src.search(new RegExp(`^type ${name} struct \\{`, 'm'))
  if (start === -1) throw new Error(`no struct ${name}`)
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/json:"([^",]+)/g)].map((m) => m[1]!).filter((n) => n !== '-')
}

/**
 * The field names of the object at `path` in `schema`: `''` is the body,
 * `a.b` a nested object, `a[]` the rows of the array at `a`. Optional,
 * nullable and union wrappers are seen through (a union offers every
 * branch's fields).
 */
export function fieldsAt(schema: ZodTypeAny, path: string): Set<string> {
  const def = schema._def as Record<string, any> & { typeName: string }
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
      return fieldsAt(def.innerType, path)
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      // The branches that have something at `path` (a TOON list's `data` is a string, not rows).
      const found = [...(def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>).values()].flatMap((o) => {
        try {
          return [fieldsAt(o, path)]
        } catch {
          return []
        }
      })
      if (!found.length) break
      return new Set(found.flatMap((f) => [...f]))
    }
    case 'ZodIntersection':
      return new Set([...fieldsAt(def.left, path), ...fieldsAt(def.right, path)])
    case 'ZodArray':
      if (path.startsWith('[]')) return fieldsAt(def.type, path.slice(2).replace(/^\./, ''))
      break
    case 'ZodObject': {
      const shape = def.shape() as Record<string, ZodTypeAny>
      if (!path) return new Set(Object.keys(shape))
      const m = path.match(/^([^.[]+)(.*)$/)!
      const next = shape[m[1]!]
      if (!next) throw new Error(`no field ${m[1]} in the schema`)
      return fieldsAt(next, m[2]!.replace(/^\./, ''))
    }
  }
  throw new Error(`cannot read fields at "${path}" of a ${def.typeName}`)
}

/** A client type and every response it decodes: [schema, path] pairs; it may name a field any of them sends. */
type Pin = [type: string, sends: Array<[schema: ZodTypeAny, path: string]>]

/** Python SDK TypedDicts (`intutic_clawde/types.py`) and the response each decodes. */
const PYTHON: Pin[] = [
  ['SigningJwks', [[R.TraceSigningJwksResponse, '']]],
  ['GatewayStatus', [[R.GatewayStatusResponse, '']]],
  ['PolicySourceSyncResult', [[R.ConnectorSyncResponse, '']]],
  ['GuardrailTransitionResult', [[R.GuardrailTransitionResponse, ''], [R.GuardrailPromoteResponse, '']]],
  ['AuthoredGuardrailWriteResult', [[R.GuardrailWriteResponse, '']]],
  ['GuardrailReplay', [[R.GuardrailReplayResponse, 'replay']]],
  ['PolicyChangeResult', [[R.PolicyVersionResponse, '']]],
  ['RuleCandidateSource', [[R.RuleCandidateSourceResponse, '']]],
  ['BundleUploadResult', [[R.RuleCandidateBundleResponse, '']]],
  ['WasmReplayResult', [[R.WasmRuleReplayResponse, '']]],
  ['SopCreateResult', [[R.SopCreatedResponse, '']]],
  ['DecisionReviewResult', [[R.DecisionReviewResponse, '']]],
  ['Incident', [[R.IncidentDetailResponse, 'data'], [R.IncidentListResponse, 'data[]']]],
  ['IncidentList', [[R.IncidentListResponse, '']]],
  ['TraceList', [[R.TraceListResponse, '']]],
  ['FindingAdjudication', [[R.FindingAdjudicationResponse, '']]],
  ['FindingStats', [[R.FindingStatsResponse, '']]],
  ['ResponseEchoReport', [[R.ResponseEchoReportResponse, '']]],
  ['IntegrityRootList', [[R.IntegrityRootListResponse, '']]],
  ['IntegrityRootDetail', [[R.IntegrityRootDetailResponse, '']]],
  ['IntegrityRecompute', [[R.IntegrityRecomputeResponse, '']]],
  ['IntegrityChain', [[R.IntegrityChainResponse, '']]],
  ['ConfigChain', [[R.IntegrityConfigChainResponse, '']]],
  ['InventorySummary', [[R.InventorySummaryResponse, 'data']]],
  ['DeviceDisconnect', [[R.DeviceDisconnectListResponse, 'data[]']]],
  ['MemberUsageResponse', [[R.MemberUsageListResponse, '']]],
  ['TeamUsageResponse', [[R.TeamUsageListResponse, '']]],
  ['BranchUsageResponse', [[R.BranchUsageListResponse, '']]],
  ['CommitUsageResponse', [[R.CommitUsageListResponse, '']]],
  ['PullRequestUsageResponse', [[R.PullRequestUsageListResponse, '']]],
  ['PullRequestRefreshResult', [[R.PullRequestRefreshResponse, '']]],
  ['LoopRunActionResult', [[R.LoopRunCompleteResponse, ''], [R.LoopRunKillResponse, ''], [R.LoopRunReviewResponse, '']]],
  ['McpServerList', [[R.McpServerListResponse, '']]],
  ['McpServer', [[R.McpServerListResponse, 'servers[]']]],
  ['McpServerDecision', [[R.McpServerDecisionResponse, '']]],
  ['NotificationRule', [[R.NotificationRuleResponse, '']]],
  ['NotificationChannelConfig', [[R.NotificationRuleResponse, 'channelConfig']]],
  ['NotificationFilters', [[R.NotificationRuleResponse, 'filters']]],
  ['NotificationSecretRotation', [[R.NotificationRuleSigningSecretResponse, '']]],
  ['SiemDestinationList', [[R.SiemDestinationListResponse, '']]],
  ['SiemDestination', [[R.SiemDestinationResponse, ''], [R.SiemDestinationCreatedResponse, ''], [R.SiemDestinationUpdatedResponse, '']]],
  ['SiemSources', [[R.SiemDestinationListResponse, 'sources']]],
  ['SiemSecretRotation', [[R.SiemSigningSecretResponse, '']]],
  ['FrameworkCoverage', [[R.FrameworkCoverageResponse, '']]],
  ['FrameworkCoverageSummary', [[R.FrameworkCoverageResponse, 'summary']]],
  ['EvidenceCollectResult', [[R.Soc2CollectResponse, '']]],
  ['GateLiveness', [[R.GateLivenessResponse, '']]],
  ['GateStatus', [[R.GateLivenessResponse, 'gates[]']]],
  ['GitHubWebhookInfo', [[R.GitHubWebhookResponse, '']]],
  ['GitHubWebhookSecret', [[R.GitHubWebhookSecretResponse, '']]],
  ['AttenuationResult', [[R.AttenuationResponse, '']]],
  ['CostPrediction', [[R.CostPredictionResponse, '']]],
]

/** Terraform provider structs (`internal/provider/<file>.go`) and the response each decodes. */
const TERRAFORM: Array<[file: string, ...Pin]> = [
  ['virtual_key_resource', 'apiKey', [[R.ApiKeyListResponse, 'data[]'], [R.ApiKeyCreateResponse, ''], [R.ApiKeyResponse, '']]],
  ['member_budget_resource', 'memberBudgetsList', [[R.BudgetMembersResponse, ''], [R.BudgetMembersResponse, 'members[]']]],
  ['workspace_budget_resource', 'apiWorkspaceBudget', [[R.BudgetStatusResponse, '']]],
  ['spend_budgets', 'spendBudget', [[R.BudgetMembersResponse, 'defaultBudgets[]']]],
  ['gateway_resource', 'apiGateway', [[R.GatewayRegisterResponse, ''], [R.GatewayListResponse, 'data[]']]],
  ['gateway_resource', 'apiGatewayCfg', [[R.GatewayListResponse, 'data[].config']]],
  ['provider_credential_resource', 'apiProviderCredential', [[R.ProviderCredentialListResponse, 'data[]']]],
  ['guardrail_resource', 'apiGuardrail', [[R.GuardrailDetailResponse, 'guardrail']]],
  ['guardrail_resource', 'guardrailWrite', [[R.GuardrailWriteResponse, '']]],
  ['policy_resource', 'apiPolicy', [[R.PolicyListResponse, 'policies[]']]],
  ['wasm_rule_resource', 'apiWasmRule', [[R.WasmRuleResponse, '']]],
  ['sop_resource', 'apiSop', [[R.SopResponse, '']]],
  ['notification_rule_resource', 'apiRule', [[R.NotificationRuleResponse, '']]],
  ['notification_rule_resource', 'apiChannelConfig', [[R.NotificationRuleResponse, 'channelConfig']]],
  ['notification_rule_resource', 'apiFilters', [[R.NotificationRuleResponse, 'filters']]],
  ['siem_destination_resource', 'apiSiemDestination', [[R.SiemDestinationResponse, ''], [R.SiemDestinationCreatedResponse, ''], [R.SiemDestinationUpdatedResponse, '']]],
  ['mcp_server_decision_resource', 'apiMcpServer', [[R.McpServerListResponse, 'servers[]']]],
  ['mcp_server_decision_resource', 'apiMcpToolChange', [[R.McpServerListResponse, 'servers[].lastToolChange']]],
]

describe('client response types', () => {
  it('reads the declarations it checks', () => {
    expect(typedDictFields('class A(TypedDict, total=False):\n    """Doc."""\n    a: str\n    #: note\n    b_c: Optional[int]\n\n\nclass B(TypedDict):\n    z: str\n', 'A')).toEqual(['a', 'b_c'])
    expect(goStructFields('type a struct {\n\tA string `json:"a"`\n\tB *int `json:"b,omitempty"`\n\tC int `json:"-"`\n}\n', 'a')).toEqual(['a', 'b'])
    expect([...fieldsAt(R.OrgSopListResponse, 'data[]')]).toContain('orgSopId')
  })

  const sentBy = (sends: Pin[1]) => new Set(sends.flatMap(([schema, path]) => [...fieldsAt(schema, path)]))

  it.each(PYTHON)('Python %s names only fields its responses send', (type, sends) => {
    const sent = sentBy(sends)
    expect(typedDictFields(read('intutic-clawde/intutic_clawde/types.py'), type).filter((f) => !sent.has(f))).toEqual([])
  })

  it.each(TERRAFORM)('Terraform %s %s names only fields its responses send', (file, type, sends) => {
    const sent = sentBy(sends)
    expect(goStructFields(read(`terraform-provider-intutic/internal/provider/${file}.go`), type).filter((f) => !sent.has(f))).toEqual([])
  })
})
