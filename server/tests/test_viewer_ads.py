"""Personalized trailer ads for the four dummy viewers: their seeded profiles and activity logs (server/viewers.py), the
decision (server/adserver.py), the per-viewer VAST files, break records and warm-ups (server/live.py), the impression
beacon growing the logs, and the GAM provider seam (server/gam.py). Fakes only. Named without "live" so
`pytest -k 'not live'` runs it."""
import json
import urllib.parse
import xml.etree.ElementTree as ET

import pytest

from server import ads, adserver, app, gam, live, store, viewers
from server.tests.test_ads import (FakeSecrets, _err, _keypair, _verify, api, call, clock, ctx, keys)  # noqa: F401

DAY = 86400
IDS = ["v-minji", "v-junho", "v-seoyeon", "v-hyunwoo"]
NOW = 1_800_000_000.0


# ── fixtures: an owner with trailers in several sessions ──────────────────────

def _trailer(ctx, sid, name, title, prompt, seconds, created, ip=None):
    shot = store.new_id("job")
    store.put_job(ctx, sid, {"jobId": shot, "kind": "shot", "input": {"prompt": prompt, **({"ipId": ip} if ip else {})},
                             "createdAt": created})
    job = store.new_id("job")
    store.put_job(ctx, sid, {"jobId": job, "kind": "trailer", "input": {"title": title, "shot_job_ids": [shot]},
                             "createdAt": created})
    return store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/{name}.mp4", "contentType": "video/mp4",
                                      "meta": {"seconds": seconds}, "jobId": job, "createdAt": created})


def _owner(ctx):
    """The broadcasting session (a 30 s survival game) and three more sessions of the same owner."""
    main = store.put_session(ctx, "user-1", "생존", "sf-survival")
    store.put_game(ctx, main["sessionId"], {"gameId": "gm_1", "title": "좀비 생존 30", "genre": "sf-survival",
                                           "specKey": "k", "previewUrl": "x"})
    _trailer(ctx, main["sessionId"], "zombie", "좀비 생존 30", "survive the zombie horde wave", 20.0, "2026-11-08T01:00:00.000Z")
    rpg = store.put_session(ctx, "user-1", "보스", "rpg-quest")
    store.put_ip(ctx, rpg["sessionId"], {"ipId": "ip_k", "name": "강철 기사", "createdAt": "2026-11-01T00:00:00.000Z"})
    _trailer(ctx, rpg["sessionId"], "boss", "보스 레이드", "a knight fights a giant boss, sword combat", 30.0,
             "2026-11-08T02:00:00.000Z", ip="ip_k")
    race = store.put_session(ctx, "user-1", "레이스", "sf-shooter")
    _trailer(ctx, race["sessionId"], "race", "네온 드리프트", "a car drifts through a race at night, speed", 20.0,
             "2026-11-08T03:00:00.000Z")
    sky = store.put_session(ctx, "user-1", "하늘섬", "rpg-explore")
    _trailer(ctx, sky["sessionId"], "island", "구름섬 이야기", "cute island in the sky, collect treasure", 15.0,
             "2026-11-08T04:00:00.000Z")
    _trailer(ctx, sky["sessionId"], "space", "스타 워든", "space marines shoot aliens with laser guns", 25.0,
             "2026-11-08T05:00:00.000Z")
    store.put_asset(ctx, sky["sessionId"], {"kind": "shorts", "key": f"sessions/{sky['sessionId']}/s.mp4",
                                            "contentType": "video/mp4", "meta": {}, "createdAt": "2026-11-08T06:00:00.000Z"})
    return main


def _name(url):
    return url.rsplit("/", 1)[1].split(".")[0]


def _logs(ctx, now):
    return {vid: viewers.log(ctx, vid, now) for vid in IDS}


# ── the seeded viewers ────────────────────────────────────────────────────────

def test_four_seeded_viewers_have_distinct_profiles_and_deterministic_logs():
    assert [v["viewerId"] for v in viewers.SEED_VIEWERS] == IDS
    assert all(v["viewerId"].isascii() and len(v["viewerId"]) <= 24 for v in viewers.SEED_VIEWERS)
    assert len({v["profile"]["genres"][0] for v in viewers.SEED_VIEWERS}) == 4
    for v in viewers.SEED_VIEWERS:
        log = viewers.seed_log(v)
        assert log == viewers.seed_log(v)  # from the seed alone
        kinds = {e["type"] for e in log}
        assert {"play", "trailer", "ad_impression", "playable"} <= kinds and kinds & {"ad_click", "ad_skip"}
        assert kinds & {"purchase", "wishlist"}
        assert all(0 < e["ago"] <= viewers.SEED_DAYS * DAY for e in log)
        assert all(isinstance(e["minutes"], int) and isinstance(e["win"], bool) for e in log if e["type"] == "play")
    feats = {}
    for v in viewers.SEED_VIEWERS:
        events = [{**e, "at": viewers._iso(NOW - e["ago"])} for e in viewers.seed_log(v)]
        feats[v["viewerId"]] = adserver.features(v, events, NOW)
    assert [feats[v]["g1"] for v in IDS] == ["arpg", "racing", "explore", "shooter"]  # what the profile says, in play
    assert {f["dev"] for f in feats.values()} == {"pc", "console", "mobile"}


