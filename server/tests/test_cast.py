"""출연 IP (cast): only the IPs the user picked appear in the game, and all of them."""
import json

from server import store, tools
from server.gamespec import cast_errors
from server.tests.conftest import FakeS3, FakeTable, make_ctx

IPS = {i: {"name": n} for i, n in (("ip_teo", "테오"), ("ip_gun", "권총"), ("ip_drone", "드론"), ("ip_mech", "병사"))}
CAST = ["ip_teo", "ip_gun", "ip_drone"]
OK = {"player": {"ipId": "ip_teo", "weaponIpId": "ip_gun"}, "enemies": [{"ipId": "ip_drone"}], "props": []}


def test_cast_errors_only_the_picked_ips_and_all_of_them():
    assert cast_errors(OK, CAST, IPS) == []
    extra = {**OK, "enemies": [{"ipId": "ip_drone"}, {"ipId": "ip_mech"}]}  # an IP the user did not pick
    assert any("enemies[1]" in e for e in cast_errors(extra, CAST, IPS))
    stand_in = {**OK, "enemies": [{"ipId": "ip_drone"}, {"hp": 1}]}  # a procedural enemy
    assert any("없음" in e for e in cast_errors(stand_in, CAST, IPS))
    missing = {**OK, "player": {"ipId": "ip_teo"}}  # the picked gun is not used
    assert any("권총" in e for e in cast_errors(missing, CAST, IPS))
    assert cast_errors(OK, ["ip_nope"], IPS)  # unknown ipId


def _game_session():
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = store.put_session(ctx, "sub-1", "t", "sf-shooter")
    sid = session["sessionId"]
    store.put_asset(ctx, sid, {"assetId": "c", "kind": "cutout", "key": "k.png", "contentType": "image/png"})
    store.put_asset(ctx, sid, {"assetId": "g", "kind": "glb", "key": "teo.glb", "contentType": "model/gltf-binary"})
    for ip_id, kind in (("ip_teo", "character"), ("ip_mech", "enemy"), ("ip_drone", "enemy")):
        store.put_ip(ctx, sid, {"ipId": ip_id, "kind": kind, "name": ip_id, "description": "", "imageAssetId": "a",
                                "cutoutAssetId": "c", **({"glbAssetId": "g"} if ip_id == "ip_teo" else {})})
    spec = {"version": 1, "title": "G", "genre": "sf-shooter", "palette": {"bg": "#000000", "accent": "#00e5ff", "text": "#ffffff"},
            "player": {"ipId": "ip_teo", "speed": 2}, "enemies": [{"ipId": "ip_drone", "name": "드론", "hp": 1, "speed": 2, "color": "#ff4fa3", "shape": "circle"}],
            "props": [], "objective": {"type": "kills", "target": 10}, "difficulty": "normal"}
    return ctx, session, spec


def test_make_game_rejects_a_spec_outside_the_cast_and_records_the_cast():
    ctx, session, spec = _game_session()
    sid = session["sessionId"]
    bad = tools.make_game(ctx, session, {"spec": spec, "cast_ip_ids": ["ip_teo", "ip_mech"]})
    assert bad.get("error") == "cast_mismatch", bad
    assert any("ip_drone" in e for e in bad["errors"]) and any("ip_mech" in e for e in bad["errors"])
    out = tools.make_game(ctx, session, {"spec": spec, "cast_ip_ids": ["ip_teo", "ip_drone"]})
    assert "error" not in out, out
    game = next(g for g in store.snapshot(ctx, sid)["games"] if g["gameId"] == out["gameId"])
    assert game["castIpIds"] == ["ip_teo", "ip_drone"]
    ctx.s3._store[(ctx.assets_bucket, game["specKey"])] = json.dumps(spec).encode()
    assert tools.get_game_spec(ctx, session, {"gameId": out["gameId"]})["castIpIds"] == ["ip_teo", "ip_drone"]


def test_a_malformed_cast_id_is_bad_args_and_never_fails_the_agent_turn():
    """cast_ip_ids is model-sent JSON: an object or a list inside it must come back as bad_args, not raise out of
    run_tool (which fails the whole turn)."""
    ctx, session, spec = _game_session()
    for cast in ([{"ipId": "ip_teo"}], [["ip_teo"]], ["ip_teo", None]):
        out = tools.run_tool(ctx, session, "make_game", {"spec": spec, "cast_ip_ids": cast})
        assert out.get("error") == "bad_args", (cast, out)
    assert store.snapshot(ctx, session["sessionId"])["games"] == []
