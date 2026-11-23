"""Per-viewer trailer ads on the one gameplay channel: personas, playback tokens and the per-persona VAST files.

The IVS channel is private (a public one would accept a forged token): a viewer plays its URL with ?token=<JWT>,
signed with ES384 by the private key in Secrets Manager (scripts/setup_ivs_playback_key.py). The token's
aws:ads-player-params {"persona": id} reaches MediaTailor, whose ADS URL (scripts/setup_ivs_ads.py) is
https://<live CDN>/vast/ivs/p-[player_params.persona].xml: each persona reads its own file at every break, and a
viewer without a persona reads p-.xml, the default ad.

The viewers are the dummy viewers of server/viewers.py (their id is the persona value); at a trailer break each gets
the campaign server/adserver.py decides from its activity log. The seeded personas (DynamoDB pk PERSONAS) stay valid
token values (viewers.PERSONA_VIEWER). The VAST's <Impression> is our beacon (/api/ads/impression), logged per break,
file and creative; on a viewer's real break it joins that viewer's activity log.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
import re
import secrets
import time
import urllib.parse
from xml.sax.saxutils import escape

from server import store
from server import i18n
from server.i18n import said

SECRET_ID = os.environ.get("IVS_PLAYBACK_KEY_SECRET", "ipverse/ivs-playback-key")
TOKEN_TTL_SEC = 20 * 60  # IVS checks the token when playback starts (also each reload), not during the stream
TOKEN_REUSE_SEC = 10 * 60  # a cached token is handed out while at least this much of it is left
PERSONA_CACHE_SEC = 60
PERSONA_ID = re.compile(r"[a-z0-9-]{1,24}")
IMPRESSION_ARG = re.compile(r"[A-Za-z0-9_-]{1,40}")

SEED_PERSONAS = [
    {"personaId": "action", "name": "액션 마니아", "genre": "ARPG · 보스전",
     "profile": "보스 레이드와 콤보 전투를 즐겨요. 화려한 전투 장면이 있는 트레일러에 반응해요.",
     "affinity": ["arpg", "rpg", "boss", "보스", "action", "액션", "battle", "전투", "fight", "combat", "sword", "검",
                  "knight", "기사", "raid", "레이드", "dragon", "드래곤"]},
    {"personaId": "racer", "name": "레이서", "genre": "레이싱",
     "profile": "속도감과 드리프트를 좋아해요. 차량과 추격 장면이 나오는 트레일러를 먼저 봐요.",
     "affinity": ["racing", "race", "레이싱", "레이스", "racer", "레이서", "car", "차량", "자동차", "drift", "드리프트",
                  "speed", "속도", "chase", "추격", "vehicle", "bike", "오토바이"]},
    {"personaId": "explorer", "name": "도시 탐험가", "genre": "오픈월드 · 도시",
     "profile": "넓은 도시를 걸으며 숨은 장소를 찾아요. 풍경과 탐험이 있는 트레일러에 끌려요.",
     "affinity": ["open world", "open-world", "오픈월드", "city", "도시", "explore", "exploration", "탐험", "street",
                  "거리", "skyline", "town", "마을", "landscape", "풍경", "rooftop", "옥상"]},
]


class AdsError(Exception):
    def __init__(self, status: int, code: str, message: str):
        message = said(message)  # in the request's language: the sentence is written where it is raised
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


_cache: dict = {}  # per container: the private key, signed tokens, the persona list


# ── ES384 (ECDSA P-384 + SHA-384) without third-party packages: the Lambda bundle has no `cryptography` ────────

_P = 2**384 - 2**128 - 2**96 + 2**32 - 1
_N = 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973
_G = (0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7,
      0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f)


def _double(pt):
    """Jacobian doubling for a = -3."""
    if pt is None:
        return None
    x, y, z = pt
    if y == 0:
        return None
    delta, gamma = z * z % _P, y * y % _P
    beta, alpha = x * gamma % _P, 3 * (x - delta) * (x + delta) % _P
    x3 = (alpha * alpha - 8 * beta) % _P
    z3 = ((y + z) ** 2 - gamma - delta) % _P
    y3 = (alpha * (4 * beta - x3) - 8 * gamma * gamma) % _P
    return x3, y3, z3


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    z1z1, z2z2 = z1 * z1 % _P, z2 * z2 % _P
    u1, u2 = x1 * z2z2 % _P, x2 * z1z1 % _P
    s1, s2 = y1 * z2 * z2z2 % _P, y2 * z1 * z1z1 % _P
    h, r = (u2 - u1) % _P, 2 * (s2 - s1) % _P
    if h == 0:
        return _double(p1) if r == 0 else None
    i = 4 * h * h % _P
    j, v = h * i % _P, u1 * i % _P
    x3 = (r * r - j - 2 * v) % _P
    y3 = (r * (v - x3) - 2 * s1 * j) % _P
    z3 = ((z1 + z2) ** 2 - z1z1 - z2z2) * h % _P
    return x3, y3, z3


def _mul_g(k: int) -> int:
    """x of k·G (affine)."""
    acc, pt = None, (_G[0], _G[1], 1)
    while k:
        if k & 1:
            acc = _add(acc, pt)
        pt, k = _double(pt), k >> 1
    x, _, z = acc
    return x * pow(z * z, -1, _P) % _P


def sign_es384(d: int, message: bytes) -> bytes:
    """The JWS ES384 signature (r || s, 48 bytes each) of message with private scalar d; k fresh per signature."""
    e = int.from_bytes(hashlib.sha384(message).digest(), "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1
        r = _mul_g(k) % _N
        s = pow(k, -1, _N) * (e + r * d) % _N
        if r and s:
            return r.to_bytes(48, "big") + s.to_bytes(48, "big")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


# ── playback tokens ───────────────────────────────────────────────────────────

def _sm(ctx):
    """Secrets Manager: the injected one, else a real client only when the context's own clients are real (unit tests
    with fakes never reach AWS)."""
    injected = getattr(ctx, "secretsmanager", None)
    if injected is not None:
        return injected
    from botocore.client import BaseClient
    if not isinstance(getattr(ctx, "ivs", None), BaseClient):
        return None
    if "sm" not in _cache:
        import boto3
        _cache["sm"] = boto3.client("secretsmanager", region_name="us-east-1")
    return _cache["sm"]


def _private_key(ctx) -> int:
    if "key" not in _cache:
        client = _sm(ctx)
        try:
            if client is None:
                raise LookupError("no Secrets Manager client")
            doc = json.loads(client.get_secret_value(SecretId=SECRET_ID)["SecretString"])
            _cache["key"] = int(doc["d"], 16)
        except Exception as e:  # noqa: BLE001 — never log the secret, only that it is not there
            print(f"playback key unavailable ({SECRET_ID}): {type(e).__name__}; run scripts/setup_ivs_playback_key.py")
            raise AdsError(503, "playback_key_missing",
                           "방송을 볼 준비가 아직 끝나지 않았어요. 관리자에게 문의해 주세요.") from None
    return _cache["key"]


def _origin(ctx) -> str:
    return f"https://{ctx.cdn_domain}" if ctx.cdn_domain else "*"


def token(ctx, channel_arn: str, persona: str, params: dict | None = None, config_name: str | None = None) -> tuple:
    """(JWT, exp) for the channel; persona "" sends no ad params, so MediaTailor asks for p-.xml. params: the ad
    params instead of {"persona": persona} (a GAM viewer's key-values); config_name: the MediaTailor configuration
    this viewer's ads come from (aws:ads-playback-config-name; none = the ad configuration's default, ipverse-ivs).
    Reused while it has TOKEN_REUSE_SEC left."""
    now = int(time.time())
    key = ("token", channel_arn, persona, json.dumps(params, sort_keys=True), config_name)
    hit = _cache.get(key)
    if hit and hit[1] - now >= TOKEN_REUSE_SEC:
        return hit
    claims = {"aws:channel-arn": channel_arn, "aws:access-control-allow-origin": _origin(ctx), "exp": now + TOKEN_TTL_SEC}
    if persona:
        claims["aws:ads-player-params"] = params or {"persona": persona}
    if config_name:
        claims["aws:ads-playback-config-name"] = config_name
    head = _b64(json.dumps({"alg": "ES384", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(claims, separators=(",", ":")).encode())
    signed = f"{head}.{body}"
    out = (f"{signed}.{_b64(sign_es384(_private_key(ctx), signed.encode()))}", claims["exp"])
    _cache[key] = out
    return out


def playback_url(ctx, chan: dict, persona: str = "") -> str:
    """The channel's URL with a token (the owner's windows get the default persona with every status); the bare
    URL if there is no key yet (a private channel then refuses it: 403)."""
    try:
        return f"{chan['playbackUrl']}?token={token(ctx, chan['arn'], persona)[0]}"
    except AdsError:
        return chan["playbackUrl"]


def playback(ctx, persona: str) -> dict:
    """POST /api/live/token: a playback URL for this viewer or persona ("" = 기본, the default ad). A viewer the GAM
    provider serves gets the GAM configuration and its key-values in the token (server/gam.py)."""
    from server import adserver, gam, viewers
    persona = persona if isinstance(persona, str) else ""
    names = {p["personaId"]: p["name"] for p in personas(ctx)}
    names.update({v["viewerId"]: v["name"] for v in viewers.ensure(ctx)})
    if persona and persona not in names:
        raise AdsError(400, "bad_request", "없는 시청자예요")
    from server import live
    try:
        chan = live._channel(ctx)
    except live.LiveError as e:
        raise AdsError(e.status, e.code, e.message) from None
    params = config_name = None
    provider = adserver.provider(persona) if persona in viewers.VIEWER_IDS else "ipverse"
    if provider == "gam":
        viewer = next(v for v in viewers.ensure(ctx) if v["viewerId"] == persona)
        params = gam.player_params(persona, adserver.features(viewer, viewers.log(ctx, persona), time.time()))
        config_name = gam.config()["playbackConfig"]
    tok, exp = token(ctx, chan["arn"], persona, params, config_name)
    return {"playbackUrl": f"{chan['playbackUrl']}?token={tok}", "expiresAt": exp, "persona": persona,
            "personaName": i18n.data(names.get(persona, "기본")), "provider": provider}


# ── personas ──────────────────────────────────────────────────────────────────

def personas(ctx) -> list:
    """The viewer personas (seeded with three on first read), cached a minute per container."""
    hit = _cache.get("personas")
    if hit and hit[0] is ctx.table and time.time() - hit[1] < PERSONA_CACHE_SEC:
        return hit[2]
    items = [store._strip(i) for i in store._query(ctx, "PERSONAS")]
    if not items:
        for p in SEED_PERSONAS:
            store._put(ctx, "PERSONAS", f"PERSONA#{p['personaId']}", {**p, "createdAt": store.now()})
        items = [dict(p) for p in SEED_PERSONAS]
    order = {p["personaId"]: i for i, p in enumerate(SEED_PERSONAS)}
    items.sort(key=lambda p: (order.get(p["personaId"], len(order)), p["personaId"]))
    _cache["personas"] = (ctx.table, time.time(), items)
    return items


def persona_ids(ctx) -> list:
    """Every VAST file a break writes: each dummy viewer's, each old persona's and "" (no persona)."""
    from server import viewers
    return list(dict.fromkeys([*viewers.VIEWER_IDS, *(p["personaId"] for p in personas(ctx)), ""]))


# ── trailers and the plan ─────────────────────────────────────────────────────

def creative_id(url: str) -> str:
    """Stable per media file: MediaTailor warms (transcodes) per configuration and creative id."""
    return "cr_" + hashlib.sha1(url.encode()).hexdigest()[:12]


def pick(url: str, title: str, seconds: float) -> dict:
    return {"url": url, "title": title, "seconds": float(seconds), "creative": creative_id(url)}


def trailers(ctx, snap: dict) -> list:
    """The session's trailer videos with the text their affinity is matched on, oldest first."""
    jobs = {j["jobId"]: j for j in snap.get("jobs", [])}
    out = []
    for a in snap.get("assets", []):
        if a.get("kind") != "trailer" or not str(a.get("contentType", "")).startswith("video/"):
            continue
        inp = (jobs.get(a.get("jobId")) or {}).get("input") or {}
        shots = [(jobs.get(s) or {}).get("input", {}).get("prompt", "") for s in inp.get("shot_job_ids") or []]
        words = [inp.get("title"), inp.get("subtitle"), *(inp.get("intertitles") or {}).values(), *shots]
        title = inp.get("title") or (snap.get("session") or {}).get("title") or "트레일러"
        out.append({**pick(store.public_url(ctx, a["key"]), title, (a.get("meta") or {}).get("seconds") or 15),
                    "text": " ".join(w for w in words if isinstance(w, str)).lower(), "createdAt": a.get("createdAt", ""),
                    "jobId": a.get("jobId")})
    return out