def test_viewers_are_seeded_once_and_the_seeded_history_ends_where_the_live_one_starts(ctx, clock):
    people = viewers.ensure(ctx)
    assert [v["viewerId"] for v in people] == IDS and people[0]["name"] == "김민지"
    n = len(ctx.table.items)
    ctx.table.items[("VIEWERS", "VIEWER#v-junho")]["name"] = "박준호 (수정)"
    assert viewers.ensure(ctx)[1]["name"] == "박준호 (수정)" and len(ctx.table.items) == n
    log = viewers.log(ctx, "v-junho", clock.t)
    assert viewers.epoch(log[-1]["at"]) <= clock.t - 60 and all("ago" not in e for e in log)
    clock.t += 3 * DAY  # days later the history is still "recent"
    assert viewers.epoch(viewers.log(ctx, "v-junho", clock.t)[-1]["at"]) == pytest.approx(clock.t - 60 - min(
        e["ago"] for e in viewers.seed_log(viewers.SEED_VIEWERS[1])), abs=0.01)
    viewers.append(ctx, "v-junho", {"type": "ad_click", "genre": "racing", "title": "x"}, clock.t - 100)
    log = viewers.log(ctx, "v-junho", clock.t)
    assert log[-1]["type"] == "ad_click" and viewers.epoch(log[-2]["at"]) < clock.t - 100


# ── the decision ──────────────────────────────────────────────────────────────

def test_the_inventory_is_every_trailer_of_the_owner_with_its_metadata(ctx):
    _owner(ctx)
    store.put_session(ctx, "user-2", "남의 것", "sf-shooter")
    items = adserver.inventory(ctx, "user-1")
    assert [_name(c["url"]) for c in items] == ["zombie", "boss", "race", "island", "space"]  # no shorts
    by = {_name(c["url"]): c for c in items}
    assert {k: c["genre"] for k, c in by.items()} == {"zombie": "survival", "boss": "arpg", "race": "racing",
                                                      "island": "explore", "space": "shooter"}
    assert by["boss"]["ips"] == ["강철 기사"] and {"boss", "sword"} <= set(by["boss"]["tags"])
    assert by["race"]["creative"] == ads.creative_id(by["race"]["url"]) == by["race"]["campaignId"]
    assert by["space"]["seconds"] == 25.0 and by["space"]["createdAt"] == "2026-11-08T05:00:00.000Z"


def test_each_viewer_gets_a_different_campaign_deterministically_with_korean_reasons(ctx, clock):
    _owner(ctx)
    people, items = viewers.ensure(ctx), adserver.inventory(ctx, "user-1")
    first = adserver.decide(people, _logs(ctx, clock.t), items, clock.t)
    again = adserver.decide(people, _logs(ctx, clock.t), items, clock.t)
    assert first == again
    picks = {vid: _name(d["pick"]["campaign"]["url"]) for vid, d in first.items()}
    assert picks == {"v-minji": "boss", "v-junho": "race", "v-seoyeon": "island", "v-hyunwoo": "space"}
    for vid, d in first.items():
        s = adserver.served(d)
        assert s["reason"] == " · ".join(s["reasons"]) and 1 <= len(s["reasons"]) <= 3
        assert s["reasons"][0].startswith("최근 7일 ") and s["score"] == d["pick"]["score"]
        assert set(d["pick"]["parts"]) == {"affinity", "profile", "novelty", "explore"}
    assert "최근 7일 레이싱" in adserver.served(first["v-junho"])["reason"]


def _racer():
    return {"viewerId": "v-test", "profile": {"genres": []}}


def _c(cid, genre, created="2026-11-08T00:00:00.000Z", tags=(), ips=()):
    return {"campaignId": cid, "creative": cid, "url": f"https://cdn/{cid}.mp4", "title": cid, "seconds": 20.0,
            "genre": genre, "tags": list(tags), "ips": list(ips), "createdAt": created}


def _at(days_ago):
    return viewers._iso(NOW - days_ago * DAY)


