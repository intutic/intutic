import pytest
import os
import json
from unittest.mock import MagicMock, patch
from intutic_clawde import ClawdeClient, ClawdeConnectionError, ClawdeVerdictError

def test_client_init():
    # API key is required
    with pytest.raises(ValueError):
        ClawdeClient(api_key="")
        
    client = ClawdeClient(api_key="test-key")
    assert client.api_key == "test-key"
    assert client.base_url == "http://localhost:4000"

@patch("intutic_clawde.context_resolver.Path.exists")
def test_resolve_context(mock_exists):
    mock_exists.return_value = False
    client = ClawdeClient(api_key="test-key")
    
    with patch.dict(os.environ, {
        "INTUTIC_WORKSPACE_ID": "ws_123",
        "INTUTIC_SESSION_ID": "ses_456",
        "GIT_BRANCH": "main"
    }):
        context = client.resolve_context()
        assert context["workspaceId"] == "ws_123"
        assert context["sessionId"] == "ses_456"
        assert context["gitBranch"] == "main"
        assert context["workingDirectory"] == os.getcwd()

@patch("requests.get")
def test_budget_checker_cache(mock_get):
    client = ClawdeClient(api_key="test-key")
    
    # Mock budget API response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"allowed": True, "remaining_usd": 150.0}
    mock_get.return_value = mock_response
    
    # First call: hits API
    res1 = client.check_budget("gpt-4o", 100)
    assert res1["allowed"] is True
    assert res1["remaining_usd"] == 150.0
    assert mock_get.call_count == 1
    
    # Second call: hits cache, doesn't hit API again
    res2 = client.check_budget("gpt-4o", 100)
    assert res2["allowed"] is True
    assert mock_get.call_count == 1

def test_circuit_breaker_trips():
    client = ClawdeClient(api_key="test-key")
    
    # Populate budget cache with blocked state
    client.budget_checker.update_cached_budget("default", 1, 0.0, False)
    
    # Wrap a mock function with the circuit breaker
    mock_tool = MagicMock(return_value="success")
    wrapped = client.circuit_breaker("test_tool", max_cost_usd=5.0)
    
    # Wrapped function execution should raise ClawdeVerdictError because budget cache is blocked
    with pytest.raises(ClawdeVerdictError) as exc:
        wrapped(mock_tool)
    assert "budget exceeded" in str(exc.value)
    assert mock_tool.call_count == 0

def test_circuit_breaker_fail_open():
    client = ClawdeClient(api_key="test-key")
    client.budget_checker.update_cached_budget("default", 1, 0.0, False)
    
    # With fail_open=True, it should fail open (log warning and continue execution of mock_tool)
    mock_tool = MagicMock(return_value="success")
    wrapped = client.circuit_breaker("test_tool", max_cost_usd=5.0, fail_open=True)
    
    result = wrapped(mock_tool)
    assert result == "success"
    assert mock_tool.call_count == 1

@patch("requests.post")
def test_chat_verdict_enforcement(mock_post):
    client = ClawdeClient(api_key="test-key")
    
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"choices": [{"message": {"content": "Blocked message"}}]}
    mock_response.headers = {
        "x-intutic-verdict": "kill",
        "x-intutic-budget-remaining": "10.0"
    }
    mock_post.return_value = mock_response
    
    with pytest.raises(ClawdeVerdictError):
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])
