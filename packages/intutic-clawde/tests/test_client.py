import pytest
import os
import json
from unittest.mock import MagicMock, patch
import requests
from intutic_clawde import ClawdeBlockedError, ClawdeClient, ClawdeConnectionError, ClawdeVerdictError

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
def test_budget_checker_cache(mock_get, monkeypatch):
    # Asserts the DEFAULT control-plane origin, so the env override must be
    # absent: test_control_plane.py sets INTUTIC_CONTROL_PLANE_URL and a shell
    # that exports it (a local dev pointing at 127.0.0.1:3001) made this fail
    # under a full run on 2026-09-15 while passing alone.
    monkeypatch.delenv("INTUTIC_CONTROL_PLANE_URL", raising=False)
    client = ClawdeClient(api_key="test-key")
    assert client.control_plane_url == "https://app.intutic.ai"

    # Mock the REAL control-plane response shape (GET /api/v1/budget),
    # not the historical nonexistent /v1/budget/check shape.
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"budget_remaining_usd": 150.0, "alert_triggered": False}
    mock_get.return_value = mock_response

    # First call: hits API
    res1 = client.check_budget("gpt-4o", 100)
    assert res1["allowed"] is True
    assert res1["remaining_usd"] == 150.0
    assert mock_get.call_count == 1
    called_url = mock_get.call_args[0][0]
    assert called_url == "https://app.intutic.ai/api/v1/budget"

    # Second call: hits cache, doesn't hit API again
    res2 = client.check_budget("gpt-4o", 100)
    assert res2["allowed"] is True
    assert mock_get.call_count == 1


@patch("requests.get")
def test_budget_checker_alert_triggered_is_not_allowed(mock_get):
    client = ClawdeClient(api_key="test-key")
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"budget_remaining_usd": 0, "alert_triggered": True}
    mock_get.return_value = mock_response

    res = client.check_budget("gpt-4o", 1)
    assert res["allowed"] is False
    assert res["remaining_usd"] == 0
    assert "alert threshold" in res["reason"]

def _no_budget(client):
    client.budget_checker.check_budget = MagicMock(
        return_value={"allowed": False, "remaining_usd": 0.0}
    )


def test_circuit_breaker_trips():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    mock_tool = MagicMock(return_value="success")
    wrapped = client.circuit_breaker("test_tool", require_budget=True)

    with pytest.raises(ClawdeVerdictError) as exc:
        wrapped(mock_tool)
    assert "budget exceeded" in str(exc.value)
    assert mock_tool.call_count == 0


def test_circuit_breaker_skips_budget_check_unless_asked():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    assert client.circuit_breaker("test_tool")(lambda: "ran") == "ran"
    assert client.budget_checker.check_budget.call_count == 0


def test_circuit_breaker_max_cost_usd_is_a_deprecated_switch():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    with pytest.warns(DeprecationWarning, match="require_budget"):
        wrapped = client.circuit_breaker("test_tool", max_cost_usd=5.0)
    with pytest.raises(ClawdeVerdictError):
        wrapped(lambda: "never runs")


def test_circuit_breaker_fail_open():
    client = ClawdeClient(api_key="test-key")
    _no_budget(client)

    # With fail_open=True, it should fail open (log warning and continue execution of mock_tool)
    mock_tool = MagicMock(return_value="success")
    wrapped = client.circuit_breaker("test_tool", require_budget=True, fail_open=True)

    result = wrapped(mock_tool)
    assert result == "success"
    assert mock_tool.call_count == 1


def test_circuit_breaker_reraises_a_proxy_refusal():
    client = ClawdeClient(api_key="test-key")

    def refused():
        raise ClawdeBlockedError("kill", "policy_denied", 403, "Request blocked")

    with pytest.raises(ClawdeBlockedError):
        client.circuit_breaker("test_tool")(refused)


def _reply(status, body):
    res = MagicMock()
    res.status_code = status
    res.text = json.dumps(body)
    res.json.return_value = body
    return res