def test_reasons_name_the_play_time_and_the_clicks_behind_the_pick():
    log = [{"type": "play", "genre": "racing", "minutes": 90, "win": False, "at": _at(1)},
           {"type": "play", "genre": "racing", "minutes": 90, "win": False, "at": _at(2)},
           {"type": "play", "genre": "racing", "minutes": 600, "win": True, "at": _at(20)},  # older than 7 days
           {"type": "ad_click", "genre": "racing", "at": _at(1)}, {"type": "ad_click", "genre": "racing", "at": _at(3)}]
    [best] = adserver.rank(_racer(), log, [_c("cr_r", "racing")], NOW)
    assert best["reasons"] == ["최근 7일 레이싱 3시간", "레이싱 광고 클릭 2회", "처음 보는 광고"]
    skip = adserver.rank(_racer(), log + [{"type": "ad_skip", "genre": "arpg", "at": _at(1)}], [_c("cr_a", "arpg")], NOW)
    assert skip[0]["reasons"][-1] == "액션 RPG 광고 스킵 1회 (감점)" and skip[0]["parts"]["affinity"] < 0


def test_recent_play_counts_more_than_old_play_and_skips_count_against():
    old = [{"type": "play", "genre": "arpg", "minutes": 120, "win": True, "at": _at(14)}]
    new = [{"type": "play", "genre": "racing", "minutes": 120, "win": True, "at": _at(0)}]
    ranked = adserver.rank(_racer(), old + new, [_c("cr_a", "arpg"), _c("cr_r", "racing")], NOW)
    assert ranked[0]["campaign"]["genre"] == "racing"
    assert ranked[1]["parts"]["affinity"] == pytest.approx(ranked[0]["parts"]["affinity"] / 4, rel=0.01)  # 2 half-lives
    skips = [{"type": "ad_skip", "genre": "racing", "at": _at(0)}] * 2  # 2.5 - 1.2 still beats 0.625
    assert adserver.rank(_racer(), old + new + skips, [_c("cr_a", "arpg"), _c("cr_r", "racing")], NOW)[0]["campaign"]["genre"] == "racing"
    many = [{"type": "ad_skip", "genre": "racing", "at": _at(0)}] * 4
    assert adserver.rank(_racer(), old + new + many, [_c("cr_a", "arpg"), _c("cr_r", "racing")], NOW)[0]["campaign"]["genre"] == "arpg"


def test_the_frequency_cap_keeps_a_creative_away_for_k_breaks(monkeypatch):
    monkeypatch.setattr(adserver, "EXPLORE", 0)  # no dice: the two racing campaigns tie
    log = [{"type": "play", "genre": "racing", "minutes": 300, "win": True, "at": _at(1)}]
    items = [_c("cr_r1", "racing", "2026-11-08T02:00:00.000Z"), _c("cr_r2", "racing", "2026-11-08T01:00:00.000Z"),
             _c("cr_x", "arpg")]
    top = lambda lg: adserver.rank(_racer(), lg, items, NOW)[0]["campaign"]["creative"]  # noqa: E731
    imp = lambda c, d: {"type": "ad_impression", "creative": c, "genre": "racing", "at": _at(d)}  # noqa: E731
    assert top(log) == "cr_r1"  # a tie goes to the newer campaign
    assert top(log + [imp("cr_r1", 0.01)]) == "cr_r2"
    assert top(log + [imp("cr_r1", 0.02), imp("cr_r2", 0.01)]) == "cr_x"  # both racing ones are within K=2
    assert top(log + [imp("cr_r1", 0.03), imp("cr_r2", 0.02), imp("cr_x", 0.01)]) == "cr_r1"  # out of the cap
    capped = log + [imp("cr_r1", 0.01)]
    assert [r["campaign"]["creative"] for r in adserver.rank(_racer(), capped, items[:1], NOW)] == ["cr_r1"]  # nothing else


