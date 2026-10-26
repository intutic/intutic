"""Which control plane each client uses while the hosted cloud is unreleased
(release.CLOUD_RELEASED is False): none by default, so nothing is sent to
Intutic's hosted API unless the caller names it. An explicit address, then
INTUTIC_CONTROL_PLANE_URL, still win, so staging and self-run control planes
keep working.
"""

from __future__ import annotations

import json
import subprocess
from unittest.mock import patch

import pytest

from intutic_clawde import ClawdeClient, ClawdeConnectionError, ControlPlaneClient, control_plane, release
from intutic_clawde.gate.client import GateClient

ENV = "https://cp.env.example"
EXPLICIT = "https://cp.explicit.example"
STORED = "https://cp.stored.example"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("INTUTIC_CONTROL_PLANE_URL", raising=False)
    monkeypatch.delenv("INTUTIC_API_KEY", raising=False)
    monkeypatch.delenv("INTUTIC_WORKSPACE_ID", raising=False)
    monkeypatch.delenv("INTUTIC_SESSION_ID", raising=False)
    # No real ~/.intutic/credentials.json.
    monkeypatch.setenv("HOME", str(tmp_path))


def test_the_flags_are_off_and_there_is_no_default():
    assert release.CLOUD_RELEASED is False
    assert release.SELF_HOST_RELEASED is False
    assert control_plane.DEFAULT_CONTROL_PLANE_URL is None
    assert control_plane.resolve_control_plane_url() is None


def test_control_plane_client_needs_an_address():
    with pytest.raises(ValueError, match="INTUTIC_CONTROL_PLANE_URL"):
        ControlPlaneClient(api_key="vk_test")


def test_control_plane_client_env_then_explicit(monkeypatch):
    monkeypatch.setenv("INTUTIC_CONTROL_PLANE_URL", ENV)
    assert ControlPlaneClient(api_key="vk_test").base_url == ENV
    assert ControlPlaneClient(api_key="vk_test", base_url=EXPLICIT).base_url == EXPLICIT


@patch("requests.get")
def test_clawde_client_without_an_address_chats_but_cannot_check_budget(mock_get):
    client = ClawdeClient(api_key="vk_test")
    assert client.control_plane_url is None
    with pytest.raises(ClawdeConnectionError, match="INTUTIC_CONTROL_PLANE_URL"):
        client.check_budget("gpt-4o", 1)
    mock_get.assert_not_called()


@patch("requests.request")
def test_clawde_client_without_an_address_registers_no_session(mock_request, tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "-c", "user.name=t", "-c", "user.email=t@example.com",
                    "commit", "-q", "--allow-empty", "-m", "init"], check=True)
    monkeypatch.chdir(tmp_path)
    assert ClawdeClient(api_key="vk_test")._open_session() is None
    mock_request.assert_not_called()


def test_clawde_client_env_then_explicit(monkeypatch):
    monkeypatch.setenv("INTUTIC_CONTROL_PLANE_URL", ENV)
    assert ClawdeClient(api_key="vk_test").control_plane_url == ENV
    assert ClawdeClient(api_key="vk_test", control_plane_url=EXPLICIT).control_plane_url == EXPLICIT


def test_gate_client_without_key_or_address_is_local_only():
    client = GateClient()
    assert client.local_only is True
    assert client.base_url == ""
    assert client.hook_gate("shell", {"command": "ls"}).code == "LOCAL_ONLY"


def test_gate_client_with_a_key_needs_an_address(monkeypatch):
    with pytest.raises(ValueError, match="INTUTIC_CONTROL_PLANE_URL"):
        GateClient(api_key="vk_test")
    monkeypatch.setenv("INTUTIC_CONTROL_PLANE_URL", ENV + "/")
    assert GateClient(api_key="vk_test").base_url == ENV
    assert GateClient(api_key="vk_test", base_url=EXPLICIT).base_url == EXPLICIT


def _write_credentials(home, **body):
    (home / ".intutic").mkdir()
    (home / ".intutic" / "credentials.json").write_text(json.dumps(body), encoding="utf-8")


def test_gate_from_env_uses_the_control_plane_intutic_login_saved(tmp_path, monkeypatch):
    _write_credentials(tmp_path, apiKey="vk_stored", workspaceId="ws_1", controlPlaneUrl=STORED)
    client = GateClient.from_env(session_id="s_1")
    assert (client.base_url, client.api_key, client.workspace_id) == (STORED, "vk_stored", "ws_1")
    monkeypatch.setenv("INTUTIC_CONTROL_PLANE_URL", ENV)
    assert GateClient.from_env(session_id="s_1").base_url == ENV


def test_gate_from_env_reads_the_keychain_token_when_the_file_holds_the_marker(tmp_path, monkeypatch):
    from intutic_clawde.gate import client as gate_client

    _write_credentials(tmp_path, apiKey="keychain", workspaceId="ws_1", controlPlaneUrl=STORED)
    asked = []
    monkeypatch.setattr(gate_client, "_keychain_token", lambda ws: asked.append(ws) or "vk_from_keychain")
    client = GateClient.from_env(session_id="s_1")
    assert (client.api_key, asked) == ("vk_from_keychain", ["ws_1"])


def test_gate_from_env_never_sends_the_marker_as_a_key(tmp_path, monkeypatch):
    from intutic_clawde.gate import client as gate_client

    _write_credentials(tmp_path, apiKey="keychain", workspaceId="ws_1", controlPlaneUrl=STORED)
    monkeypatch.setattr(gate_client, "_keychain_token", lambda ws: "")
    client = GateClient.from_env(session_id="s_1")
    assert client.api_key != "keychain"
    assert client.local_only is True


def test_gate_from_env_without_key_is_local_only():
    client = GateClient.from_env(session_id="s_1")
    assert client.local_only is True


def test_gate_from_env_with_a_key_and_no_address_says_so(tmp_path):
    _write_credentials(tmp_path, apiKey="vk_stored", workspaceId="ws_1")
    with pytest.raises(ValueError, match="INTUTIC_CONTROL_PLANE_URL"):
        GateClient.from_env(session_id="s_1")


def test_released_cloud_is_the_default(monkeypatch):
    monkeypatch.setattr(control_plane, "DEFAULT_CONTROL_PLANE_URL", release.HOSTED_CONTROL_PLANE_URL)
    assert ControlPlaneClient(api_key="vk_test").base_url == "https://api.intutic.ai"
    assert ClawdeClient(api_key="vk_test").control_plane_url == "https://api.intutic.ai"
    assert GateClient(api_key="vk_test").base_url == "https://api.intutic.ai"
    monkeypatch.setenv("INTUTIC_CONTROL_PLANE_URL", ENV)
    assert ControlPlaneClient(api_key="vk_test").base_url == ENV
