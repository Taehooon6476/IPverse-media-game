"""IPverse Studio custom nodes for Griptape Nodes engine 0.101.

Requires the Griptape Nodes Desktop app. Not a server-side dependency.
Bind the engine secret IPVERSE_TOKEN to the auth_token parameter on each node.
"""
from __future__ import annotations
import hashlib
import json
import urllib.error
import urllib.request

from griptape_nodes.exe_types.core_types import Parameter, ParameterMode
from griptape_nodes.exe_types.node_types import ControlNode, DataNode

_TOOLS = [
    "set_concept",
    "create_ip_asset",
    "render_3d",
    "make_video_shot",
    "cut_trailer",
    "make_game",
    "publish_game",
]
_IN_PROP = {ParameterMode.INPUT, ParameterMode.PROPERTY}
_OUT = {ParameterMode.OUTPUT}
_TIMEOUT = 60


def _request_json(req: urllib.request.Request) -> object:
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {raw}") from e
    data = json.loads(body)
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(f"API error {data['error']}: {data.get('message', '')}")
    return data


class IPverseRunTool(ControlNode):
    """POST /api/sessions/{id}/tools/{tool} and expose result_json."""

    def __init__(self, name: str, metadata=None):
        super().__init__(name, metadata)
        self.add_parameter(Parameter(
            name="api_base", type="str", default_value="",
            tooltip="Platform base URL, e.g. https://d123.cloudfront.net",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="auth_token", type="str", default_value="",
            tooltip="Cognito AccessToken — bind to engine secret IPVERSE_TOKEN",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="session_id", type="str", default_value="",
            tooltip="IPverse session UUID",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="tool", type="str", default_value="render_3d",
            tooltip=f"Tool to call: {', '.join(_TOOLS)}",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="args_json", type="str", default_value="{}",
            tooltip="Tool arguments as a JSON string",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="result_json", type="str", default_value="",
            tooltip="Raw JSON response from the tool call",
            allowed_modes=_OUT,
        ))

    def process(self) -> None:
        api_base = self.get_parameter_value("api_base").rstrip("/")
        token = self.get_parameter_value("auth_token")
        session_id = self.get_parameter_value("session_id")
        tool = self.get_parameter_value("tool")
        args = json.loads(self.get_parameter_value("args_json") or "{}")

        url = f"{api_base}/api/sessions/{session_id}/tools/{tool}"
        body = json.dumps(args).encode()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Auth-Token": token,
                "x-amz-content-sha256": hashlib.sha256(body).hexdigest(),
            },
        )
        result = _request_json(req)
        self.parameter_output_values["result_json"] = json.dumps(result)


class IPverseSessionAssets(DataNode):
    """GET /api/sessions/{id} snapshot and expose assets list."""

    def __init__(self, name: str, metadata=None):
        super().__init__(name, metadata)
        self.add_parameter(Parameter(
            name="api_base", type="str", default_value="",
            tooltip="Platform base URL",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="auth_token", type="str", default_value="",
            tooltip="Cognito AccessToken — bind to engine secret IPVERSE_TOKEN",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="session_id", type="str", default_value="",
            tooltip="IPverse session UUID",
            allowed_modes=_IN_PROP,
        ))
        self.add_parameter(Parameter(
            name="assets_json", type="str", default_value="",
            tooltip="Full assets array from the session snapshot as a JSON string",
            allowed_modes=_OUT,
        ))
        self.add_parameter(Parameter(
            name="asset_urls", type="list", default_value=None,
            tooltip="List of CDN asset URLs from the session",
            allowed_modes=_OUT,
        ))

    def process(self) -> None:
        api_base = self.get_parameter_value("api_base").rstrip("/")
        token = self.get_parameter_value("auth_token")
        session_id = self.get_parameter_value("session_id")

        url = f"{api_base}/api/sessions/{session_id}"
        req = urllib.request.Request(
            url, method="GET",
            headers={"X-Auth-Token": token},
        )
        snapshot = _request_json(req)
        assets = snapshot.get("assets", [])
        self.parameter_output_values["assets_json"] = json.dumps(assets)
        self.parameter_output_values["asset_urls"] = [
            a["url"] for a in assets if "url" in a
        ]
