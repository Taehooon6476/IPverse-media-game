"""A broadcast replayed on the fake clock: a 30 s survival game with rounds of about 34 s, a full-screen trailer every
2 rounds with a corner trailer on the others, four watching tiles, the pre-cue, and an inventory MediaTailor has mostly
never seen. No break may be deferred or run into the next round's corner. Named without "live" so
`pytest -k 'not live'` runs it."""
import json

import pytest

from server import ads, live, store
from server.tests.test_ad_styles import ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_viewer_ads import IDS, _trailer

ROUND = 34.33  # a round's length in seconds
START_TO_FIRST_END = 24.5  # from live.start to round 1's end
FIRST_BEAT = 20  # the tiles' first heartbeat with all four playing
BEAT_SEC, POLL_SEC, BETWEEN_ROUNDS = 15, 4, 4
TILE_LATENCY = 4  # a tile plays this far behind live


def _run1_owner(ctx, clock):
    """The broadcasting session and its trailer (the default, warm), and the owner's other sessions: two versions of
    "붉은 망토의 검사 아린" and the runner-ups warm from earlier broadcasts, every viewer's best one new."""
    main = store.put_session(ctx, "user-1", "생존", "sf-survival")
    store.put_game(ctx, main["sessionId"], {"gameId": "gm_1", "title": "파도: 심해 탐사", "genre": "sf-survival",
                                           "specKey": "k", "previewUrl": "x"})
    rows = [  # (session, name, title, prompt, seconds, warm)
        (main, "wave", "파도: 심해 탐사", "survive the deep sea horde wave", 20.67, True),
        ("rpg", "arin1", "붉은 망토의 검사 아린", "a knight with a sword and a red cape, boss", 24.63, True),
        ("rpg2", "arin2", "붉은 망토의 검사 아린", "the red cape knight, sword combat", 29.58, True),
        ("rpg", "teo", "테오", "a sword knight in a dungeon, boss, magic", 9.54, False),
        ("rpg2", "dark", "다크 판타지 기사단", "dark fantasy knights, sword and magic", 18.0, False),
        ("race", "hover", "네온 레이싱: 호버카 추격전", "hover cars chase in a neon race, speed", 11.54, False),
        ("race", "front", "네온 프런티어: 테오", "a neon car on a cyber frontier", 16.0, True),
        ("sky", "lumi", "루미의 하늘섬 우편 배달", "cute island in the sky, collect letters", 19.67, False),
        ("sky", "roof", "도시 탐험: 네온 시티 옥상", "explore the city rooftops", 15.0, False),
        ("space", "ari", "아리: 스타 스카우트", "space scout with a laser gun", 17.5, True),
        ("space", "nabi", "나비 정찰병", "a neon robot scout", 24.1, True),
        ("space", "ari2", "아리: 스타 스카우트 — 마지막 비행", "space galaxy scout, alien planet, laser", 14.58, False),
    ]
    genres = {"rpg": "rpg-quest", "rpg2": "rpg-quest", "race": "sf-shooter", "sky": "rpg-explore", "space": "sf-shooter"}
    sessions, warm = {}, {}
    for n, (sess, name, title, prompt, secs, is_warm) in enumerate(rows):
        if isinstance(sess, str):
            sess = sessions.get(sess) or sessions.setdefault(sess, store.put_session(ctx, "user-1", sess, genres[sess]))
        a = _trailer(ctx, sess["sessionId"], name, title, prompt, secs, f"2026-11-08T{n:02d}:00:00.000Z")
        if is_warm:
            warm[store.public_url(ctx, a["key"])] = clock.t - 86400
    ctx.s3._store[("live-b", live.WARM_REGISTRY)] = json.dumps(warm).encode()
    return main


def _job(ctx):
    return json.loads(ctx.s3._store[("live-b", live.JOB_KEY)])


def _log(ctx, s):
    return json.loads(ctx.s3._store[("live-b", live.STATUS_KEY)])["breaks"]


