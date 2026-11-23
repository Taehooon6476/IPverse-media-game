"""What a broadcast's status says beside its switches: how many different ads its viewers can get, and, once it is
over, what it sent.

job.adChoices is the number of different ads per style, counted as a break tells campaigns apart, so the page can say
that one trailer means one ad for everyone. lastBroadcast keeps the rounds and ads of the stopped broadcast for the
session that ran it."""
import json

from server import adserver, live, store
from server.tests.test_ad_styles import _game, _games, _playable_start, _sid, ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_round20_channel_owner import _studio
from server.tests.test_viewer_ads import _job, _owner, _trailer


# ── how many different ads the viewers can get ────────────────────────────────

def test_a_broadcast_with_one_trailer_says_its_viewers_have_one_ad(ctx, clock):  # noqa: F811
    """A new account: one session, one game, one trailer."""
    s = _studio(ctx, "user-7", "gm_new", "달빛 숲의 별조각")
    out = live.start(ctx, s, {"gameId": "gm_new", "everyRounds": 1})
    assert out["job"]["adChoices"] == {"trailer": 1, "playable": 1}
    assert live.status(ctx, s)["job"]["adChoices"] == {"trailer": 1, "playable": 1}  # every poll carries it


def test_an_owner_with_several_trailers_has_as_many_ads_as_titles(ctx, clock):  # noqa: F811
    s = _owner(ctx)  # five trailers over four sessions
    assert live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})["job"]["adChoices"]["trailer"] == 5


def test_two_renders_of_one_title_are_one_ad(ctx, clock):  # noqa: F811
    """As a break gives them out (adserver.same_keys): a second cut of the same trailer is no second choice."""
    s = _studio(ctx, "user-7", "gm_new", "달빛 숲의 별조각")
    _trailer(ctx, s["sessionId"], "t2", "달빛 숲의 별조각 트레일러", "the same scout, a second cut", 12.0, "2026-11-10T00:00:00.000Z")
    assert live.start(ctx, s, {"gameId": "gm_new", "everyRounds": 1})["job"]["adChoices"]["trailer"] == 1
    _trailer(ctx, s["sessionId"], "t3", "그림자 늑대의 밤", "a wolf under the moon", 12.0, "2026-11-11T00:00:00.000Z")
    live.stop(ctx, s)
    clock.t += live.INVENTORY_REUSE_SEC + 1
    assert live.start(ctx, s, {"gameId": "gm_new", "everyRounds": 1})["job"]["adChoices"]["trailer"] == 2


def test_a_playable_broadcast_counts_the_owners_published_games(ctx, clock):  # noqa: F811
    s = _playable_start(ctx, clock)  # four published 3D games; the broadcast's own is not published
    assert _job(ctx)["adChoices"]["playable"] == 4
    assert live.status(ctx, s)["job"]["adChoices"] == {"trailer": 5, "playable": 4}


def test_a_playable_broadcast_with_no_published_game_has_its_own_game_for_everyone(ctx, clock):  # noqa: F811
    s = _owner(ctx)
    out = live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    assert out["job"]["adChoices"]["playable"] == 1


def test_a_game_and_its_revision_are_one_playable_ad(ctx, clock):  # noqa: F811
    s = _games(ctx)
    store.put_game(ctx, _sid(ctx, "하늘섬"), {
        "gameId": "gm_sky2", "title": "구름섬 보물 수집 2", "genre": "rpg-explore", "engine": "three", "specKey": "k",
        "baseGameId": "gm_sky", "previewUrl": "x", "publishedUrl": store.public_url(ctx, "games/gm_sky2/index.html"),
        "publishedAt": "2026-11-10T00:00:00.000Z"})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    assert _job(ctx)["adChoices"]["playable"] == 4  # five published games, two of them one family


