"""What the studio is connected to: the platform's own APIs and MCP servers (read-only, with a live check of
each MCP server's tools/list; listed by plain name and state, never by address), and MCP servers a user adds. A
user's enabled servers become agent tools (`mcp_<conn>_<tool>`, proxied as tools/call), so the chat can use them.

Users' servers live under pk CONN#<sub>. ponytail: an auth header value is stored as-is in DynamoDB (encrypted
at rest) and never returned to the browser; Secrets Manager per connection if that is not enough.
"""
from __future__ import annotations
import ipaddress
import json
import os
import re
import socket
import traceback
import urllib.error
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from server import store
from server.providers import mcp_client, mediagen_video
from server import i18n
from server.i18n import said, tr

TIMEOUT_SEC = 20  # one handshake request (some servers take ~11 s behind a CDN)
IMAGE_CATALOG_WAIT_SEC = 8  # list_models asks the GPU box itself (up to 20 s when it is slow): the defaults beat a wait
# The image MCP's models (list_models), used only while it cannot be read
DEFAULT_IMAGE_MODELS = [{"id": "klein9", "label": "FLUX.2 klein 9B"}, {"id": "krea", "label": "Krea 2 Turbo"}]
_image_catalog: dict = {}
ADD_BUDGET_SEC = 25  # the whole add/refresh handshake: stays under the ~30 s synchronous API limit
TURN_LIST_BUDGET_SEC = 10  # listing every enabled server at the start of a chat turn (in parallel)
CALL_TIMEOUT_SEC = 90  # tools/call: real tools (wiki Q&A, search) take 10-60 s; also bounded by the turn deadline
MAX_USER_SERVERS = 10
MAX_AGENT_TOOLS = 40
PROTOCOL = "2025-03-26"


class ConnError(Exception):
    def __init__(self, status: int, code: str, message: str):
        message = said(message)  # in the request's language
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _platform():
    """The platform's services. A row's name says what the service does for the user; the rest of a row (kind,
    endpoint, keyParam, configured) is for the check and never leaves the server (listing, SHOWN). The ids stay:
    the page looks imagegen and videogen up by them."""
    env = os.environ.get
    return [
        {"id": "imagegen", "kind": "mcp", "name": "이미지 생성", "endpoint": mcp_client.IMAGE.url,
         "keyParam": mcp_client.IMAGE.key_param},
        {"id": "videogen", "kind": "mcp", "name": "영상 생성", "endpoint": mcp_client.VIDEO.url,
         "keyParam": mcp_client.VIDEO.key_param},
        {"id": "bedrock-agent", "kind": "aws", "name": "채팅 에이전트"},
        {"id": "bedrock-image", "kind": "aws", "name": "배경 제거 · Stable Image 생성"},
        {"id": "bedrock-pegasus", "kind": "aws", "name": "라이브 하이라이트"},
        {"id": "deadline", "kind": "aws", "name": "3D 렌더", "configured": bool(env("DEADLINE_FARM_ID"))},
        {"id": "live", "kind": "aws", "name": "라이브 방송", "configured": bool(env("LIVE_IVS_INGEST"))},
    ]


# What the browser is told of a platform service: its plain name, its state, a sentence when it does not answer, and
# for the two generation services the models the dropdowns offer. Addresses, ids and tool schemas never leave the
# server: nothing there is anything a user can act on.
SHOWN = ("id", "name", "status", "error", "models")
NO_ANSWER = "지금은 응답이 없어요. 잠시 뒤 ‘상태 새로고침’을 눌러 주세요."


# ── MCP streamable HTTP (JSON or SSE replies, optional Mcp-Session-Id) ──

def _rpc(url, method, params, headers, session_id=None, notify=False, timeout=TIMEOUT_SEC):
    body = {"jsonrpc": "2.0", "method": method, **({} if notify else {"id": 1}), **({"params": params} if params else {})}
    # a real User-Agent: CDN bot rules (e.g. Cloudflare 1010) reject urllib's default
    h = {"user-agent": "ipverse-studio/1 (+mcp)", "content-type": "application/json",
         "accept": "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, **headers}
    if session_id:
        h["mcp-session-id"] = session_id
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, sid = r.read().decode("utf-8", "replace"), r.headers.get("mcp-session-id")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code in (401, 403):
            raise RuntimeError(tr("인증이 필요하거나 거부됐어요 (HTTP {code}). 인증 헤더와 값을 확인해 주세요.", code=e.code)) from None
        if "html" in (e.headers.get("content-type") or "") or body.lstrip().startswith("<"):
            raise RuntimeError(tr("MCP 서버 응답이 아니에요 (HTTP {code}). 주소가 MCP 엔드포인트인지 확인해 주세요.",
                                  code=e.code)) from None
        raise RuntimeError(f"HTTP {e.code}: {body[:160]}") from None
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"연결 실패: {getattr(e, 'reason', e)}") from None
    if notify:
        return None, sid
    if not raw.lstrip().startswith("{"):
        data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        raw = data[-1] if data else raw
    resp = json.loads(raw)
    if resp.get("error"):
        raise RuntimeError(resp["error"].get("message") or str(resp["error"]))
    return resp.get("result") or {}, sid


