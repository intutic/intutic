"""A gate with no API key is local-only: the local tiers decide, the
control-plane tiers are skipped, and nothing is sent. A key the control plane
refuses still fails closed. The vectors are shared with @intutic/gate's
src/__tests__/localOnly.test.ts.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from intutic_clawde.gate.client import GateClient
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal
from conftest import rules_text

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "shared-types" / "fixtures"
     / "gate-client-credentials-vectors.json").read_text(encoding="utf-8")
)


class ControlPlane:
    """A local HTTP server that answers every request with `answer`, and counts them."""

    def __init__(self):
        self.answer = {"status": 200, "body": {}}
        self.requests = 0
        plane = self

        class Handler(BaseHTTPRequestHandler):
            def _respond(self):
                plane.requests += 1
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                raw = json.dumps(plane.answer["body"]).encode("utf-8")
                self.send_response(plane.answer["status"])
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _respond

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture(scope="module")
def plane():
    p = ControlPlane()
    yield p
    p.server.shutdown()


@pytest.fixture(autouse=True)
def _reset(plane):
    plane.requests = 0


def test_local_only_exactly_when_there_is_no_key():
    assert GateClient().local_only is True
    assert GateClient(api_key="").local_only is True
    assert GateClient(api_key="k", base_url="https://cp.example").local_only is False


def test_a_local_only_client_sends_no_events(plane):
    plane.answer = {"status": 200, "body": {"ok": True}}
    assert GateClient(base_url=plane.url).emit("tool_allowed", "shell") is False
    assert plane.requests == 0


@pytest.mark.parametrize("v", VECTORS["hookGate"], ids=[v["name"] for v in VECTORS["hookGate"]])
def test_hook_gate_as_the_shared_vectors_say(plane, v):
    plane.answer = v["response"]
    client = GateClient(base_url=plane.url, api_key=v["apiKey"], workspace_id="ws_1",
                        fail_closed=v["failClosed"])
    r = client.hook_gate("shell", {"command": "make test"})
    want = v["expect"]
    assert (r.allowed, r.reached) == (want["allowed"], want["reached"])
    assert r.code == want.get("code")
    if "reasonContains" in want:
        assert want["reasonContains"] in r.reason
    if "requests" in want:
        assert plane.requests == want["requests"]


@pytest.mark.parametrize("v", VECTORS["guard"], ids=[v["name"] for v in VECTORS["guard"]])
def test_guard_as_the_shared_vectors_say(plane, v, tmp_path, monkeypatch):
    plane.answer = v["response"]
    snap = tmp_path / "snap.rules"
    snap.write_text(rules_text(v["snapshotRules"]), encoding="utf-8")
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(snap))
    client = GateClient(base_url=plane.url, api_key=v["apiKey"], workspace_id="ws_1",
                        session_id="s_1")
    gate = Gate(GateConfig(workspace_id="ws_1", repo_root=str(tmp_path)), client=client)
    refused = None
    try:
        gate.guard(v["call"]["tool"], v["call"]["input"])
    except IntuticGateRefusal as exc:
        refused = exc.code
    assert refused == v["expect"]["refused"]
    if "requests" in v["expect"]:
        assert plane.requests == v["expect"]["requests"]