def replay(ctx, clock, rounds=7, early_eta=False):
    """The timeline, one fake second at a time: status polls every 4 s, the tiles' heartbeat every 15 s, the play
    window's pre-cue when the broadcast's lead of a trailer round is left (early_eta: also its ETA at the round's
    start), the round reports, and each tile's impression beacon when the stitched ad reaches it. → what the server
    did."""
    s = _run1_owner(ctx, clock)
    t0 = clock.t
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2, "corner": True})
    lead = _job(ctx)["preCueLeadSec"]
    ends = [t0 + START_TO_FIRST_END + k * ROUND for k in range(rounds)]
    out = {"ends": ends, "eta": {}, "done": {}, "warmups": [], "lead": lead}
    beacons = {}  # breakId -> when its ad reaches the tiles
    step = 0.5
    t = t0
    while t <= ends[-1] + 40:
        t = round(t + step, 3)
        clock.t = t
        k = t - t0
        for r, end in enumerate(ends, 1):
            if early_eta and abs(t - (end - ROUND + BETWEEN_ROUNDS + 1)) < step / 2 and r > 1:
                live.round_eta(ctx, s, {"round": r, "endsInMs": round((end - t) * 1000), "sentAt": 0})
            if abs(t - (end - lead)) < step / 2:
                out["eta"][r] = live.round_eta(ctx, s, {"round": r, "endsInMs": lead * 1000, "sentAt": 0})
            if abs(t - end) < step / 2:
                out["done"][r] = live.round_done(ctx, s, {"rounds": r})
        if k >= FIRST_BEAT and abs((k - FIRST_BEAT) % BEAT_SEC) < step / 2:
            before = len(ctx.ivs.breaks())
            live.viewer(ctx, s, {"viewers": IDS})
            if len(ctx.ivs.breaks()) > before:
                out["warmups"].append(round(k, 1))
        if abs(k % POLL_SEC) < step / 2:
            before = len(ctx.ivs.breaks())
            live.status(ctx, s)
            if len(ctx.ivs.breaks()) > before and ctx.ivs.breaks()[-1] == 1:
                out["warmups"].append(round(k, 1))
        for b in _log(ctx, s):
            if b.get("kind") == "trailer" and b["breakId"] not in beacons:
                beacons[b["breakId"]] = live.viewers.epoch(b["cuedAt"]) + live.STREAM_LEAD_SEC + TILE_LATENCY
        for bid, at in list(beacons.items()):
            if at and t >= at:
                brk = next(b for b in _log(ctx, s) if b.get("breakId") == bid)
                for vid in IDS:
                    ads.impression(ctx, {"b": bid, "p": vid, "c": brk["picks"][vid]["creative"]})
                beacons[bid] = None
    out["breaks"] = _log(ctx, s)
    out["job"] = _job(ctx)
    out["t0"] = t0
    return out


def _summary(out):
    """Per round: the trailer's cue after its round end, endToAdSec, its distinct titles; the corner's time against the
    full-screen ad on air."""
    rows, on_air = [], []
    for b in out["breaks"]:
        end = out["ends"][b["round"] - 1]
        if b.get("kind") == "trailer":
            cued = live.viewers.epoch(b["cuedAt"])
            on_air.append((cued + live.STREAM_LEAD_SEC, cued + live.STREAM_LEAD_SEC + b["seconds"]))
            rows.append({"round": b["round"], "kind": "trailer", "cueAfterEnd": round(cued - end, 1),
                         "endToAdSec": b["endToAdSec"], "seconds": b["seconds"],
                         "titles": len({b["picks"][v]["title"] for v in IDS})})
        elif b.get("kind") == "corner":
            at = live.viewers.epoch(b["at"])
            rows.append({"round": b["round"], "kind": "corner", "afterEnd": round(at - end, 1),
                         "underAd": any(a <= at < z for a, z in on_air),
                         "titles": len({b["picks"][v]["title"] for v in IDS})})
        else:
            rows.append({"round": b["round"], "kind": b.get("kind"), "reason": b.get("reason")})
    return rows