def _left(deadline):
    left = deadline - time.monotonic()
    if left <= .5:
        raise RuntimeError(tr("시간 안에 응답하지 않았어요"))
    return min(TIMEOUT_SEC, left)


def _open(url, headers, deadline):
    """initialize + notifications/initialized → the session id (None for stateless servers)."""
    _, sid = _rpc(url, "initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                       "clientInfo": {"name": "ipverse-studio", "version": "1"}}, headers, timeout=_left(deadline))
    try:
        _rpc(url, "notifications/initialized", None, headers, sid, notify=True, timeout=_left(deadline))
    except RuntimeError:
        pass  # some stateless servers answer notifications with 4xx
    return sid


def list_tools(url, headers, budget=ADD_BUDGET_SEC) -> list:
    deadline = time.monotonic() + budget
    sid = _open(url, headers, deadline)
    result, _ = _rpc(url, "tools/list", {}, headers, sid, timeout=_left(deadline))
    return result.get("tools") or []


def call_tool(url, headers, name, arguments, deadline=None) -> dict:
    deadline = deadline or time.monotonic() + CALL_TIMEOUT_SEC
    sid = _open(url, headers, deadline)
    timeout = min(CALL_TIMEOUT_SEC, deadline - time.monotonic())
    if timeout <= 1:
        raise RuntimeError("남은 대화 시간이 부족해 도구를 부르지 못했어요")
    result, _ = _rpc(url, "tools/call", {"name": name, "arguments": arguments}, headers, sid, timeout=timeout)
    text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type", "text") == "text")
    if result.get("isError"):
        return {"error": "mcp_tool_error", "message": text[:1000] or "도구 오류"}
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    return {"result": text[:20000]}


def _safe_url(url: str) -> str:
    """https only, and not into private address space (the Lambda fetches it). The refusals name the field as the
    연결 설정 form does (MCP 서버 주소)."""
    if not isinstance(url, str) or len(url) > 500:
        raise ConnError(400, "bad_request", "MCP 서버 주소를 입력해 주세요.")
    u = urllib.parse.urlparse(url.strip())
    if u.scheme != "https" or not u.hostname:
        raise ConnError(400, "bad_request", "MCP 서버 주소는 https://로 시작해야 해요.")
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(u.hostname, u.port or 443)}
    except OSError:
        raise ConnError(400, "bad_request", f"{u.hostname} 주소를 찾지 못했어요. 주소를 다시 확인해 주세요.") from None
    for a in addrs:
        ip = ipaddress.ip_address(a)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ConnError(400, "bad_request", "내부 주소로는 연결할 수 없어요. 밖에서 열리는 주소를 넣어 주세요.")
    return url.strip()


def _summary(tools: list) -> dict:
    cached = [{"name": t.get("name", ""), "description": (t.get("description") or "")[:400],
               "inputSchema": t.get("inputSchema") if isinstance(t.get("inputSchema"), dict) else {"type": "object", "properties": {}}}
              for t in tools[:MAX_AGENT_TOOLS]]
    return {"toolCount": len(tools), "tools": [t["name"] for t in cached], "toolDefs": cached}


IMAGE_KINDS = {"krea": ["t2i"], "klein9": ["t2i", "i2i"]}  # klein9 is the one that takes reference images


def _promoted_images(ctx) -> list:
    """Image models the open-model scout promoted: the videogen MCP's list_image_models (one GPU box each, found by
    its EC2 tags), or IPverse's own registry of them while that cannot be read."""
    try:
        listed = mcp_client.call_tool(ctx, mcp_client.VIDEO, "list_image_models", {})
        return [{"id": m["tag"], "label": m.get("label") or m["tag"], "kinds": list(m.get("kinds") or ["t2i"]),
                 "promoted": True, "hfRepo": m.get("hfRepo", "")}
                for m in listed.get("models") or [] if isinstance(m, dict) and m.get("tag")]
    except Exception:  # noqa: BLE001 — the registry knows what was promoted, just not the box's state
        traceback.print_exc()
        from server import agents
        try:
            return agents.promoted_image_models(ctx)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return []