# ── VAST ──────────────────────────────────────────────────────────────────────

def vast_key(persona: str) -> str:
    return f"vast/ivs/p-{persona}.xml"


def beacon(ctx, break_id: str, persona: str, creative: str) -> str | None:
    """Our impression URL (MediaTailor fires it server-side); None without a CDN domain: the tag is left out (an
    empty one logs beacon failures)."""
    if not ctx.cdn_domain:
        return None
    q = urllib.parse.urlencode({"b": break_id, "p": persona, "c": creative})
    return f"https://{ctx.cdn_domain}/api/ads/impression?{q}"


def vast(title: str, video_url: str, seconds: float, creative: str | None = None, impression: str | None = None) -> str:
    """VAST 3.0 with one linear MP4 creative; MediaTailor transcodes it to the stream's renditions."""
    creative = creative or creative_id(video_url)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    duration = f"{int(h):02d}:{int(m):02d}:{s:06.3f}"
    imp = f"<Impression><![CDATA[{impression}]]></Impression>" if impression else ""
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<VAST version="3.0"><Ad id="{escape(creative)}"><InLine><AdSystem>IPverse</AdSystem>'
            f'<AdTitle>{escape(title)}</AdTitle>{imp}<Creatives><Creative id="{escape(creative)}"><Linear>'
            f"<Duration>{duration}</Duration><MediaFiles>"
            '<MediaFile delivery="progressive" type="video/mp4" width="1280" height="720" bitrate="2500">'
            f"<![CDATA[{video_url}]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>")