def test_viewers_get_distinct_campaigns_whenever_the_inventory_has_enough():
    """A later viewer always takes the best title nobody got yet, however far apart the scores are."""
    a, b = {"viewerId": "v-a", "profile": {"genres": []}}, {"viewerId": "v-b", "profile": {"genres": []}}
    log = [{"type": "play", "genre": "racing", "minutes": 120, "win": True, "at": _at(0)}]
    close = [_c("cr_r", "racing"), _c("cr_s", "racing", tags=[])]
    out = adserver.decide([a, b], {"v-a": log, "v-b": log}, close, NOW)
    assert out["v-a"]["pick"]["campaign"]["creative"] != out["v-b"]["pick"]["campaign"]["creative"]
    far = [_c("cr_r", "racing"), _c("cr_x", "arpg")]
    out = adserver.decide([a, b], {"v-a": log, "v-b": log}, far, NOW)
    assert [out[v]["pick"]["campaign"]["creative"] for v in ("v-a", "v-b")] == ["cr_r", "cr_x"]
    assert not out["v-b"]["fallback"]  # its own best is cr_r: not a fallback for "not ready", just taken
    # two versions of one title among the warmed ones, two arpg viewers far apart in score
    arin = [_same_title("cr_a1", 24.6, "2026-11-08T02:00:00.000Z"), _same_title("cr_a2", 29.6, "2026-11-08T03:00:00.000Z")]
    items = arin + [_c("cr_n", "shooter"), _c("cr_t", "racing")]
    strong = [{"type": "play", "genre": "arpg", "minutes": 540, "win": True, "at": _at(0)}]
    weak = [{"type": "play", "genre": "arpg", "minutes": 49, "win": True, "at": _at(0)}]
    out = adserver.decide([a, b], {"v-a": strong, "v-b": weak}, items, NOW)
    titles = [out[v]["pick"]["campaign"]["title"] for v in ("v-a", "v-b")]
    assert titles[0] == "붉은 망토의 검사 아린" and titles[1] != titles[0]
    # only one title left that can go: both get it (no viewer goes without an ad)
    out = adserver.decide([a, b], {"v-a": strong, "v-b": weak}, items, NOW, usable=lambda c: c in arin)
    assert {out[v]["pick"]["campaign"]["title"] for v in ("v-a", "v-b")} == {"붉은 망토의 검사 아린"}


def test_the_best_usable_creative_is_taken_and_marked_as_a_fallback():
    log = [{"type": "play", "genre": "racing", "minutes": 120, "win": True, "at": _at(0)}]
    items = [_c("cr_r", "racing"), _c("cr_x", "arpg")]
    d = adserver.decide([_racer()], {"v-test": log}, items, NOW, usable=lambda c: c["creative"] == "cr_x")["v-test"]
    s = adserver.served(d)
    assert d["fallback"] and s["creative"] == "cr_x" and s["reasons"][0] == "차선 · 1순위 'cr_r' 준비 중"
    assert adserver.served(d, "길이 초과")["reasons"][0] == "차선 · 1순위 'cr_r' 길이 초과"
    long = {**items[0], "title": "아리: 스타 스카우트 — 마지막 비행, 은하의 끝에서"}
    d = adserver.decide([_racer()], {"v-test": log}, [long, items[1]], NOW, usable=lambda c: c["creative"] == "cr_x")
    assert adserver.served(d["v-test"])["reasons"][0] == "차선 · 1순위 '아리: 스타 스카우트…' 준비 중"  # short
    none = adserver.decide([_racer()], {"v-test": log}, items, NOW, usable=lambda c: False)["v-test"]
    assert none["pick"] is None and adserver.served(none) is None


def _same_title(cid, seconds, created, genre="arpg"):
    return {**_c(cid, genre, created), "title": "붉은 망토의 검사 아린", "seconds": seconds}


def test_defect_b_two_creatives_of_one_title_are_one_campaign_served_in_its_ready_version():
    """One title is one campaign: it is offered once, and its warmed version is no fallback."""
    log = [{"type": "play", "genre": "arpg", "minutes": 300, "win": True, "at": _at(0)}]
    items = [_same_title("cr_a30", 30.0, "2026-11-08T02:00:00.000Z"), _same_title("cr_a20", 20.0, "2026-11-08T01:00:00.000Z"),
             _c("cr_x", "racing")]
    ranked = adserver.rank(_racer(), log, items, NOW)
    assert [r["campaign"]["creative"] for r in ranked] == ["cr_a30", "cr_x"]  # the title once, its best version
    assert [c["creative"] for c in ranked[0]["alts"]] == ["cr_a20"]
    # the best version still warming: the other version of the same campaign goes, and that is not a fallback
    d = adserver.decide([_racer()], {"v-test": log}, items, NOW, usable=lambda c: c["creative"] != "cr_a30")["v-test"]
    s = adserver.served(d)
    assert s["creative"] == "cr_a20" and not d["fallback"] and not s["reasons"][0].startswith("차선")
    # neither version ready: a real fallback, and its reason names the campaign warming by title
    d = adserver.decide([_racer()], {"v-test": log}, items, NOW, usable=lambda c: c["creative"] == "cr_x")["v-test"]
    assert d["fallback"] and adserver.served(d)["reasons"][0] == "차선 · 1순위 '붉은 망토의 검사 아린' 준비 중"
    # two viewers are not given "different" campaigns that are one title
    a, b = {"viewerId": "v-a", "profile": {"genres": []}}, {"viewerId": "v-b", "profile": {"genres": []}}
    close = [_same_title("cr_a30", 30.0, "2026-11-08T02:00:00.000Z"), _same_title("cr_a20", 20.0, "2026-11-08T02:00:00.000Z")]
    out = adserver.decide([a, b], {"v-a": log, "v-b": log}, close, NOW)
    assert out["v-a"]["pick"]["campaign"]["title"] == out["v-b"]["pick"]["campaign"]["title"]
    assert out["v-a"]["pick"]["campaign"]["creative"] == out["v-b"]["pick"]["campaign"]["creative"]  # its best version


