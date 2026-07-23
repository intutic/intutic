from typing import TypedDict, List, Dict, Any, Optional

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
    max_cost_usd: Optional[float]
    sensitivity_tier: Optional[str]

class ChatResponse(Dict[str, Any]):
    verdict: Optional[str]
    budget_remaining_usd: Optional[float]
    budget_pct_used: Optional[float]

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