# ── logs: impressions and gameplay events ─────────────────────────────────────

def impression(ctx, query: dict) -> dict:
    """GET /api/ads/impression?b=<break>&p=<persona>&c=<creative> (public: MediaTailor calls it).
    ponytail: one item per beacon, no rate limit; a demo's few viewers fire a handful per break."""
    b, p, c = (query or {}).get("b", ""), (query or {}).get("p", ""), (query or {}).get("c", "")
    if not IMPRESSION_ARG.fullmatch(b) or not IMPRESSION_ARG.fullmatch(c) or (p and not PERSONA_ID.fullmatch(p)):
        raise AdsError(400, "bad_request", "광고 노출 기록을 읽지 못했어요.")
    at = store.now()
    item = {"type": "impression", "breakId": b, "persona": p, "creative": c, "at": at}
    store._put(ctx, f"ADBREAK#{b}", f"IMP#{p}#{c}#{at}#{secrets.token_hex(3)}", item)
    print(json.dumps({"adImpression": item}))
    try:  # a viewer's real break (not a warm-up): the impression, and its simulated click or skip, join its log
        _viewer_impression(ctx, b, p, c)
    except Exception as e:  # noqa: BLE001 — the beacon always answers
        print(f"viewer impression failed: {type(e).__name__}: {e}")
    return {"ok": True}


def _viewer_impression(ctx, break_id: str, file_id: str, creative: str):
    from server import adserver, viewers
    vid = viewers.resolve(file_id)
    if not vid or not break_id.startswith("b_"):
        return
    served = store._get(ctx, f"ADBREAK#{break_id}", f"SERVED#{vid}")
    if not served or served.get("creative") != creative:
        return
    now = time.time()
    viewers.impression(ctx, vid, break_id, served, adserver.share(viewers.log(ctx, vid, now), served.get("genre", ""), now),
                       now)


def log_round(ctx, session_id: str, job_id: str, body: dict):
    """A finished round as the play window reported it, on the session's record. One item per round of a broadcast:
    a repeated report overwrites it."""
    rounds = body.get("rounds")
    item = {"type": "round_end", "jobId": job_id, "rounds": rounds, "at": store.now()}
    if isinstance(body.get("reason"), str) and body["reason"].strip():
        item["reason"] = body["reason"].strip()[:40]
    if isinstance(body.get("won"), bool):
        item["won"] = body["won"]
    store._put(ctx, store._pk(session_id), f"EVENT#{job_id}#round#{rounds:05d}", item)
