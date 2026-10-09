"""Every ControlPlaneClient method against
packages/shared-types/fixtures/control-plane-operations.json, the list the
TypeScript SDK's __tests__/control-plane-operations.test.ts runs too: the
method set must equal the list's, and each method must make the listed request
and return the listed answer. A method added to one SDK and not the other, or a
call that drifts, fails here or there."""

import inspect
import json
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import intutic_clawde
from intutic_clawde import ClawdeConnectionError, ControlPlaneClient

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "control-plane-operations.json").read_text(
        encoding="utf-8"
    )
)
BASE_URL = "https://cp.example.com"


def _snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _decode_arg(arg):
    """``{"$bytes": text}`` in the fixture is a bytes argument."""
    if isinstance(arg, dict) and set(arg) == {"$bytes"}:
        return arg["$bytes"].encode("utf-8")
    return arg


def _call(vector):
    args = [_decode_arg(a) for a in vector.get("pyArgs", vector.get("args", []))]
    if "pyKwargs" in vector:
        kwargs = vector["pyKwargs"]
    else:
        kwargs = {_snake(k): v for k, v in (vector.get("options") or {}).items()}
    return args, kwargs


def _response(spec):
    res = MagicMock()
    res.status_code = spec["status"]
    res.ok = 200 <= spec["status"] < 300
    if "text" in spec:
        res.text = spec["text"]
        res.content = spec["text"].encode("utf-8")
        res.json.side_effect = ValueError("not JSON")
    else:
        # The TypeScript SDK's test server answers JSON.stringify(body): the same text.
        res.text = json.dumps(spec["body"], separators=(",", ":"), ensure_ascii=False)
        res.content = res.text.encode("utf-8")
        res.json.return_value = json.loads(res.text)
    return res


def test_method_set_is_the_shared_list_and_its_names_are_the_typescript_ones_in_snake_case():
    declared = sorted(
        name
        for name, member in inspect.getmembers(ControlPlaneClient, inspect.isfunction)
        if not name.startswith("_")
    )
    assert declared == sorted(v["py"] for v in FIXTURE["operations"])
    for v in FIXTURE["operations"]:
        assert v["py"] == _snake(v["ts"])


def test_exports_exactly_the_offline_checks_the_shared_list_names():
    exported = sorted(name for name in intutic_clawde.__all__ if name.startswith("verify_"))
    assert exported == sorted(o["py"] for o in FIXTURE["offline"])
    repo = Path(__file__).resolve().parents[3]
    for o in FIXTURE["offline"]:
        assert o["py"] == _snake(o["ts"])
        assert callable(getattr(intutic_clawde, o["py"]))
        assert any(v["ts"] == o["keys"] for v in FIXTURE["operations"])
        assert (repo / o["vectors"]).is_file()


@pytest.mark.parametrize("vector", FIXTURE["operations"], ids=[v["py"] for v in FIXTURE["operations"]])
def test_operation(vector):
    req = vector["request"]
    args, kwargs = _call(vector)
    with patch("requests.request", return_value=_response(vector["response"])) as mock_request:
        result = getattr(ControlPlaneClient(api_key="vk_test", base_url=BASE_URL), vector["py"])(*args, **kwargs)

    (method, url), sent = mock_request.call_args
    assert method == req["method"]
    assert url == BASE_URL + req["path"]
    if req.get("auth", True):
        assert sent["headers"]["Authorization"] == "Bearer vk_test"
    else:
        assert "Authorization" not in sent["headers"]

    if "multipart" in req:
        file, fields = req["multipart"]["file"], req["multipart"]["fields"]
        assert sent["files"] == {file["field"]: (file["fileName"], file["text"].encode("utf-8"), file["contentType"])}
        assert sent["data"] == fields
        # requests writes the multipart content type, boundary included.
        assert "Content-Type" not in sent["headers"]
    elif "body" in req:
        assert sent["json"] == req["body"]
    else:
        assert sent.get("json") is None

    if "returnsText" in vector:
        assert isinstance(result, bytes)
        assert result.decode("utf-8") == vector["returnsText"]
    else:
        assert result == vector["returns"]


@pytest.mark.parametrize("vector", FIXTURE["errors"], ids=[e["message"][:60] for e in FIXTURE["errors"]])
def test_error(vector):
    with patch("requests.request", return_value=_response(vector["response"])):
        client = ControlPlaneClient(api_key="vk_test", base_url=BASE_URL)
        with pytest.raises(ClawdeConnectionError) as excinfo:
            getattr(client, _snake(vector["ts"]))(*vector["args"])
    assert str(excinfo.value) == vector["message"]


def test_refuses_a_coverage_format_the_route_does_not_serve_before_any_request():
    with patch("requests.request") as mock_request:
        with pytest.raises(ValueError, match="format must be one of json, md, csv, pdf"):
            ControlPlaneClient(api_key="vk_test", base_url=BASE_URL).download_framework_coverage("eu_ai_act", "docx")
    mock_request.assert_not_called()
