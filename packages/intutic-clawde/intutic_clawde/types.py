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

class GatewayStatus(TypedDict):
    """``GET /api/v1/gateways/:id/status``; the twin of the TypeScript SDK's ``GatewayStatus``."""
    status: Literal["online", "degraded", "unreachable", "pending"]
    proxyVersion: Optional[str]
    uptimeSeconds: Optional[int]
    activeWorkspaces: Optional[int]
    litellmReachable: Optional[bool]
    lastError: Optional[str]
    reportedAt: Optional[str]
    #: The config version the gateway reported running in its last heartbeat;
    #: None when unreachable or not reported.
    appliedConfigVersion: Optional[int]
    #: The version the latest config change produced; 0 before any. The
    #: gateway pulls it on its next heartbeat.
    desiredConfigVersion: int
