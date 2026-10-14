/** SDK response types of the incidents, traces, findings, integrity, inventory, usage and loop routes, against their schemas. */
import type {
  BranchUsageListResponse,
  CommitUsageListResponse,
  DeviceDisconnectListResponse,
  FindingAdjudicationResponse,
  FindingListResponse,
  FindingStatsResponse,
  IncidentDetailResponse,
  IncidentListResponse,
  IntegrityChainResponse,
  IntegrityConfigChainResponse,
  IntegrityRecomputeResponse,
  IntegrityRootDetailResponse,
  IntegrityRootListResponse,
  InventoryDeviceListResponse,
  InventoryHarnessListResponse,
  InventoryMcpServerListResponse,
  InventorySkillListResponse,
  InventorySummaryResponse,
  LoopRunCompleteResponse,
  LoopRunEnvelopeResponse,
  LoopRunKillResponse,
  LoopRunListResponse,
  LoopRunReviewResponse,
  MemberUsageListResponse,
  PullRequestRefreshResponse,
  PullRequestUsageListResponse,
  ResponseEchoReportResponse,
  TeamUsageListResponse,
  TraceDetailResponse,
  TraceListResponse,
} from '@intutic/shared-types'
import type {
  BranchUsageResponse,
  CommitUsageResponse,
  ConfigChain,
  DeviceDisconnect,
  Finding,
  FindingAdjudication,
  FindingStats,
  Incident,
  IncidentList,
  IntegrityChain,
  IntegrityRecompute,
  IntegrityRootDetail,
  IntegrityRootList,
  InventoryDevice,
  InventoryHarness,
  InventoryMcpServer,
  InventorySkill,
  InventorySummary,
  LoopRun,
  LoopRunActionResult,
  MemberUsageResponse,
  PullRequestRefreshResult,
  PullRequestUsageResponse,
  ResponseEchoReport,
  TeamUsageResponse,
  TraceDetail,
  TraceList,
} from '../../src/types'
import { conforms, type Rows } from './conforms'

/** A TOON-capable list as the SDK sees it: `unwrapToonEnvelope` has decoded the rows back into the plain form. */
type Decoded<Body> = Exclude<Body, { format: 'toon' }>

// listIncidents: GET /api/v1/incidents (TOON decoded)
conforms<IncidentList>()<Decoded<IncidentListResponse>>()
// getIncident: GET /api/v1/incidents/:id, unwrapped from `data`; also the rows of listIncidents (which add `review_priority`)
conforms<Incident>()<IncidentDetailResponse['data'] | Rows<Decoded<IncidentListResponse>, 'data'>>()
// listTraces: GET /api/v1/traces (TOON decoded)
conforms<TraceList>()<Decoded<TraceListResponse>>()
// getTrace: GET /api/v1/traces/:id
conforms<TraceDetail>()<TraceDetailResponse>()

// listFindings: GET /api/v1/findings, unwrapped from `findings`
conforms<Finding>()<Rows<FindingListResponse, 'findings'>>()
// adjudicateFinding: POST /api/v1/findings/:findingId/adjudicate
conforms<FindingAdjudication>()<FindingAdjudicationResponse>()
// getFindingStats: GET /api/v1/findings/stats
conforms<FindingStats>()<FindingStatsResponse>()
// getResponseEchoReport: GET /api/v1/findings/response-echo/report
conforms<ResponseEchoReport>()<ResponseEchoReportResponse>()

// listIntegrityRoots: GET /api/v1/integrity/roots
conforms<IntegrityRootList>()<IntegrityRootListResponse>()
// getIntegrityRoot: GET /api/v1/integrity/roots/:rootId
conforms<IntegrityRootDetail>()<IntegrityRootDetailResponse>()
// recomputeIntegrityRoot: POST /api/v1/integrity/roots/:rootId/recompute
conforms<IntegrityRecompute>()<IntegrityRecomputeResponse>()
// getIntegrityChain: GET /api/v1/integrity/chain (the 409 body has the same shape)
conforms<IntegrityChain>()<IntegrityChainResponse>()
// getIntegrityConfigChain: GET /api/v1/integrity/config-chain (the 409 body has the same shape)
conforms<ConfigChain>()<IntegrityConfigChainResponse>()

// getInventorySummary: GET /api/v1/inventory/summary, unwrapped from `data`
conforms<InventorySummary>()<InventorySummaryResponse['data']>()
// listInventoryDevices, listInventoryHarnesses, listInventoryMcpServers, listInventorySkills, listInventoryDisconnects: unwrapped from `data`
conforms<InventoryDevice>()<Rows<InventoryDeviceListResponse, 'data'>>()
conforms<InventoryHarness>()<Rows<InventoryHarnessListResponse, 'data'>>()
conforms<InventoryMcpServer>()<Rows<InventoryMcpServerListResponse, 'data'>>()
conforms<InventorySkill>()<Rows<InventorySkillListResponse, 'data'>>()
conforms<DeviceDisconnect>()<Rows<DeviceDisconnectListResponse, 'data'>>()

// getMemberUsage, getTeamUsage, getBranchUsage, getCommitUsage, getPullRequestUsage: GET /api/v1/usage/*
conforms<MemberUsageResponse>()<MemberUsageListResponse>()
conforms<TeamUsageResponse>()<TeamUsageListResponse>()
conforms<BranchUsageResponse>()<BranchUsageListResponse>()
conforms<CommitUsageResponse>()<CommitUsageListResponse>()
conforms<PullRequestUsageResponse>()<PullRequestUsageListResponse>()
// refreshPullRequestUsage: POST /api/v1/usage/pull-requests/refresh
conforms<PullRequestRefreshResult>()<PullRequestRefreshResponse>()

// startLoopRun: POST /api/v1/loops/start, and getLoopRun: GET /api/v1/loops/:loopRunId, unwrapped from `loop`
conforms<LoopRun>()<LoopRunEnvelopeResponse['loop']>()
// listLoopRuns: GET /api/v1/loops, unwrapped from `loops`
conforms<LoopRun>()<Rows<LoopRunListResponse, 'loops'>>()
// completeLoopRun, killLoopRun, approveLoopRun, rejectLoopRun
conforms<LoopRunActionResult>()<LoopRunCompleteResponse | LoopRunKillResponse | LoopRunReviewResponse>()
