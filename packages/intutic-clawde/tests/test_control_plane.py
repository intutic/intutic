import os
import pytest
from unittest.mock import MagicMock, patch
from intutic_clawde import ControlPlaneClient, ClawdeConnectionError


def _mock_response(status_code=200, json_body=None, text="", content=b"{}"):
    res = MagicMock()
    res.status_code = status_code
    res.ok = 200 <= status_code < 300
    res.json.return_value = json_body if json_body is not None else {}
    res.text = text
    res.content = content
    return res


def test_requires_api_key():
    with pytest.raises(ValueError):
        ControlPlaneClient(api_key="")


def test_defaults_base_url():
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("INTUTIC_CONTROL_PLANE_URL", None)
        client = ControlPlaneClient(api_key="vk_test")
        assert client.base_url == "https://app.intutic.ai"


def test_respects_env_base_url():
    with patch.dict(os.environ, {"INTUTIC_CONTROL_PLANE_URL": "https://self-hosted.example.com"}):
        client = ControlPlaneClient(api_key="vk_test")
        assert client.base_url == "https://self-hosted.example.com"


@patch("requests.request")
def test_whoami_calls_get_auth_me_with_bearer_token(mock_request):
    mock_request.return_value = _mock_response(
        json_body={"email": "a@b.com", "memberId": "mem_1", "workspaceId": "ws_1", "role": "OWNER"}
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.whoami()

    args, kwargs = mock_request.call_args
    assert args[0] == "GET"
    assert args[1] == "https://cp.example.com/api/v1/auth/me"
    assert kwargs["headers"]["Authorization"] == "Bearer vk_test"
    assert res["role"] == "OWNER"


@patch("requests.request")
def test_signup_org_calls_post_without_bearer_token(mock_request):
    mock_request.return_value = _mock_response(
        json_body={
            "user": {"id": "u1", "email": "a@b.com", "name": "A", "emailVerified": False},
            "org": {"id": "org_1", "name": "Acme", "planTier": "pro", "trialExpiresAt": "2026-09-01"},
            "workspace": {"id": "ws_1", "name": "default", "planTier": "pro", "trialExpiresAt": "2026-09-01"},
            "accessToken": "tok",
            "refreshToken": "rtok",
            "cliInstall": "npm i -g @intutic/cli",
            "isNewUser": True,
        }
    )
    client = ControlPlaneClient(api_key="unused", base_url="https://cp.example.com")
    res = client.signup_org("a@b.com", "password123", "A", "Acme")

    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://cp.example.com/api/v1/auth/signup/org"
    assert "Authorization" not in kwargs["headers"]
    assert kwargs["json"] == {"email": "a@b.com", "password": "password123", "name": "A", "orgName": "Acme"}
    assert res["org"]["id"] == "org_1"


@patch("requests.request")
def test_start_domain_verification_posts_domain_with_bearer_token(mock_request):
    mock_request.return_value = _mock_response(
        json_body={
            "verificationId": "dv_1",
            "domain": "acme.com",
            "txtRecordName": "_intutic-verify.acme.com",
            "txtRecordValue": "abc123",
            "expiresAt": "2026-09-01",
        }
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.start_domain_verification("acme.com")

    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://cp.example.com/api/v1/domain-verification/start"
    assert kwargs["headers"]["Authorization"] == "Bearer vk_test"
    assert kwargs["json"] == {"domain": "acme.com"}
    assert res["verificationId"] == "dv_1"
    assert res["txtRecordValue"] == "abc123"


@patch("requests.request")
def test_check_domain_verification_calls_get_by_id(mock_request):
    mock_request.return_value = _mock_response(
        json_body={
            "verificationId": "dv_1",
            "domain": "acme.com",
            "status": "verified",
            "txtRecordName": "_intutic-verify.acme.com",
            "txtRecordValue": "abc123",
            "verifiedAt": "2026-08-14",
        }
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.check_domain_verification("dv_1")

    args, _ = mock_request.call_args
    assert args[0] == "GET"
    assert args[1] == "https://cp.example.com/api/v1/domain-verification/dv_1"
    assert res["status"] == "verified"


@patch("requests.request")
def test_create_org_passes_optional_region_and_omits_when_none(mock_request):
    mock_request.return_value = _mock_response(
        json_body={"orgId": "org_1", "teamId": "team_1", "workspaceId": "ws_1", "name": "Acme", "planTier": "pro", "region": "eu"}
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    client.create_org("Acme", "acme.com", "dv_1", region="eu")
    _, kwargs = mock_request.call_args
    assert kwargs["json"] == {"orgName": "Acme", "domain": "acme.com", "verificationId": "dv_1", "region": "eu"}

    client.create_org("Acme", "acme.com", "dv_1")
    _, kwargs = mock_request.call_args
    assert "region" not in kwargs["json"]


@patch("requests.request")
def test_create_org_posts_org_name_domain_verification_id_with_bearer_token(mock_request):
    mock_request.return_value = _mock_response(
        json_body={"orgId": "org_1", "teamId": "team_1", "workspaceId": "ws_1", "name": "Acme", "planTier": "pro"}
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.create_org("Acme", "acme.com", "dv_1")

    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://cp.example.com/api/v1/orgs"
    assert kwargs["headers"]["Authorization"] == "Bearer vk_test"
    assert kwargs["json"] == {"orgName": "Acme", "domain": "acme.com", "verificationId": "dv_1"}
    assert res["orgId"] == "org_1"


@patch("requests.request")
def test_list_teams_unwraps_data_envelope(mock_request):
    mock_request.return_value = _mock_response(
        json_body={"data": [{"teamId": "t1", "orgId": "org_1", "name": "Eng", "slug": "eng", "createdAt": "x"}]}
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.list_teams("org_1")

    args, _ = mock_request.call_args
    assert args[1] == "https://cp.example.com/api/v1/orgs/org_1/teams"
    assert res == [{"teamId": "t1", "orgId": "org_1", "name": "Eng", "slug": "eng", "createdAt": "x"}]


@patch("requests.request")
def test_list_teams_defaults_to_empty_list(mock_request):
    mock_request.return_value = _mock_response(json_body={})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    assert client.list_teams("org_1") == []


@patch("requests.request")
def test_create_team_posts_name(mock_request):
    mock_request.return_value = _mock_response(
        json_body={"teamId": "t2", "orgId": "org_1", "name": "Design"}
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.create_team("org_1", "Design")

    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://cp.example.com/api/v1/orgs/org_1/teams"
    assert kwargs["json"] == {"name": "Design"}
    assert res["teamId"] == "t2"


@patch("requests.request")
def test_register_gateway_posts_name_and_target(mock_request):
    mock_request.return_value = _mock_response(
        json_body={"gatewayId": "gw_1", "name": "prod", "deploymentTarget": "docker", "status": "pending", "token": "gwk_once", "instructions": "go"}
    )
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.register_gateway("prod", "docker")

    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://cp.example.com/api/v1/gateways"
    assert kwargs["json"] == {"name": "prod", "deploymentTarget": "docker"}
    assert res["token"] == "gwk_once"


@patch("requests.request")
def test_list_gateways_unwraps_data(mock_request):
    mock_request.return_value = _mock_response(json_body={"data": [{"gatewayId": "gw_1"}]})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    assert client.list_gateways() == [{"gatewayId": "gw_1"}]


@patch("requests.request")
def test_get_gateway_status(mock_request):
    mock_request.return_value = _mock_response(json_body={"status": "online"})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.get_gateway_status("gw_1")

    args, _ = mock_request.call_args
    assert args[1] == "https://cp.example.com/api/v1/gateways/gw_1/status"
    assert res["status"] == "online"


@patch("requests.request")
def test_rotate_gateway_token(mock_request):
    mock_request.return_value = _mock_response(json_body={"gatewayId": "gw_1", "token": "gwk_new"})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.rotate_gateway_token("gw_1")

    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "https://cp.example.com/api/v1/gateways/gw_1/rotate"
    assert kwargs["json"] == {}
    assert res["token"] == "gwk_new"


@patch("requests.request")
def test_revoke_gateway_sends_reason(mock_request):
    mock_request.return_value = _mock_response()
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    client.revoke_gateway("gw_1", "decommissioned")

    args, kwargs = mock_request.call_args
    assert args[0] == "DELETE"
    assert args[1] == "https://cp.example.com/api/v1/gateways/gw_1"
    assert kwargs["json"] == {"reason": "decommissioned"}


@patch("requests.request")
def test_set_gateway_config_only_sends_provided_fields(mock_request):
    mock_request.return_value = _mock_response(json_body={"config": {"requireVk": True}, "configVersion": 2})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.set_gateway_config("gw_1", require_vk=True)

    args, kwargs = mock_request.call_args
    assert args[0] == "PATCH"
    assert kwargs["json"] == {"requireVk": True}
    assert res["configVersion"] == 2


@patch("requests.request")
def test_assign_workspace_gateway_null_clears(mock_request):
    mock_request.return_value = _mock_response(json_body={"gatewayId": None})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    client.assign_workspace_gateway(None)

    args, kwargs = mock_request.call_args
    assert args[0] == "PATCH"
    assert args[1] == "https://cp.example.com/api/v1/workspace/gateway"
    assert kwargs["json"] == {"gatewayId": None}


@patch("requests.request")
def test_assign_org_gateway(mock_request):
    mock_request.return_value = _mock_response(json_body={"gatewayId": "gw_1"})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    client.assign_org_gateway("org_1", "gw_1")

    args, kwargs = mock_request.call_args
    assert args[1] == "https://cp.example.com/api/v1/orgs/org_1/gateway"
    assert kwargs["json"] == {"gatewayId": "gw_1"}


@patch("requests.request")
def test_resolve_gateway(mock_request):
    mock_request.return_value = _mock_response(json_body={"source": "org", "gateway": None})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.resolve_gateway()

    args, _ = mock_request.call_args
    assert args[1] == "https://cp.example.com/api/v1/workspace/gateway-resolution"
    assert res["source"] == "org"


@patch("requests.request")
def test_list_provider_credentials_unwraps_data(mock_request):
    mock_request.return_value = _mock_response(json_body={"data": [{"provider": "anthropic"}]})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    assert client.list_provider_credentials() == [{"provider": "anthropic"}]


@patch("requests.request")
def test_set_provider_credential_puts_fields(mock_request):
    mock_request.return_value = _mock_response(json_body={"provider": "openrouter", "routingLive": False})
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    res = client.set_provider_credential("openrouter", {"apiKey": "sk-or-abc"})

    args, kwargs = mock_request.call_args
    assert args[0] == "PUT"
    assert args[1] == "https://cp.example.com/api/v1/workspace/provider-credentials/openrouter"
    assert kwargs["json"] == {"apiKey": "sk-or-abc"}
    assert res["routingLive"] is False


@patch("requests.request")
def test_unset_provider_credential(mock_request):
    mock_request.return_value = _mock_response()
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    client.unset_provider_credential("openrouter")

    args, _ = mock_request.call_args
    assert args[0] == "DELETE"
    assert args[1] == "https://cp.example.com/api/v1/workspace/provider-credentials/openrouter"


@patch("requests.request")
def test_url_encodes_path_segments(mock_request):
    mock_request.return_value = _mock_response()
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    client.unset_provider_credential("a b/c")

    args, _ = mock_request.call_args
    assert args[1] == "https://cp.example.com/api/v1/workspace/provider-credentials/a%20b%2Fc"


@patch("requests.request")
def test_raises_connection_error_on_non_2xx(mock_request):
    mock_request.return_value = _mock_response(status_code=403, text="Forbidden")
    client = ControlPlaneClient(api_key="vk_test", base_url="https://cp.example.com")
    with pytest.raises(ClawdeConnectionError, match="403"):
        client.whoami()


@patch("requests.request", side_effect=__import__("requests").exceptions.ConnectionError("refused"))
def test_raises_connection_error_when_unreachable(mock_request):
    client = ControlPlaneClient(api_key="vk_test", base_url="http://127.0.0.1:1")
    with pytest.raises(ClawdeConnectionError):
        client.whoami()
