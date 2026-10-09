from typing import TypedDict, List, Dict, Any, Literal, Optional

class ClawdeClientOptions(TypedDict, total=False):
    api_key: str
    base_url: Optional[str]
    provider: Optional[str]
    auto_context: Optional[bool]
    timeout: Optional[float]
    retries: Optional[int]

class ChatMessage(TypedDict):
    role: str
    content: str

class ChatParams(TypedDict, total=False):
    model: str
    messages: List[ChatMessage]
    temperature: Optional[float]

class ChatResponse(Dict[str, Any]):
    verdict: Optional[str]

class ResolvedContext(TypedDict, total=False):
    gitBranch: Optional[str]
    jiraTicket: Optional[str]
    pagerdutyIncident: Optional[str]
    ciPipeline: Optional[str]
    workingDirectory: Optional[str]
    workspaceId: Optional[str]
    sessionId: Optional[str]

class BudgetCheckResult(TypedDict):
    allowed: bool
    remaining_usd: float


# ─── Operator API types: the twins of the TypeScript SDK's ───
#
# Wire shapes, as the control plane sends them: camelCase keys except where
# the route itself answers in snake_case (findings, integrity roots, SOP
# writes, policy sources).


class McpServer(TypedDict):
    serverId: str
    serverName: str
    status: Literal["candidate", "approved", "blocked"]
    tools: List[str]
    disabledTools: List[str]
    lastSeenAt: str
    heldForReview: bool


class McpServerList(TypedDict):
    servers: List[McpServer]
    defaultPolicy: Literal["allow", "deny"]
    highRiskToolChange: Literal["notify", "hold"]
    pendingCount: int


class McpServerDecision(TypedDict):
    ok: bool
    server: McpServer


class NotificationChannelConfig(TypedDict, total=False):
    slackChannelId: str
    slackChannelName: str
    emailRecipients: List[str]
    webhookUrl: str
    pagerdutyRoutingKey: str


class NotificationFilters(TypedDict, total=False):
    severity: List[str]
    harnessType: List[str]
    userId: List[str]


class NotificationRuleInput(TypedDict, total=False):
    """The body of a create (``eventType``, ``channel`` and ``channelConfig``
    required) or an update (only the fields that change). ``channelConfig`` and
    ``filters`` replace the stored ones whole."""

    eventType: str
    channel: Literal["slack", "email", "webhook", "pagerduty"]
    channelConfig: NotificationChannelConfig
    filters: NotificationFilters
    cooldownMinutes: int
    enabled: bool


class NotificationRule(TypedDict, total=False):
    ruleId: str
    eventType: str
    channel: Literal["slack", "email", "webhook", "pagerduty"]
    channelConfig: NotificationChannelConfig
    filters: NotificationFilters
    cooldownMinutes: int
    enabled: bool
    #: A webhook rule's signing secret, only in the response that made it.
    signingSecret: str


class NotificationSecretRotation(TypedDict):
    ruleId: str
    #: Shown once: not retrievable again after this response.
    signingSecret: str


class SiemDestination(TypedDict, total=False):
    destinationId: str
    name: str
    adapterType: str
    isActive: bool
    #: Empty means the default set: every source except the opt-in ones.
    sourceTables: List[str]
    batchSize: int
    flushIntervalMs: int
    lastHeartbeatAt: Optional[str]
    lastError: Optional[str]
    #: The adapter settings, with credentials masked.
    config: Dict[str, Any]
    signingSecret: str


class SiemSources(TypedDict):
    all: List[str]
    defaults: List[str]


class SiemDestinationList(TypedDict):
    items: List[SiemDestination]
    sources: SiemSources


class SiemDestinationInput(TypedDict, total=False):
    """A create (``name``, ``adapterType`` and ``config`` required) or an update
    (only the fields that change; ``isActive: True`` turns a deleted
    destination back on). ``config`` carries the adapter's credentials; the
    control plane encrypts them and masks them on every read."""

    name: str
    adapterType: Literal["syslog_cef", "webhook_https", "gcs", "s3", "splunk_hec", "datadog_logs"]
    config: Dict[str, Any]
    sourceTables: List[str]
    batchSize: int
    flushIntervalMs: int
    isActive: bool


class SiemSecretRotation(TypedDict):
    destinationId: str
    signingSecret: str


class MemberUsageResponse(TypedDict):
    #: "self" when the caller may see only their own calls.
    scope: Literal["workspace", "self"]
    members: List[Dict[str, Any]]


