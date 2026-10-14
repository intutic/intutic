/** SDK response types of the policy, WASM rule, SOP and decision routes, against their schemas. */
import type {
  DecisionReviewResponse,
  PolicyListResponse,
  PolicyVersionResponse,
  RuleCandidateBundleResponse,
  RuleCandidateSourceResponse,
  SopCreatedResponse,
  SopListResponse,
  SopResponse,
  WasmRuleReplayResponse,
} from '@intutic/shared-types'
import type {
  BundleUploadResult,
  CompliancePolicy,
  DecisionReviewResult,
  PolicyChangeResult,
  RuleCandidateSource,
  SopCreateResult,
  SopDetail,
  SopSummary,
  WasmReplayResult,
} from '../../src/types'
import { conforms, type Rows } from './conforms'

// listPolicies: GET /api/v1/policies, unwrapped from `policies`. The handler
// always sends `conditions` (an object or null); zod types an `unknown`
// field as optional, so it is required here as the handler sends it.
conforms<CompliancePolicy>()<Rows<PolicyListResponse, 'policies'> & { conditions: unknown }>()
// enablePolicy / disablePolicy / rollbackPolicy: POST /api/v1/policies/:policyId/{enable,disable,rollback}
conforms<PolicyChangeResult>()<PolicyVersionResponse>()
// getRuleCandidateSource: GET /api/v1/rule-candidates/:candidateId/source
conforms<RuleCandidateSource>()<RuleCandidateSourceResponse>()
// uploadRuleCandidateBundle: POST /api/v1/rule-candidates/:candidateId/bundle (either answer)
conforms<BundleUploadResult>()<RuleCandidateBundleResponse>()
// replayWasmRule: POST /api/v1/wasm-rules/:ruleId/replay
conforms<WasmReplayResult>()<WasmRuleReplayResponse>()
// listSops: GET /api/v1/sops, unwrapped from `items`
conforms<SopSummary>()<Rows<SopListResponse, 'items'>>()
// getSop: GET /api/v1/sops/:sopId
conforms<SopDetail>()<SopResponse>()
// createSop: POST /api/v1/sops
conforms<SopCreateResult>()<SopCreatedResponse>()
// approveDecision / rejectDecision: POST /api/v1/decisions/:entryId/review
conforms<DecisionReviewResult>()<DecisionReviewResponse>()
