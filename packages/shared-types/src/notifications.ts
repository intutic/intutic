// ============================================
// LLD #45-slack: Notification Hub + Slack Adapter
// ============================================

// ── Notification Hub Types ─────────────────────────────────────

export type NotificationChannel = 'slack' | 'email' | 'webhook'

export type NotificationEventType =
  // ── Core governance events (already wired) ──
  | 'anomaly.detected'
  | 'incident.created'
  | 'incident.escalated'
  | 'sop.status_changed'
  | 'budget.exceeded'
  | 'session.ended'
  | 'adapter.write_back.failed'
  | 'decision.pending'
  | 'ssl.enforcement.violation'
  | 'context_gap.auto_injected'
  | 'trajectory.alert'
  // ── Calibration & drift (Q10 orphan audit) ──
  | 'calibration.computed'
  | 'calibration.threshold_breach'
  | 'anomaly.drift.detected'
  | 'anomaly.capability_miss'
  | 'anomaly.trust.updated'
  // ── SOP lifecycle & integrity ──
  | 'sop.stale.detected'
  | 'sop.cascade.alert'
  | 'sop.cascade.invalidated'
  | 'sop.integrity.drift'
  | 'sop.lifecycle.transitioned'
  // ── FinOps & budget ──
  | 'finops.budget.exceeded'
  | 'finops.budget.threshold'
  | 'finops.budget.overrun'
  | 'finops.tokens.classified'
  // ── Enterprise & trial ──
  | 'trial.started'
  | 'trial.expired_downgraded'
  | 'trial.day7_report_sent'
  | 'trial.day13_report_sent'
  // ── Plans & annotations ──
  | 'plan.captured'
  | 'plan.approved'
  | 'plan.deviation.detected'
  | 'annotation.queue_populated'
  | 'annotation.created'
  // ── CFO & reports ──
  | 'cfo.report.ready'
  // ── Identity & compliance ──
  | 'identity.offboarding.completed'
  | 'gdpr.memory_erased'
  // ── Prompt library ──
  | 'prompt_library.created'
  | 'prompt_library.version_created'
  | 'prompt_library.imported'
  // ── Workspace context ──
  | 'workspace.context.updated'

export type NotificationStatus = 'sent' | 'failed' | 'deduplicated' | 'filtered'

export interface NotificationRule {
  ruleId: string
  workspaceId: string
  eventType: NotificationEventType
  channel: NotificationChannel
  channelConfig: ChannelConfig
  filters: NotificationFilters
  cooldownMinutes: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ChannelConfig {
  slackChannelId?: string
  slackChannelName?: string
  emailRecipients?: string[]
  webhookUrl?: string
  webhookSecret?: string
}

export interface NotificationFilters {
  severity?: string[]
  harnessType?: string[]
  userId?: string[]
}

export interface CreateNotificationRuleInput {
  eventType: NotificationEventType
  channel: NotificationChannel
  channelConfig: ChannelConfig
  filters?: NotificationFilters
  cooldownMinutes?: number
  enabled?: boolean
}

export interface UpdateNotificationRuleInput {
  eventType?: NotificationEventType
  channel?: NotificationChannel
  channelConfig?: ChannelConfig
  filters?: NotificationFilters
  cooldownMinutes?: number
  enabled?: boolean
}

export interface NotificationLogEntry {
  logId: string
  ruleId: string | null
  workspaceId: string
  eventType: string
  channel: NotificationChannel
  status: NotificationStatus
  channelTarget: string | null
  errorMessage: string | null
  latencyMs: number | null
  createdAt: string
}

export interface GovernanceEvent {
  type: NotificationEventType
  workspaceId: string
  sessionId?: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
  summary: string
  description: string
  metadata: Record<string, unknown>
}

export interface DispatchResult {
  ruleId: string
  channel: NotificationChannel
  status: NotificationStatus
  error?: string
  latencyMs?: number
}

// ── Slack-Specific Types ─────────────────────────────────────

export interface SlackInstallation {
  installationId: string
  workspaceId: string
  slackTeamId: string
  slackTeamName: string | null
  botUserId: string | null
  scopes: string[]
  createdAt: string
  updatedAt: string
}

export interface SlackConfig {
  botToken: string
  teamId: string
  signingSecret: string
}

export interface SlackBlock {
  type: string
  text?: { type: string; text: string; emoji?: boolean }
  fields?: Array<{ type: string; text: string }>
  elements?: SlackBlockElement[]
  block_id?: string
  accessory?: SlackBlockElement
}

export interface SlackBlockElement {
  type: string
  text?: { type: string; text: string; emoji?: boolean }
  action_id?: string
  value?: string
  url?: string
  style?: 'primary' | 'danger'
}

export interface SlackMessageResult {
  ok: boolean
  channel: string
  ts: string
  error?: string
}

export interface SlackCommandResponse {
  response_type: 'ephemeral' | 'in_channel'
  text?: string
  blocks?: SlackBlock[]
}

export interface SlackInteraction {
  type: 'block_actions'
  user: { id: string; username: string; name: string }
  team: { id: string; domain: string }
  channel: { id: string; name: string }
  actions: Array<{
    action_id: string
    block_id: string
    value: string
    type: string
  }>
  message: { ts: string }
}

export interface SlackSlashCommand {
  command: string
  text: string
  channel_id: string
  channel_name: string
  user_id: string
  user_name: string
  team_id: string
  team_domain: string
  response_url: string
  trigger_id: string
}

export interface HealthCheckResult {
  ok: boolean
  teamId?: string
  teamName?: string
  botUserId?: string
  error?: string
}

// ── Webhook Adapter Types ────────────────────────────────────

export interface WebhookPayload {
  event_type: string
  workspace_id: string
  severity: string
  summary: string
  description: string
  timestamp: string
  metadata: Record<string, unknown>
}

export interface WebhookConfig {
  url: string
  secret?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface WebhookResult {
  ok: boolean
  statusCode: number
  error?: string
}

// ============================================
// Slack User Mappings
// ============================================

export interface SlackUserMapping {
  mappingId: string
  workspaceId: string
  slackTeamId: string
  slackUserId: string
  memberId: string
  slackUsername?: string
  slackDisplayName?: string
  linkedAt: string
}

export interface LinkSlackUserInput {
  slackTeamId: string
  slackUserId: string
  memberId: string
  slackUsername?: string
  slackDisplayName?: string
}
