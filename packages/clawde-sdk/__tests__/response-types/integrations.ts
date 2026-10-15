/** SDK response types of the notification, SIEM, task-management connection, MCP registry, attenuation, compliance, GitHub webhook, gate liveness, cost prediction and routing routes, against their schemas. */
import type {
  AttenuationChainResponse,
  AttenuationResponse,
  CostPredictionResponse,
  FrameworkCoverageResponse,
  GateLivenessResponse,
  GitHubWebhookResponse,
  GitHubWebhookSecretResponse,
  McpServerDecisionResponse,
  McpServerListResponse,
  MirrorAdoptionReportResponse,
  NotificationRuleListResponse,
  NotificationRuleResponse,
  NotificationRuleSigningSecretResponse,
  SiemDestinationCreatedResponse,
  SiemDestinationListResponse,
  SiemDestinationResponse,
  SiemDestinationUpdatedResponse,
  SiemSigningSecretResponse,
  Soc2CollectResponse,
  TaskConnectionDeleteResponse,
  TaskConnectionListResponse,
  TaskConnectionResponse,
  TaskConnectionTestResponse,
} from '@intutic/shared-types'
import type {
  AttenuationChainLink,
  AttenuationResult,
  CostPrediction,
  EvidenceCollectResult,
  FrameworkCoverage,
  GateLiveness,
  GitHubWebhookInfo,
  GitHubWebhookSecret,
  McpServerDecision,
  McpServerList,
  MirrorAdoptionReport,
  NotificationRule,
  NotificationSecretRotation,
  SiemDestination,
  SiemDestinationList,
  SiemSecretRotation,
  SiemSources,
  TaskConnection,
  TaskConnectionDeleteResult,
  TaskConnectionTestResult,
} from '../../src/types'
import { conforms, type Rows } from './conforms'

// listMcpServers: GET /api/v1/mcp/servers
conforms<McpServerList>()<McpServerListResponse>()
// approveMcpServer / blockMcpServer / resetMcpServer: POST /api/v1/mcp/servers/:serverId/status
// enableMcpTool / disableMcpTool: POST /api/v1/mcp/servers/:serverId/tools
conforms<McpServerDecision>()<McpServerDecisionResponse>()

// listNotificationRules: GET /api/v1/notifications/rules, unwrapped from `rules`
conforms<NotificationRule>()<Rows<NotificationRuleListResponse, 'rules'>>()
// createNotificationRule / updateNotificationRule: POST, PUT /api/v1/notifications/rules[/:ruleId]
conforms<NotificationRule>()<NotificationRuleResponse>()
// rotateNotificationRuleSecret: POST /api/v1/notifications/rules/:ruleId/signing-secret
conforms<NotificationSecretRotation>()<NotificationRuleSigningSecretResponse>()

// listSiemDestinations: GET /api/v1/siem/destinations
conforms<SiemDestinationList>()<SiemDestinationListResponse>()
// listSiemSources: GET /api/v1/siem/destinations, unwrapped from `sources`
conforms<SiemSources>()<SiemDestinationListResponse['sources']>()
// getSiemDestination: GET /api/v1/siem/destinations/:destinationId; createSiemDestination: POST
// /api/v1/siem/destinations (the one that sends `signingSecret`); updateSiemDestination: PUT …/:destinationId
conforms<SiemDestination>()<SiemDestinationResponse | SiemDestinationCreatedResponse | SiemDestinationUpdatedResponse>()
// rotateSiemDestinationSecret: POST /api/v1/siem/destinations/:destinationId/signing-secret
conforms<SiemSecretRotation>()<SiemSigningSecretResponse>()

// listTaskConnections: GET /api/v1/task-management/connections, unwrapped from `items`
conforms<TaskConnection>()<Rows<TaskConnectionListResponse, 'items'>>()
// createTaskConnection: POST /api/v1/task-management/connections
conforms<TaskConnection>()<TaskConnectionResponse>()
// testTaskConnection: POST /api/v1/task-management/connections/:connectionId/test
conforms<TaskConnectionTestResult>()<TaskConnectionTestResponse>()
// deleteTaskConnection: DELETE /api/v1/task-management/connections/:connectionId
conforms<TaskConnectionDeleteResult>()<TaskConnectionDeleteResponse>()

// getFrameworkCoverage: GET /api/v1/compliance/frameworks/:frameworkId/coverage
conforms<FrameworkCoverage>()<FrameworkCoverageResponse>()
// collectEvidence: POST /api/v1/compliance/soc2-collect
conforms<EvidenceCollectResult>()<Soc2CollectResponse>()

// getGateLiveness: GET /api/v1/governance/gate-liveness
conforms<GateLiveness>()<GateLivenessResponse>()
// getGithubWebhook: GET /api/v1/integrations/github/webhook
conforms<GitHubWebhookInfo>()<GitHubWebhookResponse>()
// rotateGithubWebhookSecret: POST /api/v1/integrations/github/webhook/secret
conforms<GitHubWebhookSecret>()<GitHubWebhookSecretResponse>()

// attenuateKey: POST /api/v1/attenuate
conforms<AttenuationResult>()<AttenuationResponse>()
// getAttenuationChain: GET /api/v1/attenuate/chain/:chainId, unwrapped from `chain`
conforms<AttenuationChainLink>()<Rows<AttenuationChainResponse, 'chain'>>()
// predictCost: POST /api/v1/predict-cost
conforms<CostPrediction>()<CostPredictionResponse>()
// getMirrorAdoptionReport: GET /api/v1/routing/mirror-adoption-report
conforms<MirrorAdoptionReport>()<MirrorAdoptionReportResponse>()