def _proxy_error(code, message):
    """The proxy's error body, as `json_error` in packages/proxy/src/proxy.rs writes it."""
    return {"error": {"type": code, "message": message}}


COMPLETION = {"choices": [{"message": {"role": "assistant", "content": "hi"}}]}


@patch("requests.post")
def test_chat_reports_allow_and_sends_only_headers_the_proxy_reads(mock_post):
    mock_post.return_value = _reply(200, COMPLETION)
    client = ClawdeClient(api_key="vk_test", base_url="http://proxy")

    result = client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    assert result["verdict"] == "allow"
    assert mock_post.call_args[0][0] == "http://proxy/v1/chat/completions"
    # Never read by the proxy, which forwards unknown headers to the provider.
    assert mock_post.call_args.kwargs["headers"] == {
        "Content-Type": "application/json",
        "Authorization": "Bearer vk_test",
    }


@pytest.mark.parametrize("status,code,verdict", [
    (403, "policy_denied", "kill"),
    (403, "model_not_allowed", "kill"),
    (403, "LOOP_RUN_TERMINATED", "kill"),
    (403, "LOOP_RUN_PENDING_REVIEW", "hold"),
    (409, "policy_reask", "reask"),
    (429, "BUDGET_EXCEEDED", "kill"),
    (429, "OVERAGE_HARD_CAP_EXCEEDED", "kill"),
    (402, "COST_GATE_EXCEEDED", "kill"),
    (400, "dlp_policy_violation", "kill"),
])
@patch("requests.post")
def test_chat_refusal_is_not_retried_and_fires_its_event(mock_post, status, code, verdict):
    mock_post.return_value = _reply(status, _proxy_error(code, f"refused: {code}"))
    client = ClawdeClient(api_key="test-key")
    events = []
    client.on(verdict, events.append)

    with pytest.raises(ClawdeBlockedError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    # Callers that already catch ClawdeVerdictError for blocks keep working.
    assert isinstance(exc.value, ClawdeVerdictError)
    assert (exc.value.verdict, exc.value.code, exc.value.status) == (verdict, code, status)
    assert str(exc.value) == f"refused: {code}"
    assert mock_post.call_count == 1
    assert events == [{"verdict": verdict, "code": code, "status": status, "message": f"refused: {code}"}]


@patch("time.sleep")
@patch("requests.post")
def test_chat_retries_a_5xx(mock_post, _sleep):
    mock_post.side_effect = [
        _reply(503, _proxy_error("BUDGET_UNVERIFIABLE", "Retry shortly.")),
        _reply(502, _proxy_error("upstream_error", "connection reset")),
        _reply(200, COMPLETION),
    ]
    client = ClawdeClient(api_key="test-key")

    assert client.chat("gpt-4o", [{"role": "user", "content": "hello"}])["verdict"] == "allow"
    assert mock_post.call_count == 3


@patch("time.sleep")
@patch("requests.post")
def test_chat_retries_a_transport_failure_then_gives_up(mock_post, _sleep):
    mock_post.side_effect = requests.ConnectionError("refused")
    client = ClawdeClient(api_key="test-key", retries=1)

    with pytest.raises(ClawdeConnectionError, match="after 2 attempts"):
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])
    assert mock_post.call_count == 2


@pytest.mark.parametrize("status,body", [
    (403, _proxy_error("workspace_mismatch", "key belongs to another workspace")),
    (429, {"error": {"type": "rate_limit_error", "message": "provider rate limit"}}),
    (409, {"error": "conflict"}),
])
@patch("requests.post")
def test_chat_other_4xx_is_not_a_refusal_and_not_retried(mock_post, status, body):
    mock_post.return_value = _reply(status, body)
    client = ClawdeClient(api_key="test-key")
    events = []
    for verdict in ("kill", "reask", "hold"):
        client.on(verdict, events.append)

    with pytest.raises(ClawdeConnectionError) as exc:
        client.chat("gpt-4o", [{"role": "user", "content": "hello"}])

    assert not isinstance(exc.value, ClawdeVerdictError)
    assert str(status) in str(exc.value)
    assert mock_post.call_count == 1
    assert events == []