def image_catalog(ctx) -> dict:
    """{models: [{id, label, kinds, promoted?}], live}: the image models the image MCP lists now (list_models) and the
    promoted ones (videogen list_image_models), cached like the video catalog; the last good list, or the defaults,
    while it cannot be read. Stable Image Ultra is not on it (Bedrock)."""
    now = time.time()
    if _image_catalog and now < _image_catalog["until"]:
        return _image_catalog
    pool = ThreadPoolExecutor(max_workers=2)
    deadline = time.monotonic() + IMAGE_CATALOG_WAIT_SEC
    promoted_future = pool.submit(_promoted_images, ctx)
    try:
        listed = pool.submit(mcp_client.call_tool, ctx, mcp_client.IMAGE, "list_models", {}).result(
            timeout=IMAGE_CATALOG_WAIT_SEC)
        models = [{"id": m["id"], "label": m.get("label") or m["id"], "kinds": IMAGE_KINDS.get(m["id"], ["t2i"])}
                  for m in listed.get("models") or [] if isinstance(m, dict) and m.get("id")]
        if not models:
            raise RuntimeError("이미지 MCP가 모델 목록을 비워 보냈습니다")
        live = True
    except Exception:  # noqa: BLE001 — a down or slow MCP must not break the chat: keep what was known
        traceback.print_exc()
        models = [m for m in _image_catalog.get("models") or [] if not m.get("promoted")] or \
            [{**m, "kinds": IMAGE_KINDS.get(m["id"], ["t2i"])} for m in DEFAULT_IMAGE_MODELS]
        live = False
    try:
        promoted = promoted_future.result(timeout=max(0.1, deadline - time.monotonic()))
    except Exception:  # noqa: BLE001 — slow: the promoted rows known before stay
        traceback.print_exc()
        promoted = [m for m in _image_catalog.get("models") or [] if m.get("promoted")]
    finally:
        pool.shutdown(wait=False)
    known = {m["id"] for m in models}
    fresh = {"models": models + [m for m in promoted if m["id"] not in known], "live": live,
             "until": now + (mediagen_video.CATALOG_TTL_SEC if live else mediagen_video.CATALOG_RETRY_SEC)}
    _image_catalog.clear()
    _image_catalog.update(fresh)
    return _image_catalog


def image_kinds(ctx, model: str) -> list:
    """What an image model does: t2i, and i2i when it edits from reference images."""
    return next((m.get("kinds") or ["t2i"] for m in image_catalog(ctx)["models"] if m["id"] == model),
                IMAGE_KINDS.get(model, []))


def _check_platform(ctx, c):
    if c["kind"] != "mcp":
        return {**c, "status": "connected" if c.pop("configured", True) else "off"}
    try:
        key = mcp_client._api_key(ctx, c["keyParam"])
        list_tools(c["endpoint"], {"x-api-key": f"Key {key}"})  # the check itself: its tools are not the user's to see
        out = {**c, "status": "connected"}
    except Exception:  # noqa: BLE001 — shown as "연결 실패"; the reason names the address, so it stays in the log
        traceback.print_exc()
        return {**c, "status": "error", "error": NO_ANSWER}
    # the models each MCP lists now (list_video_models, list_models): the model dropdowns' options
    cat = mediagen_video.catalog(ctx) if c["id"] == "videogen" else image_catalog(ctx) if c["id"] == "imagegen" else None
    if cat and cat["live"]:
        out["models"] = cat["models"] if c["id"] == "videogen" else [  # promoted rows also say what they do
            {"id": m["id"], "label": m["label"], **({k: m[k] for k in ("kinds", "promoted", "hfRepo") if k in m}
                                                    if m.get("promoted") else {})} for m in cat["models"]]
    return out


def _pk(sub):
    return f"CONN#{sub}"


def _user_servers(ctx, sub) -> list:
    return [store._strip(i) for i in store._query(ctx, _pk(sub))]


def _public(s):
    return {k: v for k, v in s.items() if k not in ("authValue", "toolDefs")} | {"hasAuth": bool(s.get("authValue"))}


def _headers(s):
    return {s.get("authHeader") or "authorization": s["authValue"]} if s.get("authValue") else {}


def listing(ctx, user, live: bool = True) -> dict:
    platform = _platform()
    with ThreadPoolExecutor(max_workers=4) as pool:
        platform = list(pool.map(lambda c: _check_platform(ctx, c) if live else {**c, "status": "unknown"}, platform))
    def shown(c):  # in the page's language, here: the checks above ran on the pool's threads
        row = {k: c[k] for k in SHOWN if c.get(k) is not None}  # and nothing else
        row["name"] = i18n.data(row["name"])
        if row.get("error") == NO_ANSWER:
            row["error"] = tr(NO_ANSWER)
        return row

    return {"platform": [shown(c) for c in platform],
            "servers": [_public(s) for s in _user_servers(ctx, user["sub"])]}


