// ============================================
// LLD #45-slack: Notification Hub + Slack Adapter
// ============================================

// ── Notification Hub Types ─────────────────────────────────────

export type NotificationChannel = 'slack' | 'email' | 'webhook' | 'pagerduty'

/**
 * Every event a notification rule can subscribe to. The API refuses a rule
 * naming anything else, and the CLI and the Terraform provider check
 * against this list before they send one.
 */
export const NOTIFICATION_EVENT_TYPES = [
  // ── Core governance events (already wired) ──
  'anomaly.detected',
  /**
   * One attributed detector finding from the proxy, allowed or blocked.
   *
   * Distinct from `anomaly.detected`, which is raised by the control plane's own
   * classifier after the fact and only for requests that produced an incident.
   * This one fires for every finding on every trace — including the advisory and
   * reask ones on requests that proceeded — which is what makes "see everything,
   * block nothing" possible.
   *
   * Carries `detectorId`, so a rule can target one detector rather than a whole
   * taxonomy kind that sixteen of twenty-two detectors share.
   */
  'anomaly.finding',
  'incident.created',
  'incident.escalated',
  'sop.status_changed',
  'session.ended',
  'adapter.write_back.failed',
  'decision.pending',
  /** An OWNER, ADMIN or EM approved a held decision, in Slack or through the API and CLI. Carries `entryId`, `reviewerId` and `via`. */
  'decision.approved',
  /** An OWNER, ADMIN or EM rejected a held decision, in Slack or through the API and CLI. */
  'decision.rejected',
  'ssl.enforcement.violation',
  'context_gap.auto_injected',
  'trajectory.alert',
  // ── Calibration & drift (Q10 orphan audit) ──
  'calibration.threshold_breach',
  'anomaly.drift.detected',
  'anomaly.capability_miss',
  'anomaly.trust.updated',
  // ── SOP lifecycle & integrity ──
  'sop.stale.detected',
  'sop.cascade.alert',
  'sop.cascade.invalidated',
  'sop.integrity.drift',
  'sop.lifecycle.transitioned',
  /** A source-connector sync found an enforced SOP's upstream document changed and created a DRAFT successor awaiting review (TD-474 item 7). */
  'sop.upstream.changed',
  // ── Policy guardrails (LLD #71) ──
  /** A SHADOW guardrail crossed the promotion thresholds; a named member decides. */
  'guardrail.ready',
  /** The passage a guardrail cites changed upstream; promotion is refused until re-confirmed. */
  'guardrail.stale',
  // ── MCP server registry ──
  /** An MCP proxy reported a server this workspace's registry had never seen; it waits as a candidate for an OWNER or ADMIN to approve or block. */
  'mcp.server.candidate',
  /** A server the registry knew declared a different tool set, and the change scored high risk (`mcpToolRisk.ts`). */
  'mcp.server.tool_change_risk',
  /** An OWNER or ADMIN approved, blocked or reset (returned to the approval queue) an MCP server. Carries `action`, `previousStatus` and `actorId`. */
  'mcp.server.decided',
  /** An OWNER or ADMIN switched one tool of an MCP server on or off. Carries `toolName`, `enabled` and `actorId`. */
  'mcp.server.tool_toggled',
  /** An MCP call budget reached its warning threshold for the period (sent once per budget per period). */
  'mcp.budget.threshold',
  /** An MCP call budget ran out and the proxy refused a call (sent once per budget per period). */
  'mcp.budget.exceeded',
  // ── Governance judge ──
  /** A judged response is waiting for a person in the judge review queue: the typed judge was unsure, or it is a spot check of one it cleared (LLD #72). */
  'judge.review.queued',
  // ── FinOps & budget ──
  'finops.budget.exceeded',
  'finops.budget.threshold',
  'finops.tokens.classified',
  // ── Enterprise & trial ──
  'trial.started',
  'trial.expired_downgraded',
  'trial.day7_report_sent',
  'trial.day13_report_sent',
  // ── Plans ──
  'plan.captured',
  'plan.approved',
  'plan.deviation.detected',
  // ── Identity & compliance ──
  'identity.offboarding.completed',
  /** A sign-in to the workspace was refused (wrong password, deactivated member, an SSO identity the workspace does not admit, a response that failed verification). The `login_events` row. */
  'auth.login.failed',
  /** The identity provider provisioned, changed or deprovisioned a user through SCIM. Carries `action` and the SCIM user id. */
  'scim.user.changed',
  /** The identity provider created, changed (members, name, mapped role) or deleted a group through SCIM. */
  'scim.group.changed',
  /** An OWNER or ADMIN replaced the signing secret of a notification webhook, a SIEM webhook destination or the GitHub pull-request webhook. Carries `target` and `targetId`, never the secret. */
  'webhook.secret.rotated',
  /** A member downloaded compliance evidence: a SOC 2 archive, a framework coverage report file or the human-oversight export. The `evidence_exports` row. */
  'evidence.exported',
  /** An API key, gateway token or SCIM token was created, rotated or revoked, or a provider credential was provisioned, replaced or removed. The `credential_changes` row: `credential_type`, `credential_id`, `action` and who; never the value. */
  'credential.changed',
  // ── Workspace context ──
  'workspace.context.updated',
  // ── Self-hosted gateway (LLD #66) ──
  /**
   * A registered, non-revoked self-hosted gateway has gone past
   * GATEWAY_HEARTBEAT_TTL without a heartbeat -- fired once per member
   * workspace of the gateway's org (gateways are org-scoped; notification
   * rules are workspace-scoped), not once per gateway.
   */
  'gateway.stale.detected',
  /**
   * A managed cell (`deployment_target='managed_cell'`) has sat `pending`
   * (registered, never heartbeated) past `CELL_STUCK_PENDING_THRESHOLD_MS`
   * (15 min) -- the provisioner is failing to converge it (TD-342(c)).
   * Fired by `detectStuckPendingCells` (gatewayHealthService.ts), same
   * org→workspace fan-out and stable-reason dedup as `gateway.stale.detected`.
   * Already wired into `notificationRouterService.ts`'s dispatch and
   * severity map before this union entry existed -- this only adds the type
   * contract those call sites were relying on via an `as` cast.
   */
  'gateway.cell.stuck_pending',
  /**
   * The control plane's CP→region Valkey sync heartbeat
   * (`intutic:cp:last-sync`) is missing or stale in a remote region --
   * cells there keep serving, but on progressively stale control metadata.
   * Fired by `detectStaleRegionSync` (gatewayHealthService.ts) per member
   * workspace of every org with a live cell in the affected region. Same
   * pre-existing-dispatch note as `gateway.cell.stuck_pending` above.
   */
  'region.sync.stale',
  // ── Managed gateway cell deprovisioning (LLD #71 Phase C2) ──
  /**
   * A managed cell was marked for removal because its org's plan tier no
   * longer covers it (`maxCellsPerOrg` in planSkuMap.ts) -- either a
   * voluntary downgrade or an involuntary loss of paid status (cancellation,
   * dunning). Fired by `scheduleCellReconciliation`
   * (cellDeprovisionService.ts) at most once per scheduled removal
   * (`deprovision_notified_at` is the idempotence gate). Carries
   * `deprovision_at` -- the grace-period deadline -- and `reason`.
   */
  'org.cells.deprovision_scheduled',
  /**
   * A previously-scheduled cell removal was cancelled because the org's
   * cell count is no longer over its plan-tier capacity -- typically a
   * re-upgrade landing before the grace period expired. Fired by the same
   * reconciler as `org.cells.deprovision_scheduled` above, the bidirectional
   * half of the same bidirectional-reconcile-marks design. MEDIUM, not
   * HIGH: this is good news for the org, not an incident.
   */
  'org.cells.deprovision_canceled',
  /**
   * A managed cell's deprovision grace period actually expired and the cell
   * was revoked -- fired by `sweepCellCapacity`'s deadline pass
   * (cellDeprovisionService.ts), the same revoke shape as a manual
   * `DELETE /api/v1/gateways/:id`. HIGH: an org's traffic capacity for that
   * region just changed, same tier as `gateway.stale.detected`.
   */
  'org.cells.deprovisioned',
  // ── Enforcement device visibility (post-strip gap #2, LLD #63 hardening) ──
  /**
   * A device's reported enforcement posture (firewall/CA-trust/system-hooks)
   * hasn't been refreshed past DEVICE_STALE_THRESHOLD_MS (72h) -- fired by
   * deviceHealthCron.ts. Most staleness is a closed laptop, not a
   * compromise -- MEDIUM, unlike gateway.stale.detected's HIGH.
   */
  'device.enforcement.stale',
  /**
   * A device's firewall went from active:true to active:false on a live
   * report -- an active bypass just occurred, not merely unreported.
   */
  'device.enforcement.disabled',
  // ── Gate liveness ──
  /**
   * A harness installed in the workspace has sent no hook event of any kind,
   * allows included, for the whole liveness window: its gate may not be
   * running. Fired once when the gate goes silent, not on every hourly sweep.
   * Carries `harnessType` and `incidentId`.
   */
  'governance.gate.silent',
  /**
   * A harness with an open `governance.gate.silent` alert is reporting again.
   * Same `incidentId` as the alert it closes; PagerDuty resolves that incident.
   */
  'governance.gate.recovered',
  // ── Trace integrity ──
  /**
   * The hourly audit-log integrity check found a failure of one kind
   * (`kind`: `chain_break`, `mirror_copy_mismatch`, `signature_invalid`,
   * `root_mismatch` or `guard_tampered`). Fired once per kind while it keeps
   * failing; a recurrence after it clears fires again.
   */
  'governance.integrity.failed',
  // ── AI inventory of developer machines ──
  /**
   * A machine's AI inventory listed an ungoverned harness or MCP server for
   * the first time: a harness with no gate installed or none possible, or an
   * MCP server the MCP proxy does not front. Once per machine and item.
   */
  'inventory.ungoverned.detected',
  // ── Provider outage tracking (Phase 8b) ──
  /**
   * A NEW provider_incidents window opened for a provider (Anthropic,
   * OpenAI, ...) -- fired once per incident open, not on every coalesced
   * failure that extends an already-open incident. Fired scoped to the
   * workspace whose trace triggered the open, since provider_incidents
   * itself is not workspace-scoped (see migration 157) and no complete
   * "every workspace routing through this provider" fan-out exists the way
   * gateway.stale.detected's org-membership join provides for gateways.
   */
  'provider.outage.detected',
  // ── Billing (LLD #71 Phase C2's fix to customer.subscription.updated) ──
  /**
   * A Stripe subscription reported `status: 'past_due'` or `'unpaid'` via
   * `customer.subscription.updated` -- visibility only, not a tier change
   * (repeated payment failure is the dunning flow's job, via
   * `invoice.payment_failed`'s own 3rd-attempt downgrade). MEDIUM: worth a
   * support/ops look, not yet the incident a full cancellation is.
   */
  'billing.subscription.past_due',
  // ── Skill-bundled-script malware detection (Phase S4, opt-in VirusTotal hash lookup) ──
  /**
   * An opt-in `GET /api/v3/files/{sha256}` VirusTotal lookup on a
   * skill-bundled SCRIPT (never `SKILL.md` prose, never uploaded content —
   * see `virusTotalService.ts`'s doc comment) returned at least one AV
   * engine detection. HIGH: a confirmed-malicious file already sitting in a
   * developer's skill directory is a live incident, the same tier as
   * `provider.outage.detected` and `device.enforcement.disabled` above, not
   * a usage-pattern signal to review later.
   */
  'skill.malware.detected',
  // ── Semantic skill analysis (Phase S5, TD-357) ──
  /**
   * The opt-in LLM judge (`semanticSkillAnalysisEnabled`) called a skill's
   * `SKILL.md` prose `'suspicious'` or `'malicious'` — content that
   * `scanSkillContent`'s deterministic patterns may have missed entirely,
   * since the whole point of this judge is catching a rephrasing that
   * avoids every pattern's literal wording. Fired by
   * `analyzeSkillSemantics` (`services/semanticSkillAnalysisService.ts`)
   * only for a judge call that actually ran and returned one of those two
   * verdicts — never for `'clean'`, and never for `'unjudged'` (a failed or
   * capped-out call is an absence of signal, not a finding). Severity is
   * dynamic: HIGH for `'malicious'`, MEDIUM for `'suspicious'` — see
   * `mapSeverity` in `notificationRouterService.ts`.
   */
  'skill.semantic.flagged',
] as const

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number]

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
  /**
   * A webhook rule's signing secret in plaintext. Present only in the
   * response that generated it (create, a switch to the webhook channel, or a
   * rotation); copy it then.
   */
  signingSecret?: string
}