def test_defect_b_the_frequency_cap_covers_every_version_of_a_title():
    log = [{"type": "play", "genre": "arpg", "minutes": 300, "win": True, "at": _at(1)},
           {"type": "ad_impression", "creative": "cr_a30", "genre": "arpg", "at": _at(0.01)}]
    items = [_same_title("cr_a30", 30.0, "2026-11-08T02:00:00.000Z"), _same_title("cr_a20", 20.0, "2026-11-08T01:00:00.000Z"),
             _c("cr_x", "racing")]
    assert [r["campaign"]["creative"] for r in adserver.rank(_racer(), log, items, NOW)] == ["cr_x"]


# ── live log growth: the impression beacon ────────────────────────────────────

def test_an_impression_joins_the_log_once_with_a_simulated_reaction_and_shifts_the_next_pick(ctx, clock):
    _owner(ctx)
    people, items = viewers.ensure(ctx), adserver.inventory(ctx, "user-1")
    before = adserver.decide(people, _logs(ctx, clock.t), items, clock.t)["v-junho"]
    got = adserver.served(before)
    store._put(ctx, "ADBREAK#b_1", "SERVED#v-junho", {k: v for k, v in got.items() if k != "url"})
    ads.impression(ctx, {"b": "b_1", "p": "racer", "c": got["creative"]})  # the old persona's file is the viewer's
    ads.impression(ctx, {"b": "b_1", "p": "v-junho", "c": got["creative"]})  # a second tab: counted once
    ads.impression(ctx, {"b": "w_2", "p": "v-junho", "c": got["creative"]})  # a warm-up never counts
    ads.impression(ctx, {"b": "b_9", "p": "v-junho", "c": got["creative"]})  # a break that served it nothing
    live_events = [e for e in viewers.log(ctx, "v-junho", clock.t + 5) if e.get("breakId")]
    assert [e["type"] for e in live_events][0] == "ad_impression" and len(live_events) in (1, 2)
    assert live_events[0]["creative"] == got["creative"] and live_events[0]["genre"] == "racing"
    expect = viewers.react("v-junho", "b_1", adserver.share(viewers.log(ctx, "v-junho", clock.t), "racing", clock.t), True)
    assert [e["type"] for e in live_events[1:]] == ([] if expect == "complete" else [f"ad_{expect}"])
    after = adserver.decide(people, _logs(ctx, clock.t + 5), items, clock.t + 5, 1)["v-junho"]
    assert after["pick"]["campaign"]["creative"] != got["creative"]  # the cap moves it on


def test_the_simulated_reaction_follows_the_viewers_interest():
    rolls = [viewers.react("v-x", f"b_{i}", 0.9, True) for i in range(200)]
    cold = [viewers.react("v-x", f"b_{i}", 0.0, False) for i in range(200)]
    assert rolls.count("click") > 120 and cold.count("click") < 40 and cold.count("skip") > 80
    assert rolls == [viewers.react("v-x", f"b_{i}", 0.9, True) for i in range(200)]


def test_watch_time_grows_from_the_heartbeat_and_counts_toward_the_broadcasts_genre(ctx, clock):
    viewers.ensure(ctx)
    job = {"jobId": "j1", "adTitle": "좀비 생존 30", "genre": "survival", "tags": ["zombie"]}
    for _ in range(12):
        viewers.watch(ctx, ["v-minji"], job, clock.t)
        clock.t += 15
    viewers.watch(ctx, ["v-minji"], job, clock.t + 3600)  # a tab asleep for an hour adds one step only
    w = [e for e in viewers.log(ctx, "v-minji", clock.t) if e["type"] == "watch"]
    assert len(w) == 1 and w[0]["minutes"] == 3 and w[0]["genre"] == "survival"
    assert viewers.text(w[0]) == "방송 시청 3분 · 좀비 생존 30"


# ── the broadcast: per-viewer files, break records, warm-ups ──────────────────

def _job(ctx):
    return json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])


def _vast(ctx, pid):
    doc = ET.fromstring(ctx.s3._store[("live-b", ads.vast_key(pid))])
    return {"url": doc.find(".//MediaFile").text, "creative": doc.find(".//Creative").get("id"),
            "beacon": doc.find(".//Impression").text}


def _beat(ctx, s, ids=IDS):
    return live.viewer(ctx, s, {"viewers": ids})


def _warm_all(ctx, s, clock, ids=IDS):
    """The tiles watch until every queued creative had its warm-up, then MediaTailor's transcode time passes.
    → the warm-up breaks sent."""
    n = 0
    for _ in range(40):
        clock.t = max(clock.t, _job(ctx).get("breakUntil", 0)) + 1
        if not _beat(ctx, s, ids)["warmed"]:
            break
        n += 1
    clock.t = max(clock.t, _job(ctx).get("breakUntil", 0)) + live.TRANSCODE_SEC + 1
    return n


