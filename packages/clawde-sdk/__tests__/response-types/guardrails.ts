/** SDK response types of the policy-guardrail and connector routes, against their schemas. */
import type {
  ConnectorCreateResponse,
  ConnectorListResponse,
  ConnectorSyncResponse,
  GuardrailConflictListResponse,
  GuardrailCoverageResponse,
  GuardrailDetailResponse,
  GuardrailListResponse,
  GuardrailPromoteResponse,
  GuardrailReadinessResponse,
  GuardrailReplayResponse,
  GuardrailTransitionResponse,
  GuardrailWriteResponse,
  LedgerDuplicatesResponse,
  LedgerImpactResponse,
  PassageSearchResponse,
  PolicyDocumentListResponse,
  PolicyDocumentResponse,
  PolicyExtractResponse,
} from '@intutic/shared-types'
import type {
  AuthoredGuardrailWriteResult,
  ExtractDocumentResult,
  GuardrailConflict,
  GuardrailDeleteResult,
  GuardrailDetail,
  GuardrailReadiness,
  GuardrailReplay,
  GuardrailSummary,
  GuardrailTransitionResult,
  LedgerDuplicates,
  LedgerImpact,
  PassageSearchResult,
  PolicyDocumentDetail,
  PolicyDocumentSummary,
  PolicySource,
  PolicySourceSyncResult,
  TokenCoverage,
} from '../../src/types'
import { conforms, type Rows } from './conforms'

// The connector routes answer for every provider (memory providers too) with
// `provider` a string. `PolicySource.provider` is the narrower source-provider
// union because the SDK only ever holds a source row: `listPolicySources`
// filters to POLICY_SOURCE_PROVIDERS, and `addPolicySource` sends one, which
// the create answer echoes. Every other field is checked as is.
type SourceRow = Omit<PolicySource, 'provider'>

// listPolicySources: GET /api/v1/connectors, unwrapped from `items`; addPolicySource: POST /api/v1/connectors.
// One type holds both answers, so it may name a field only one of them sends.
conforms<SourceRow>()<Rows<ConnectorListResponse, 'items'> | ConnectorCreateResponse>()
// syncPolicySource: POST /api/v1/connectors/:connectorId/sync
conforms<PolicySourceSyncResult>()<ConnectorSyncResponse>()

// listPolicyDocuments: GET /api/v1/policy-guardrails/documents, unwrapped from `documents`
conforms<PolicyDocumentSummary>()<Rows<PolicyDocumentListResponse, 'documents'>>()
// getPolicyDocument: GET /api/v1/policy-guardrails/documents/:docId, unwrapped from `document`
conforms<PolicyDocumentDetail>()<PolicyDocumentResponse['document']>()
// extractPolicyDocument: POST /api/v1/policy-guardrails/documents/:docId/extract, unwrapped from `result`
conforms<ExtractDocumentResult>()<PolicyExtractResponse['result']>()
// getGuardrailCoverage: GET /api/v1/policy-guardrails/coverage, unwrapped from `coverage`
conforms<TokenCoverage>()<GuardrailCoverageResponse['coverage']>()
// searchPolicyPassages: GET /api/v1/policy-guardrails/search, unwrapped from `search`
conforms<PassageSearchResult>()<PassageSearchResponse['search']>()
// getGuardrailImpact: GET /api/v1/policy-guardrails/impact, unwrapped from `impact`
conforms<LedgerImpact>()<LedgerImpactResponse['impact']>()
// listGuardrailDuplicates: GET /api/v1/policy-guardrails/duplicates, unwrapped from `duplicates`
conforms<LedgerDuplicates>()<LedgerDuplicatesResponse['duplicates']>()
// listGuardrailConflicts: GET /api/v1/policy-guardrails/conflicts, unwrapped from `conflicts`
conforms<GuardrailConflict>()<Rows<GuardrailConflictListResponse, 'conflicts'>>()

// listGuardrails: GET /api/v1/policy-guardrails/guardrails, unwrapped from `guardrails`
conforms<GuardrailSummary>()<Rows<GuardrailListResponse, 'guardrails'>>()
// getGuardrail: GET /api/v1/policy-guardrails/guardrails/:guardrailId, unwrapped from `guardrail`
conforms<GuardrailDetail>()<GuardrailDetailResponse['guardrail']>()
// getGuardrailReadiness: GET …/guardrails/:guardrailId/readiness, unwrapped from `readiness`
conforms<GuardrailReadiness>()<GuardrailReadinessResponse['readiness']>()
// replayGuardrail: POST …/guardrails/:guardrailId/replay, unwrapped from `replay`
conforms<GuardrailReplay>()<GuardrailReplayResponse['replay']>()
// createGuardrail: POST /api/v1/policy-guardrails/guardrails; updateGuardrail: PUT …/guardrails/:guardrailId
conforms<AuthoredGuardrailWriteResult>()<GuardrailWriteResponse>()
// deleteGuardrail: DELETE …/guardrails/:guardrailId
conforms<GuardrailDeleteResult>()<GuardrailTransitionResponse>()
// approveGuardrailShadow, rejectGuardrail, retireGuardrail, reconfirmGuardrail: POST …/guardrails/:guardrailId/<action>;
// promoteGuardrail: POST …/guardrails/:guardrailId/promote (the one that sends `readiness`)
conforms<GuardrailTransitionResult>()<GuardrailTransitionResponse | GuardrailPromoteResponse>()