def add(ctx, user, body) -> dict:
    name = (body.get("name") or "").strip() if isinstance(body.get("name"), str) else ""
    if not 1 <= len(name) <= 40:
        raise ConnError(400, "bad_request", "이름은 1–40자로 입력해 주세요")
    url = _safe_url(body.get("url"))
    header = body.get("authHeader") or "authorization"
    value = body.get("authValue") or ""
    if not isinstance(header, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,40}", header) or not isinstance(value, str) or len(value) > 2000:
        raise ConnError(400, "bad_request", "인증 헤더 이름이나 인증 값이 올바르지 않아요. 다시 확인해 주세요.")
    if len(_user_servers(ctx, user["sub"])) >= MAX_USER_SERVERS:
        raise ConnError(400, "too_many", f"MCP 서버는 {MAX_USER_SERVERS}개까지 연결할 수 있어요")
    server = {"id": store.new_id("mcp"), "name": name, "url": url, "authHeader": header.lower(), "authValue": value,
              "enabled": True, "createdAt": store.now()}
    try:
        tools = list_tools(url, _headers(server))
    except Exception as e:  # noqa: BLE001
        # The toast keeps _rpc's own sentences; a server's body, an OS error or a parser's words stay in the log
        reason = str(e)
        print(f"mcp connect failed: {reason[:200]}")
        # _rpc's own sentences are known by their endings, Korean or English
        own = reason.endswith(("주세요.", "않았어요", "and try again.", "MCP endpoint.", "in time"))
        told = reason if own else tr("주소와 인증 값을 확인한 뒤 다시 해 주세요.")
        raise ConnError(400, "connect_failed", f"MCP 서버에 연결하지 못했어요. {told}") from None
    server.update(status="connected", checkedAt=store.now(), **_summary(tools))
    store._put(ctx, _pk(user["sub"]), f"MCP#{server['id']}", server)
    return _public(server)


def _get(ctx, user, sid):
    s = store._get(ctx, _pk(user["sub"]), f"MCP#{sid}")
    if not s:
        raise ConnError(404, "not_found", "연결을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
    return s


def update(ctx, user, sid, body) -> dict:
    """{enabled: bool} toggles agent use; {refresh: true} re-reads the tool list."""
    s = _get(ctx, user, sid)
    if isinstance(body.get("enabled"), bool):
        s["enabled"] = body["enabled"]
    if body.get("refresh"):
        try:
            s.update(status="connected", error=None, **_summary(list_tools(s["url"], _headers(s))))
        except Exception as e:  # noqa: BLE001
            s.update(status="error", error=str(e)[:200])
        s["checkedAt"] = store.now()
    store._put(ctx, _pk(user["sub"]), f"MCP#{sid}", s)
    return _public(s)


def remove(ctx, user, sid) -> dict:
    _get(ctx, user, sid)
    ctx.table.delete_item(Key={"pk": _pk(user["sub"]), "sk": f"MCP#{sid}"})
    return {"deleted": sid}


# ── agent tools ──

def _tool_name(server_id, tool):
    return re.sub(r"[^A-Za-z0-9_-]", "_", f"mcp_{server_id[-6:]}_{tool}")[:64]


def agent_tools(ctx, sub) -> tuple:
    """(toolSpecs for Converse, {toolName: (server, mcpToolName)}) from the user's enabled servers. A server that
    does not answer is skipped for this turn."""
    specs, routes = [], {}
    servers = [s for s in _user_servers(ctx, sub) if s.get("enabled")]

    def listed(s):
        if s.get("toolDefs"):  # read at add/refresh: no handshake on every chat turn
            return s["toolDefs"]
        try:
            return list_tools(s["url"], _headers(s), budget=TURN_LIST_BUDGET_SEC)
        except Exception:  # noqa: BLE001
            return []
    with ThreadPoolExecutor(max_workers=max(1, len(servers))) as pool:  # all at once: one slow server costs 10 s, not n x 60
        found = list(pool.map(listed, servers))
    for s, tools in zip(servers, found):
        for t in tools:
            if len(specs) >= MAX_AGENT_TOOLS:
                break
            name = _tool_name(s["id"], t.get("name", ""))
            schema = t.get("inputSchema") if isinstance(t.get("inputSchema"), dict) else {"type": "object", "properties": {}}
            specs.append({"name": name, "description": f"[MCP · {s['name']}] {(t.get('description') or t.get('name', ''))[:400]}",
                          "inputSchema": {"json": schema}})
            routes[name] = (s, t["name"])
    return specs, routes


def run_agent_tool(route, args, deadline=None) -> dict:
    server, tool = route
    try:
        return call_tool(server["url"], _headers(server), tool, args, deadline)
    except Exception as e:  # noqa: BLE001
        return {"error": "mcp_failed", "message": str(e)[:300]}