def _start(ctx, clock):
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    return s


def test_start_plans_every_viewer_and_queues_the_default_then_each_viewers_top_picks(ctx, clock):
    s = _start(ctx, clock)
    job = _job(ctx)
    assert job["ownerSub"] == "user-1" and job["genre"] == "survival" and job["trailerBreaks"] == 0
    assert {k: _name(p["url"]) for k, p in job["plan"].items()} == {
        "": "zombie", "v-minji": "boss", "v-junho": "race", "v-seoyeon": "island", "v-hyunwoo": "space"}
    queued = [_name(w["url"]) for w in job["warm"]]
    assert queued[:5] == ["zombie", "boss", "race", "island", "space"] and len(queued) == len(set(queued)) == 5
    inv = json.loads(ctx.s3._store[("live-b", live.INVENTORY_KEY)])
    assert inv["jobId"] == job["jobId"] and len(inv["items"]) == 5


def test_one_warm_up_break_warms_one_creative_per_watching_viewer(ctx, clock):
    s = _start(ctx, clock)
    assert _beat(ctx, s) == {"warmed": True} and ctx.ivs.breaks() == [1]
    files = {pid: _name(_vast(ctx, pid)["url"]) for pid in ["", *IDS, "racer"]}
    assert files == {"": "zombie", "v-minji": "zombie", "v-junho": "boss", "v-seoyeon": "race", "v-hyunwoo": "island",
                     "racer": "boss"}  # an old persona's file follows its viewer
    assert _vast(ctx, "v-junho")["beacon"].split("b=")[1].startswith("w_")
    assert {_name(u) for u in _job(ctx)["warmedAt"]} == {"zombie", "boss", "race", "island"}
    assert _warm_all(ctx, s, clock) == 1  # the fifth
    assert {_name(u) for u in _job(ctx)["warmedAt"]} >= {"zombie", "boss", "race", "island", "space"}
    reg = json.loads(ctx.s3._store[("live-b", live.WARM_REGISTRY)])
    assert {_name(u) for u in reg} == {"zombie", "boss", "race", "island", "space"}


def test_without_watching_tiles_a_warm_up_puts_one_creative_in_every_file(ctx, clock):
    s = _start(ctx, clock)
    assert live.viewer(ctx, s) == {"warmed": True}
    assert {_name(_vast(ctx, p)["url"]) for p in ["", *IDS, "action"]} == {"zombie"}
    assert _warm_all(ctx, s, clock, ids=[]) == 4


def test_a_break_writes_each_viewers_vast_and_records_who_got_what_and_why(ctx, clock):
    s = _start(ctx, clock)
    _warm_all(ctx, s, clock)
    assert live.round_done(ctx, s, {"rounds": 1})["cued"] is True
    assert ctx.ivs.breaks()[-1] == 30  # the longest pick
    files = {pid: _name(_vast(ctx, pid)["url"]) for pid in ["", *IDS, "action", "racer", "explorer"]}
    assert files == {"": "zombie", "v-minji": "boss", "v-junho": "race", "v-seoyeon": "island", "v-hyunwoo": "space",
                     "action": "boss", "racer": "race", "explorer": "island"}
    brk = live.status(ctx, s)["stream"]["breaks"][-1]
    assert brk["kind"] == "trailer" and brk["breakId"].startswith("b_")
    assert brk["picks"]["v-junho"]["title"] == "네온 드리프트" and "최근 7일 레이싱" in brk["picks"]["v-junho"]["reason"]
    assert brk["picks"]["racer"] == brk["picks"]["v-junho"] and brk["picks"][""]["title"] == "좀비 생존 30"
    assert all(not brk["picks"][v].get("fallback") for v in IDS)
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(_vast(ctx, "v-junho")["beacon"]).query)
    assert q == {"b": [brk["breakId"]], "p": ["v-junho"], "c": [brk["picks"]["v-junho"]["creative"]]}
    served = store._get(ctx, f"ADBREAK#{brk['breakId']}", "SERVED#v-junho")
    assert served["creative"] == brk["picks"]["v-junho"]["creative"] and served["reasons"]
    assert _job(ctx)["trailerBreaks"] == 1 and _job(ctx)["replanAt"] == _job(ctx)["breakUntil"]


def _served(ctx, s):
    return {v: (p["creative"], p.get("fallback", False)) for v, p in live.status(ctx, s)["stream"]["breaks"][-1]["picks"].items()}