class TeamUsageResponse(TypedDict):
    scimGroups: bool
    teams: List[Dict[str, Any]]


class BranchUsageResponse(TypedDict):
    scope: Literal["workspace", "self"]
    branches: List[Dict[str, Any]]


class CommitUsageResponse(TypedDict):
    scope: Literal["workspace", "self"]
    commits: List[Dict[str, Any]]


class PullRequestUsageResponse(TypedDict):
    scope: Literal["workspace", "self"]
    github: Dict[str, Any]
    pullRequests: List[Dict[str, Any]]


class PullRequestRefreshResult(TypedDict):
    checked: int
    notModified: int
    pullRequests: int
    noAccess: int
    rateLimited: bool


class InventorySummary(TypedDict):
    devices: int
    staleDevices: int
    harnesses: int
    governedHarnesses: int
    governedPercent: Optional[int]
    ungovernedHarnesses: int
    staleGates: int
    unverifiedHarnesses: int
    mcpServers: int
    ungovernedMcpServers: int
    skills: int


class DeviceDisconnect(TypedDict):
    disconnectId: str
    hostname: str
    fingerprint: str
    scope: Literal["machine", "harness"]
    harnesses: List[str]
    memberId: Optional[str]
    reportedBy: Optional[str]
    createdAt: str


class FrameworkCoverageSummary(TypedDict):
    controls: int
    mapped: int
    full: int
    partial: int
    states: Dict[str, int]


class FrameworkCoverage(TypedDict, total=False):
    frameworkId: str
    name: str
    mappingVersion: str
    generatedAt: str
    summary: FrameworkCoverageSummary


class EvidenceCollectResult(TypedDict, total=False):
    runId: str
    archive: Dict[str, Any]
    artifactUrl: Optional[str]
    signed: bool
    signingKeyId: str
    unsignedReason: str


class SigningJwks(TypedDict):
    keys: List[Dict[str, Any]]


class EvidenceVerification(TypedDict):
    archiveSha256: str
    archiveHashMatches: bool
    #: Manifest entries whose content does not hash to the recorded value, or that name nothing in the archive.
    sectionMismatches: List[str]
    sectionsChecked: int
    signature: Literal["valid", "invalid", "unsigned", "unverifiable", "keys_unavailable"]
    signingKeyId: Optional[str]
    unsignedReason: Optional[str]
    #: True only when the hashes match and a published key accepts the signature.
    verified: bool


#: What ``verify_integrity_root`` established: "valid" a published key accepted
#: the signature, "invalid" the key the root names rejected it, "unsigned" no
#: key was configured when it was sealed, "unverifiable" the key is not
#: published or the root names an algorithm or preimage version this build
#: cannot check, "keys_unavailable" no key set was given. Only "invalid" says
#: the root changed.
IntegrityRootSignatureState = Literal["valid", "invalid", "unsigned", "unverifiable", "keys_unavailable"]


class GateStatus(TypedDict):
    harnessType: str
    status: Literal["reporting", "silent", "new"]
    lastSeen: Optional[str]
    agentLastSeen: Optional[str]
    alertOpen: bool


class GateLiveness(TypedDict):
    windowHours: int
    gates: List[GateStatus]


class GitHubWebhookInfo(TypedDict):
    configured: bool
    url: Optional[str]
    createdAt: Optional[str]
    secretRotatedAt: Optional[str]
    lastDeliveryAt: Optional[str]


class GitHubWebhookSecret(TypedDict):
    url: str
    #: Shown once: not retrievable again after this response.
    secret: str


class PolicySourceInput(TypedDict, total=False):
    provider: Literal["notion", "confluence", "github", "gdrive"]
    name: str
    #: The provider credential (a Google service-account key is the key file's JSON).
    token: str
    config: Dict[str, Any]


class PolicySourceSyncResult(TypedDict):
    success: bool
    processed_docs: int
    updated_sops: List[str]
    successor_sops: List[str]


class GuardrailTransitionResult(TypedDict, total=False):
    ok: bool
    guardrail: Dict[str, Any]
    readiness: Dict[str, Any]


class AuthoredGuardrailInput(TypedDict, total=False):
    """A create (``name`` and ``ir`` required) or an update (any of the three;
    a changed IR creates the next version, ``description: None`` clears it)."""

    name: str
    description: Optional[str]
    ir: Dict[str, Any]


