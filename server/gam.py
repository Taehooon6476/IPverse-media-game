"""Google Ad Manager as the ad decision server (built, not connected). Off unless GAM_NETWORK_CODE and GAM_AD_UNIT
are set, or GAM_SSM_PARAM names an SSM parameter with {"networkCode", "adUnit", "playbackConfig"}. See
docs/gam-setup.md.

A viewer's playback token names the second MediaTailor configuration (GAM_PLAYBACK_CONFIG), whose ADS URL is
ads_url_template(): a GAM VAST tag with MediaTailor variables. The viewer's key-values ride in aws:ads-player-params
(player_params()), one plain [a-z0-9-] value per key, so no value needs encoding. MediaTailor URL-decodes a player
parameter once before substituting it, so a whole cust_params string in ONE parameter must be encoded twice.
"""
from __future__ import annotations
import json
import os
import urllib.parse

GAM_HOST = "https://pubads.g.doubleclick.net/gampad/ads"
KEYS = ("g1", "g2", "skill", "dev", "age")  # the key-values (GAM: Inventory > Key-values, predefined)
_cache: dict = {}


def config() -> dict | None:
    """{networkCode, adUnit, playbackConfig, sizes} or None (GAM off)."""
    net, unit = os.environ.get("GAM_NETWORK_CODE", ""), os.environ.get("GAM_AD_UNIT", "")
    param = os.environ.get("GAM_SSM_PARAM", "")
    if not (net and unit) and param:
        if param not in _cache:
            try:
                import boto3
                _cache[param] = json.loads(boto3.client("ssm").get_parameter(Name=param)["Parameter"]["Value"])
            except Exception as e:  # noqa: BLE001 — GAM stays off
                print(f"GAM config {param} unreadable: {type(e).__name__}")
                _cache[param] = {}
        doc = _cache[param]
        net, unit = str(doc.get("networkCode", "")), doc.get("adUnit", "")
        if doc.get("playbackConfig"):
            os.environ.setdefault("GAM_PLAYBACK_CONFIG", doc["playbackConfig"])
    if not (net and unit):
        return None
    return {"networkCode": net, "adUnit": unit.strip("/"),
            "playbackConfig": os.environ.get("GAM_PLAYBACK_CONFIG", "ipverse-ivs-gam"),
            "sizes": os.environ.get("GAM_SIZES", "1280x720|640x360")}


def _iu(cfg: dict) -> str:
    return f"/{cfg['networkCode']}/{cfg['adUnit']}"


def _safe(v) -> str:
    """A key-value as GAM and MediaTailor take it without encoding: lower-case [a-z0-9-], at most 40."""
    out = "".join(ch if ch.isascii() and (ch.isalnum() or ch == "-") else "-" for ch in str(v).lower())
    return out.strip("-")[:40] or "none"


def player_params(viewer_id: str, feats: dict) -> dict:
    """The token's aws:ads-player-params for a GAM viewer (1000 bytes at most; this is ~100): persona (the
    ipverse VAST file stays reachable), ppid (a pseudonymous id: GAM keeps returning ads after the first break with
    it) and the key-values."""
    return {"persona": viewer_id, "ppid": _safe(viewer_id), **{k: _safe(feats.get(k, "none")) for k in KEYS}}


def _query(cfg: dict, cust: str, ppid: str, correlator: str, pmxd: str) -> str:
    q = [("iu", _iu(cfg)), ("sz", cfg["sizes"]), ("gdfp_req", "1"), ("output", "vast"), ("env", "vp"),
         ("unviewed_position_start", "1"), ("vpos", "midroll"), ("pmad", "-1"), ("pmxd", pmxd),
         ("correlator", correlator), ("ppid", ppid), ("cust_params", cust)]
    return "&".join(f"{k}={v}" for k, v in q)


def ads_url_template(cfg: dict) -> str:
    """The second MediaTailor configuration's ADS URL. MediaTailor fills the [..] variables per viewer and break:
    correlator=[avail.random] (each break a fresh request), pmxd=[session.avail_duration_ms] (the break's length,
    never hard-coded), vpos=midroll (not [avail.type]: unsupported, it resolves empty)."""
    cust = "%26".join(f"{k}%3D[player_params.{k}]" for k in KEYS)
    return f"{GAM_HOST}?" + _query({**cfg, "sizes": urllib.parse.quote(cfg["sizes"], safe="x")}, cust,
                                   "[player_params.ppid]", "[avail.random]", "[session.avail_duration_ms]")


def tag_url(cfg: dict, viewer_id: str, feats: dict, correlator: int, avail_ms: int) -> str:
    """The request GAM gets for this viewer and break, as MediaTailor builds it from the template (for the docs,
    the watch page's debug line and the tests)."""
    p = player_params(viewer_id, feats)
    return f"{GAM_HOST}?" + _query({**cfg, "sizes": urllib.parse.quote(cfg["sizes"], safe="x")},
                                   urllib.parse.quote(cust_string(p), safe=""), p["ppid"], str(correlator), str(avail_ms))


def cust_string(p: dict) -> str:
    return "&".join(f"{k}={p[k]}" for k in KEYS)


def cust_param_value(viewer_id: str, feats: dict, encode: int = 2) -> str:
    """The whole cust_params as ONE player parameter (template ...&cust_params=[player_params.cust]): GAM needs it
    URL-encoded once in its request, MediaTailor decodes a player parameter once, so the token carries it encoded
    twice."""
    out = cust_string(player_params(viewer_id, feats))
    for _ in range(encode):
        out = urllib.parse.quote(out, safe="")
    return out