def test_a_viewer_never_gets_a_creative_mediatailor_has_not_transcoded(ctx, clock):
    s = _start(ctx, clock)
    _warm_all(ctx, s, clock)
    assert live.round_done(ctx, s, {"rounds": 1})["cued"] is True
    first = _served(ctx, s)
    for vid in IDS:  # the beacons: each viewer saw its ad (the cap now moves them on)
        ads.impression(ctx, {"b": live.status(ctx, s)["stream"]["breaks"][-1]["breakId"], "p": vid, "c": first[vid][0]})
    # a new racing trailer made on air: the racer's best from the next plan, but MediaTailor has not seen it
    sid = [x["sessionId"] for x in store.list_sessions(ctx, "user-1") if x["title"] == "레이스"][0]
    _trailer(ctx, sid, "race2", "서킷 킹", "race cars speed on a track, drift, drift", 20.0, "2026-11-09T00:00:00.000Z")
    clock.t = _job(ctx)["breakUntil"] + 1
    live.status(ctx, s)  # the break is over: the next picks, and their warm-ups
    job = _job(ctx)
    assert _name(job["plan"]["v-junho"]["url"]) == "race2" and "race2" in [_name(w["url"]) for w in job["warm"]]
    assert live.round_done(ctx, s, {"rounds": 2})["cued"] is True  # a later break never waits
    warmed = {ads.creative_id(u) for u, t in _job(ctx)["warmedAt"].items() if clock.t - t >= live.TRANSCODE_SEC}
    second = _served(ctx, s)
    assert all(c in warmed for c, _ in second.values())
    assert second["v-junho"][1] is True  # its best is still warming: the best warmed one, marked
    assert live.status(ctx, s)["stream"]["breaks"][-1]["picks"]["v-junho"]["reason"].startswith("차선 · 1순위 '서킷 킹' 준비 중")
    assert _job(ctx)["warm"][0]["url"].endswith("/race2.mp4")  # still warming: first in the queue
    assert second["v-junho"][0] != first["v-junho"][0]  # and not the one it saw last break


def test_the_first_break_never_waits_it_goes_with_what_is_warm(ctx, clock):
    """The first break goes at its round's end with the warmed creatives: here only the default is, so everyone gets
    it, each with its reason, and the viewers' bests go first in the warm-up queue."""
    s = _start(ctx, clock)
    _beat(ctx, s, ids=[])  # only the default's warm-up goes out (no tiles: one creative per warm-up)
    clock.t = _job(ctx)["breakUntil"] + live.TRANSCODE_SEC + 1
    job = _job(ctx)
    job["warm"] = []  # nothing else warms (say, no viewer watches)
    ctx.s3._store[("live-b", "broadcaster/job.json")] = json.dumps(job).encode()
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["cued"] is True and not r["deferred"] and ctx.ivs.breaks()[-1] == 20
    assert {c for c, _ in _served(ctx, s).values()} == {_job(ctx)["plan"][""]["creative"]}
    picks = live.status(ctx, s)["stream"]["breaks"][-1]["picks"]
    assert all(picks[v]["reason"].startswith("차선 · 1순위") and picks[v]["fallback"] for v in IDS)
    queued = [_name(w["url"]) for w in _job(ctx)["warm"]]
    assert queued == ["boss", "race", "island", "space"]  # the viewers' bests, first


def test_old_jobs_and_personas_keep_working_and_highlights_go_to_every_viewer(ctx, clock):
    s = _start(ctx, clock)
    live._break(ctx, _job(ctx), "명장면", "https://cdn/hl.mp4", 5, "hl_1")
    assert {_vast(ctx, p)["url"] for p in ["", *IDS, "action", "racer", "explorer"]} == {"https://cdn/hl.mp4"}


# ── HTTP: the viewers, their tokens ───────────────────────────────────────────

def test_the_viewers_route_and_a_viewer_token(api, keys):
    status, body = call("GET", "/api/live/viewers")
    assert status == 200 and [v["viewerId"] for v in body["viewers"]] == IDS
    v = body["viewers"][1]
    assert v["name"] == "박준호" and v["profile"]["device"] == "console" and v["features"]["g1"] == "racing"
    assert 3 <= len(v["recent"]) <= 5 and all(r["text"] for r in v["recent"]) and v["provider"] == "ipverse"
    live.start(api, _owner(api), {"gameId": "gm_1", "everyRounds": 1})  # a token is the owner's on air
    status, tok = call("POST", "/api/live/token", {"persona": "v-junho"})
    assert status == 200 and tok["personaName"] == "박준호" and tok["provider"] == "ipverse"
    claims = _verify(tok["playbackUrl"].split("token=")[1], keys[1])
    assert claims["aws:ads-player-params"] == {"persona": "v-junho"} and "aws:ads-playback-config-name" not in claims
    assert call("POST", "/api/live/token", {"persona": "racer"})[0] == 200  # the old persona still plays
    assert call("GET", "/api/live/viewers", token=None)[0] == 401