@pytest.mark.parametrize("early_eta", [False, True])
def test_run1_replayed_every_break_lands_on_its_round_end_and_nothing_collides(ctx, clock, early_eta):
    out = replay(ctx, clock, early_eta=early_eta)
    rows = _summary(out)
    print(json.dumps({"rows": rows, "warmups": out["warmups"]}, ensure_ascii=False))
    trailers = [r for r in rows if r["kind"] == "trailer"]
    corners = [r for r in rows if r["kind"] == "corner"]
    assert [r["round"] for r in trailers] == [2, 4, 6] and [r["round"] for r in corners] == [1, 3, 5, 7]
    lead = out["lead"]
    for r in trailers:  # the pre-cue's break starts a moment after the round's end on every viewer's own picture
        assert abs(r["endToAdSec"] - (live.STREAM_LEAD_SEC - lead)) <= 0.5 and abs(r["cueAfterEnd"] + lead) <= 0.5, r
    assert all(not out["eta"][r].get("deferred") and out["eta"][r]["leadSec"] == lead for r in (2, 4, 6))
    assert all(not d.get("deferred") for d in out["done"].values())
    for r in corners:  # at the round end, never under a full-screen ad
        assert r["afterEnd"] == pytest.approx(0, abs=0.5) and not r["underAd"], r
    assert all(r["titles"] == 4 for r in trailers + corners), rows
    # each break ends before the next round's corner (its length capped to the room left)
    assert all(r["seconds"] <= ROUND - live.CORNER_GAP_SEC for r in trailers)


def test_run1_replayed_the_bests_warm_early_and_win_later_breaks(ctx, clock):
    out = replay(ctx, clock, early_eta=True)
    trailer = [b for b in out["breaks"] if b.get("kind") == "trailer"]
    first, later = trailer[0], trailer[1:]
    # the first break: warmed runner-ups, the reason says so in a few words
    runner = [v for v in IDS if first["picks"][v].get("fallback")]
    assert runner and all(first["picks"][v]["reasons"][0].startswith("차선") for v in runner)
    assert all(len(first["picks"][v]["reasons"][0]) <= 28 for v in runner)
    # warm-ups start once the tiles play, well before round 2, and never in a cue window or a break
    assert out["warmups"][0] <= FIRST_BEAT + 1 and out["warmups"][0] < START_TO_FIRST_END + ROUND - out["lead"]
    for w in out["warmups"]:
        at = out["t0"] + w
        for end in out["ends"][1::2]:  # the trailer rounds
            assert not end - out["lead"] - live.WARM_HOLD_SEC < at <= end, (w, end - out["t0"])
        for b in trailer:
            cued = live.viewers.epoch(b["cuedAt"])
            assert not cued <= at < cued + live.AD_LEAD_SEC + max(b["seconds"], live.BREAK_MARGIN_SEC)
    # by round 4 every viewer's best of the first plan is warm: later breaks have no runner-up for "준비 중"
    assert all(not b["picks"][v].get("fallback") or "준비 중" not in b["picks"][v]["reasons"][0]
               for b in later for v in IDS)


@pytest.mark.parametrize("default_warm", [True, False])
def test_how_many_warm_ups_a_fresh_inventory_needs(ctx, clock, default_warm):
    """Four tiles playing, no round in the way, one warm-up per WARM_HOLD_SEC. → the warm-ups until every viewer's
    plan (and the default) is warm, and until the whole queue (plan + top 3) is."""
    s = _run1_owner(ctx, clock)
    if not default_warm:
        ctx.s3._store[("live-b", live.WARM_REGISTRY)] = b"{}"
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2, "corner": True})
    plan = {p["url"] for p in _job(ctx)["plan"].values()}
    sent, plan_at = 0, None
    for _ in range(40):
        clock.t += 1
        if live.viewer(ctx, s, {"viewers": IDS})["warmed"]:
            sent += 1
        if plan_at is None and plan <= set(_job(ctx)["warmedAt"]):
            plan_at = sent
    queue_at = sent
    print({"default_warm": default_warm, "plan": plan_at, "queue": queue_at})
    assert plan_at == (1 if default_warm else 2)  # 4 creatives per warm-up (one per tile)
    assert queue_at <= 4 and not [w for w in _job(ctx)["warm"] if w["url"] not in _job(ctx)["warmedAt"]]