def test_a_playable_broadcast_of_a_session_without_a_trailer_still_knows_its_choices(ctx, clock):  # noqa: F811
    """No trailer, so nothing is planned at the start: the count is taken with the inventory all the same."""
    s = store.put_session(ctx, "user-8", "게임만", "sf-shooter")
    for gid, title in (("gm_a", "별빛 탐험"), ("gm_b", "심해 탈출")):
        _game(ctx, s["sessionId"], gid, title, "sf-shooter")
    out = live.start(ctx, s, {"gameId": "gm_a", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    assert out["job"]["adChoices"] == {"trailer": 0, "playable": 2}


def test_a_count_that_cannot_be_taken_never_keeps_a_broadcast_off_the_air(ctx, clock, monkeypatch):  # noqa: F811
    s = store.put_session(ctx, "user-8", "게임만", "sf-shooter")
    _game(ctx, s["sessionId"], "gm_a", "별빛 탐험", "sf-shooter")

    def down(*args, **kwargs):
        raise RuntimeError("ProvisionedThroughputExceededException")
    monkeypatch.setattr(live, "_inventories", down)
    out = live.start(ctx, s, {"gameId": "gm_a", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    assert out["active"] is True and "adChoices" not in out["job"]  # unknown: the page says nothing of it


def test_distinct_counts_campaigns_as_a_break_tells_them_apart():
    def c(creative, title, family=None):
        return {"creative": creative, "title": title, **({"family": family} if family else {})}
    assert adserver.distinct([]) == 0
    assert adserver.distinct([c("a", "달빛 숲"), c("b", "달빛  숲"), c("c", "늑대의 밤")]) == 2  # a title's versions: once
    assert adserver.distinct([c("pg_1", "구름섬", "s/1"), c("pg_2", "구름섬 2", "s/1"), c("pg_3", "심해", "s/3")]) == 2
    # a title shared across two families joins them, as a break's "taken" set does
    assert adserver.distinct([c("pg_1", "구름섬", "s/1"), c("pg_2", "구름섬", "s/2"), c("pg_3", "다른 게임", "s/2")]) == 1


# ── a broadcast that is over keeps what it sent ───────────────────────────────

def test_after_the_stop_the_status_keeps_the_rounds_and_the_ads_of_that_broadcast(ctx, clock):  # noqa: F811
    s = _playable_start(ctx, clock, every=1)
    for n in (1, 2, 3):
        clock.t += 40
        live.round_done(ctx, s, {"rounds": n})
    before = live.status(ctx, s)
    assert len(before["stream"]["breaks"]) == 3 and "lastBroadcast" not in before  # on air: the live list says it

    stopped = live.stop(ctx, s)

    assert stopped["active"] is False and stopped["stream"] is None and stopped["job"] is None
    assert stopped["lastBroadcast"] == {"rounds": 3, "ads": 3}
    assert live.status(ctx, s)["lastBroadcast"] == {"rounds": 3, "ads": 3}  # and at every poll after it


def test_a_round_that_got_no_ad_is_not_counted_as_one(ctx, clock):  # noqa: F811
    s = _playable_start(ctx, clock, every=1)
    live.round_done(ctx, s, {"rounds": 1})
    doc = json.loads(ctx.s3._store[("live-b", live.STATUS_KEY)])
    doc["breaks"].append({"round": 2, "kind": "skip", "of": "trailer", "reason": "ad_on_air"})  # as _skip logs it
    doc["rounds"] = 2
    ctx.s3._store[("live-b", live.STATUS_KEY)] = json.dumps(doc).encode()
    assert live.stop(ctx, s)["lastBroadcast"] == {"rounds": 2, "ads": 1}


def test_only_the_session_whose_broadcast_it_was_reads_it_and_only_until_the_next_one(ctx, clock):  # noqa: F811
    s = _playable_start(ctx, clock, every=1)
    live.round_done(ctx, s, {"rounds": 1})
    live.stop(ctx, s)
    other = store.put_session(ctx, "user-1", "다른 세션", "sf-shooter")
    assert "lastBroadcast" not in live.status(ctx, other)  # the owner's other session
    assert "lastBroadcast" not in live.status(ctx, _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임"))
    again = live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    assert again["active"] is True and "lastBroadcast" not in again  # a new broadcast: its own counters


def test_a_session_that_never_broadcast_has_none(ctx, clock):  # noqa: F811
    s = _owner(ctx)
    assert "lastBroadcast" not in live.status(ctx, s)
