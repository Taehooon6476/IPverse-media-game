"""TDD tests for ipverse_nodes (Griptape custom nodes).
Stubs griptape_nodes into sys.modules — no Griptape engine required.
"""
from __future__ import annotations
import hashlib
import io
import json as _json
import os
import sys
import types
import urllib.error
import urllib.request

import pytest

# Stub griptape_nodes before any import of ipverse_nodes

class _ParameterMode:
    INPUT = "INPUT"
    OUTPUT = "OUTPUT"
    PROPERTY = "PROPERTY"


class _Parameter:
    def __init__(self, *, name, type="str", default_value=None, tooltip="",
                 allowed_modes=None, tooltip_as_input_placeholder=False):
        self.name = name
        self.type = type
        self.default_value = default_value
        self.tooltip = tooltip
        self.allowed_modes = allowed_modes or set()


class _BaseNode:
    def __init__(self, name, metadata=None):
        self.name = name
        self._params: dict = {}
        self._output: dict = {}

    def add_parameter(self, param):
        self._params[param.name] = param

    def get_parameter_value(self, name):
        return self._params[name].default_value

    @property
    def parameter_output_values(self):
        return self._output


class _ControlNode(_BaseNode):
    pass


class _DataNode(_BaseNode):
    pass


_gn = types.ModuleType("griptape_nodes")
_exe_types = types.ModuleType("griptape_nodes.exe_types")
_core_types = types.ModuleType("griptape_nodes.exe_types.core_types")
_core_types.Parameter = _Parameter
_core_types.ParameterMode = _ParameterMode
_node_types = types.ModuleType("griptape_nodes.exe_types.node_types")
_node_types.ControlNode = _ControlNode
_node_types.DataNode = _DataNode

for _mod, _name in [
    (_gn, "griptape_nodes"),
    (_exe_types, "griptape_nodes.exe_types"),
    (_core_types, "griptape_nodes.exe_types.core_types"),
    (_node_types, "griptape_nodes.exe_types.node_types"),
]:
    sys.modules.setdefault(_name, _mod)

# Add plugin root to path so `import ipverse_nodes` works
_plugin_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

import ipverse_nodes  # noqa: E402


_TOOL_NAMES = [
    "set_concept", "create_ip_asset", "render_3d",
    "make_video_shot", "cut_trailer", "make_game", "publish_game",
]


# Parameter presence tests

def test_run_tool_has_expected_params():
    node = ipverse_nodes.IPverseRunTool("t")
    names = set(node._params)
    for p in ("api_base", "auth_token", "session_id", "tool", "args_json", "result_json"):
        assert p in names, f"missing param: {p}"


def test_session_assets_has_expected_params():
    node = ipverse_nodes.IPverseSessionAssets("t")
    names = set(node._params)
    for p in ("api_base", "auth_token", "session_id", "assets_json", "asset_urls"):
        assert p in names, f"missing param: {p}"


# process() — IPverseRunTool

def test_run_tool_process_posts_correct_url_and_header(monkeypatch):
    """process() must POST to {api_base}/api/sessions/{sid}/tools/{tool} with X-Auth-Token."""
    captured: dict = {}

    class _FakeResp:
        def read(self): return _json.dumps({"result": "ok"}).encode()
        def __enter__(self): return self
        def __exit__(self, *_): pass

    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["header"] = req.get_header("X-auth-token")
        captured["sha256"] = req.get_header("X-amz-content-sha256")
        captured["body"] = _json.loads(req.data)
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    node = ipverse_nodes.IPverseRunTool("t")
    node._params["api_base"].default_value = "https://api.example.com"
    node._params["auth_token"].default_value = "tok-123"
    node._params["session_id"].default_value = "ses-abc"
    node._params["tool"].default_value = "render_3d"
    node._params["args_json"].default_value = '{"ipId": "ip-1"}'

    node.process()

    assert captured["url"] == "https://api.example.com/api/sessions/ses-abc/tools/render_3d"
    assert captured["method"] == "POST"
    assert captured["header"] == "tok-123"
    assert captured["body"] == {"ipId": "ip-1"}
    assert node._output["result_json"] == _json.dumps({"result": "ok"})
    # payload hash must match sha256 of the serialised body
    expected_hash = hashlib.sha256(_json.dumps({"ipId": "ip-1"}).encode()).hexdigest()
    assert captured["sha256"] == expected_hash


def test_run_tool_process_raises_on_http_error(monkeypatch):
    """_request_json must surface HTTP {code}: {body} when urlopen raises HTTPError."""

    def _fake_urlopen(req, timeout=None):
        body = _json.dumps({"error": "unauthorized", "message": "Bad token"}).encode()
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", {}, io.BytesIO(body)
        )

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    node = ipverse_nodes.IPverseRunTool("t")
    node._params["api_base"].default_value = "https://api.example.com"
    node._params["auth_token"].default_value = "bad-token"
    node._params["session_id"].default_value = "ses-abc"
    node._params["tool"].default_value = "render_3d"
    node._params["args_json"].default_value = "{}"

    with pytest.raises(RuntimeError) as exc_info:
        node.process()

    msg = str(exc_info.value)
    assert "401" in msg, f"Expected '401' in error message: {msg}"
    assert "unauthorized" in msg, f"Expected body text in error message: {msg}"


# process() — IPverseSessionAssets

def test_session_assets_process_gets_correct_url(monkeypatch):
    captured: dict = {}
    _snapshot = {
        "session": {},
        "assets": [{"assetId": "a1", "url": "https://cdn/a1.png"}],
    }

    class _FakeResp:
        def read(self): return _json.dumps(_snapshot).encode()
        def __enter__(self): return self
        def __exit__(self, *_): pass

    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["header"] = req.get_header("X-auth-token")
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    node = ipverse_nodes.IPverseSessionAssets("t")
    node._params["api_base"].default_value = "https://api.example.com"
    node._params["auth_token"].default_value = "tok-abc"
    node._params["session_id"].default_value = "ses-xyz"

    node.process()

    assert captured["url"] == "https://api.example.com/api/sessions/ses-xyz"
    assert captured["method"] == "GET"
    assert captured["header"] == "tok-abc"
    assert node._output["assets_json"] == _json.dumps(_snapshot["assets"])
    assert node._output["asset_urls"] == ["https://cdn/a1.png"]