export interface ChannelConfig {
  slackChannelId?: string
  slackChannelName?: string
  emailRecipients?: string[]
  webhookUrl?: string
  /**
   * A webhook rule's signing secret, encrypted at rest. Server-generated on
   * create and never accepted from a caller; stored only, never returned —
   * the plaintext appears once, as `NotificationRule.signingSecret`.
   */
  webhookSecretEnc?: string
  /** PagerDuty Events API v2 integration/routing key. A credential — see
   *  `notificationHubService.ts`'s `getChannelTarget` for why it is masked
   *  (`${key.slice(0,6)}…`) before ever reaching `notification_log`,
   *  which is append-only and so unredactable forever once written. */
  pagerdutyRoutingKey?: string
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

/** The severity a notification is sent at, which a rule's severity filter matches on. */
export type NotificationSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'

export interface GovernanceEvent {
  type: NotificationEventType
  workspaceId: string
  sessionId?: string
  severity: NotificationSeverity
  summary: string
  description: string
  metadata: Record<string, unknown>
}

/**
 * The severity `incident.created` is sent at, from the incident's own
 * (`governance_incidents.severity`). Until 2.4.0 every incident was sent at
 * CRITICAL whatever its severity, so a rule filtered on CRITICAL received a
 * MEDIUM incident and a rule filtered on HIGH received none.
 */
export const INCIDENT_NOTIFICATION_SEVERITY: Readonly<Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', NotificationSeverity>> = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
}

/**
 * {@link INCIDENT_NOTIFICATION_SEVERITY} for an incident event's `severity`.
 * One the map does not name (absent, or from an emitter that sent something
 * else) is sent at CRITICAL: a malformed event must not quieten an alert.
 */
export function incidentNotificationSeverity(severity: unknown): NotificationSeverity {
  return typeof severity === 'string' && Object.hasOwn(INCIDENT_NOTIFICATION_SEVERITY, severity)
    ? INCIDENT_NOTIFICATION_SEVERITY[severity as keyof typeof INCIDENT_NOTIFICATION_SEVERITY]
    : 'CRITICAL'
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
  /** Where a reply to the clicker goes; Slack ignores the HTTP response body. */
  response_url?: string
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
