import json
import re

from server import store
from server.tests.conftest import FakeTable, make_ctx


def test_store_snapshot_sorts_and_groups():
    ctx = make_ctx(table=FakeTable())
    session = store.put_session(ctx, "user-1", "루나", "sf-shooter")
    sid = session["sessionId"]
    assert re.fullmatch(r"ses_[0-9a-f]{10}", sid)

    # written out of order on purpose
    store.put_ip(ctx, sid, {"ipId": "ip_b", "name": "B", "createdAt": "2026-10-29T10:00:02.000Z"})
    store.put_ip(ctx, sid, {"ipId": "ip_a", "name": "A", "createdAt": "2026-10-29T10:00:01.000Z"})
    store.put_message(ctx, sid, "assistant", "", "pending", ts="2026-10-29T10:00:01.001Z")
    store.put_message(ctx, sid, "user", "안녕", "done", ts="2026-10-29T10:00:01.000Z")
    asset = store.put_asset(ctx, sid, {"kind": "shot", "key": "sessions/x/a.mp4",
                                       "contentType": "video/mp4", "meta": {"seconds": 7.5}})
    store.put_job(ctx, sid, {"jobId": "job_1", "status": "queued", "input": {}, "deps": []})
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "G"})

    snap = store.snapshot(ctx, sid)

    assert snap["session"]["sessionId"] == sid and snap["session"]["title"] == "루나"
    assert [i["ipId"] for i in snap["ips"]] == ["ip_a", "ip_b"]
    assert [m["role"] for m in snap["messages"]] == ["user", "assistant"]
    assert [j["jobId"] for j in snap["jobs"]] == ["job_1"]
    assert [g["gameId"] for g in snap["games"]] == ["gm_1"]
    [a] = snap["assets"]
    assert a["assetId"] == asset["assetId"] and a["assetId"].startswith("ast_")
    assert a["url"] == "https://cdn.example.com/sessions/x/a.mp4"
    assert a["meta"] == {"seconds": 7.5}  # float survived the Decimal round trip
    assert "pk" not in a and "sk" not in a
    json.dumps(snap)  # no Decimals leak out

    assert store.list_sessions(ctx, "user-1") == [
        {"sessionId": sid, "title": "루나", "genre": "sf-shooter", "createdAt": session["createdAt"]}
    ]
    assert store.list_sessions(ctx, "someone-else") == []


def test_public_url_absolute_with_cdn_root_relative_without():
    key = "games/gm_1/index.html"
    assert store.public_url(make_ctx(), key) == "https://cdn.example.com/games/gm_1/index.html"
    # CDN_DOMAIN can be empty at runtime (CloudFormation cycle); SPA and games share the CloudFront origin
    assert store.public_url(make_ctx(cdn_domain=""), key) == "/games/gm_1/index.html"