class AuthoredGuardrailWriteResult(TypedDict):
    ok: bool
    guardrail: Dict[str, Any]
    #: The IR changed: a new version, PROPOSED with no evidence, replaced the old one, which is now RETIRED.
    forked: bool
    supersedes: Optional[str]


class GuardrailReplay(TypedDict):
    source: Literal["enforcement_log", "context_snapshots", "execution_traces", "none"]
    windowDays: int
    captured: int
    fires: int
    sample: List[Dict[str, Any]]
    truncated: bool
    unsupported: List[str]


class DecisionReviewResult(TypedDict, total=False):
    ok: bool
    status: str
    #: A short-lived bypass was written for the exact retried call.
    bypassWritten: bool


class LoopRunActionResult(TypedDict, total=False):
    ok: bool
    status: str
    outcome: str


class FindingAdjudication(TypedDict):
    finding_id: str
    outcome: Literal["TRUE_POSITIVE", "FALSE_POSITIVE"]


class FindingStats(TypedDict):
    detectors: List[Dict[str, Any]]
    caveats: List[str]


class ResponseEchoReport(TypedDict):
    window: Dict[str, str]
    tracesIngested: int
    refusal: Optional[str]
    patterns: List[Dict[str, Any]]


class TraceList(TypedDict, total=False):
    traces: List[Dict[str, Any]]
    total: int
    limit: int
    offset: int


class IntegrityRootList(TypedDict):
    ok: bool
    data: List[Dict[str, Any]]
    leafSchemaVersion: int


class IntegrityRootDetail(TypedDict):
    ok: bool
    root: Dict[str, Any]
    leaves: List[Dict[str, Any]]


class IntegrityRecompute(TypedDict, total=False):
    ok: bool
    verdict: Literal["match", "mismatch", "missing_traces"]
    storedRoot: str
    recomputedRoot: Optional[str]
    changedTraceIds: List[str]
    missingTraceIds: List[str]
    retentionExpired: bool


class IntegrityChain(TypedDict):
    ok: bool
    workspaceId: str
    rootsWalked: int
    rootsNotWalked: int
    unchainedRootIds: List[str]
    breaks: List[Dict[str, Any]]
    intact: bool


class ConfigChain(TypedDict, total=False):
    ok: bool
    workspaceId: str
    harnessType: Optional[str]
    snapshotsWalked: int
    #: Saturates at 1: read it as "more snapshots than the walk covered".
    snapshotsNotWalked: int
    unchainedSnapshotIds: List[str]
    breaks: List[Dict[str, Any]]
    contentMismatches: List[Dict[str, Any]]
    snapshotsWithoutContent: int
    intact: bool


class PolicyChangeResult(TypedDict, total=False):
    ok: bool
    currentVersion: int


class RuleCandidateSource(TypedDict):
    candidateId: str
    guardrailId: Optional[str]
    status: str
    source: str
    #: Lower-case hex; checked against ``source`` before it is returned.
    sourceSha256: str


class BundleUploadResult(TypedDict, total=False):
    accepted: bool
    gates: List[Dict[str, Any]]
    ruleId: str
    mode: str
    error: str
    detail: str


class WasmReplayResult(TypedDict):
    ruleId: str
    since: Optional[str]
    contextCount: int
    wouldActCount: int
    wouldActRate: float
    verdictCounts: Dict[str, int]
    sampleMatches: List[Dict[str, Any]]


class SopInput(TypedDict, total=False):
    """The body ``intutic sops push`` sends, in the route's snake_case
    (``title`` and ``markdown_content`` required)."""

    title: str
    markdown_content: str
    risk_tier: str
    complexity_tier: str
    version: str


class SopCreateResult(TypedDict, total=False):
    ok: bool
    sopId: str


class AttenuationResult(TypedDict):
    #: The child ``vk_`` key: shown once, never stored.
    childKey: str
    childKeyId: str
    attenuationChainId: str
    grantedCaps: List[str]
    expiresAt: str


class PredictCostParams(TypedDict, total=False):
    #: Must be the key's own workspace.
    workspaceId: str
    model: str
    inputTokenCount: int
    inputText: str


class CostPrediction(TypedDict):
    inputTokens: int
    estimatedOutputTokens: int
    estimatedReasoningTokens: Optional[int]
    estimatedCostUsd: float
    confidence: Literal["high", "medium", "low"]
    basedOnSamples: int