def test_a_start_reuses_a_recent_inventory_and_adds_its_own_sessions_trailers(ctx, clock, monkeypatch):
    s = _start(ctx, clock)
    live.stop(ctx, s)
    _trailer(ctx, s["sessionId"], "zombie2", "좀비 생존 31", "zombie wave survive", 20.0, "2026-11-09T00:00:00.000Z")
    monkeypatch.setattr(adserver, "inventories", lambda *a: pytest.fail("a start right after another reads every session"))
    clock.t += 60
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    inv = json.loads(ctx.s3._store[("live-b", live.INVENTORY_KEY)])
    assert [_name(c["url"]) for c in inv["items"]] == ["zombie", "boss", "race", "island", "space", "zombie2"]
    assert inv["jobId"] == _job(ctx)["jobId"]


# ── the GAM seam ──────────────────────────────────────────────────────────────

FEATS = {"g1": "racing", "g2": "explore", "skill": "hi", "dev": "console", "age": "35-44"}


@pytest.fixture
def gam_on(monkeypatch):
    monkeypatch.setenv("GAM_NETWORK_CODE", "21700000")
    monkeypatch.setenv("GAM_AD_UNIT", "ipverse/live_midroll")
    return gam.config()


def test_gam_is_off_by_default(monkeypatch):
    for k in ("GAM_NETWORK_CODE", "GAM_AD_UNIT", "GAM_SSM_PARAM", "AD_DECISION_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    assert gam.config() is None and adserver.provider("v-junho") == "ipverse"
    monkeypatch.setenv("AD_DECISION_PROVIDER", "gam")
    assert adserver.provider("v-junho") == "ipverse"  # switched on but not configured: stays ours


def test_the_gam_tag_url_carries_the_viewers_key_values(gam_on):
    url = gam.tag_url(gam_on, "v-junho", FEATS, correlator=123456, avail_ms=30000)
    parts = urllib.parse.urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == "https://pubads.g.doubleclick.net/gampad/ads"
    q = dict(urllib.parse.parse_qsl(parts.query))
    assert q["iu"] == "/21700000/ipverse/live_midroll" and q["sz"] == "1280x720|640x360"
    assert (q["output"], q["env"], q["gdfp_req"], q["vpos"], q["pmad"]) == ("vast", "vp", "1", "midroll", "-1")
    assert q["correlator"] == "123456" and q["pmxd"] == "30000" and q["ppid"] == "v-junho"
    assert urllib.parse.parse_qs(q["cust_params"]) == {k: [v] for k, v in FEATS.items()}
    assert "cust_params=g1%3Dracing%26g2%3Dexplore%26skill%3Dhi%26dev%3Dconsole%26age%3D35-44" in url  # encoded once


def test_the_mediatailor_template_and_the_double_encoded_single_param(gam_on):
    t = gam.ads_url_template(gam_on)
    assert "correlator=[avail.random]" in t and "pmxd=[session.avail_duration_ms]" in t and "[avail.type]" not in t
    assert "ppid=[player_params.ppid]" in t and "sz=1280x720%7C640x360" in t
    assert "cust_params=g1%3D[player_params.g1]%26g2%3D[player_params.g2]%26skill%3D[player_params.skill]" in t
    p = gam.player_params("v-junho", {**FEATS, "age": "35–44 세"})
    assert all(c.isascii() and (c.isalnum() or c == "-") for v in p.values() for c in v) and p["age"] == "35-44"
    assert len(json.dumps(p).encode()) < 1000
    once = gam.cust_param_value("v-junho", FEATS, encode=2)
    assert "%253D" in once and urllib.parse.unquote(urllib.parse.unquote(once)) == gam.cust_string(gam.player_params("v-junho", FEATS))
    assert urllib.parse.unquote(once) == urllib.parse.quote(gam.cust_string(gam.player_params("v-junho", FEATS)), safe="")


def test_a_gam_viewers_token_selects_the_gam_configuration(ctx, keys, gam_on, monkeypatch):
    monkeypatch.setenv("GAM_VIEWERS", "v-junho")
    out = ads.playback(ctx, "v-junho")
    claims = _verify(out["playbackUrl"].split("token=")[1], keys[1])
    assert out["provider"] == "gam" and claims["aws:ads-playback-config-name"] == "ipverse-ivs-gam"
    assert claims["aws:ads-player-params"]["persona"] == "v-junho" and claims["aws:ads-player-params"]["g1"] == "racing"
    other = _verify(ads.playback(ctx, "v-minji")["playbackUrl"].split("token=")[1], keys[1])
    assert "aws:ads-playback-config-name" not in other  # only the listed viewers
