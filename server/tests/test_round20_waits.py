"""A cloud stream's start times sit in one table (server/waits.py) and everything the server says of that wait is
read from it. Fakes only."""
import pathlib
import re

import pytest

from server import live, playable, waits
from server.tests.test_ad_styles import ctx  # noqa: F401 — the stream group, the table
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_viewer_ads import _owner

SERVER = pathlib.Path(__file__).resolve().parents[1]
MEASURED_COLD_SEC = (284, 316)  # two measured cold starts, click to host ready


def test_the_table_holds_what_was_measured():
    warm, cold = waits.CLOUD_START_SEC["warm"], waits.CLOUD_START_SEC["cold"]
    assert all(cold[0] <= sec <= cold[1] for sec in MEASURED_COLD_SEC)
    assert warm[0] < warm[1] < cold[0] < cold[1]
    assert (waits.CLOUD_WARM, waits.CLOUD_COLD) == ("10–20초", "4–6분")
    assert waits.CLOUD_START == "처음 켤 때 4–6분, 서버가 켜져 있으면 10–20초"
    # the sentences are made from the numbers, not typed beside them
    assert waits.CLOUD_COLD == f"{cold[0] // 60}–{cold[1] // 60}분" and waits.CLOUD_WARM == f"{warm[0]}–{warm[1]}초"


def test_the_console_reads_the_stream_start_from_the_same_table(ctx, clock):  # noqa: F811
    """The console's playable-server card polls this answer: the wait comes with the state."""
    out = live.standby_status(ctx, _owner(ctx))
    assert out["startSec"] == {"warm": [10, 20], "cold": [240, 360]}
    assert out["startSec"] == {k: list(v) for k, v in waits.CLOUD_START_SEC.items()}


def test_the_public_ad_page_is_told_the_wait_before_the_click(ctx, clock):  # noqa: F811
    """The page's first answer carries the wait sentence, to show beside the play button."""
    s = _owner(ctx)
    ad = playable.create(ctx, s, {"gameId": "gm_1", "seconds": 60})
    shown = playable.public(ctx, ad["adId"])
    assert shown["startText"] == waits.CLOUD_START == "처음 켤 때 4–6분, 서버가 켜져 있으면 10–20초"
    assert set(shown) == {"adId", "title", "seconds", "trailerUrl", "ctaUrl", "startText"}


def test_a_full_house_says_how_long_a_trial_takes_not_one_to_two_minutes():
    """A seat frees when a trial ends: DEFAULT_SEC to MAX_SEC of play plus the grace after it."""
    text = playable.FULL_TEXT.format(n=2)
    assert "1–2분" not in text and "2–4분 뒤 다시 눌러 주세요" in text and "GPU 2대" in text
    lo, hi = playable.DEFAULT_SEC + playable.GRACE_SEC, playable.MAX_SEC + playable.GRACE_SEC
    assert waits.span_sec(lo, hi) == "2–4분"


def test_a_highlight_still_being_prepared_names_the_trailer_figure(ctx, clock):  # noqa: F811
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    hl = {"id": "hl_1", "round": 1, "title": "명장면", "clipSeconds": 5, "wideUrl": "https://cdn/w.mp4", "shortUrl": "x"}
    with pytest.raises(live.LiveError) as e:
        live._send(ctx, live._get_json(ctx, live.JOB_KEY), hl, "linear")
    assert e.value.code == "warming" and f"{waits.TRAILER_PREP} 뒤에 보내 주세요" in e.value.message


@pytest.mark.parametrize("name", ["live.py", "playable.py", "streams.py", "app.py"],
                         ids=["broadcast", "playable", "streams", "app"])  # (ids `-k 'not live'` keeps)
def test_no_file_that_starts_a_cloud_stream_types_its_own_minutes(name):
    """A cold host's and a trailer's preparation time come from the table: none typed into a message or a comment."""
    source = (SERVER / name).read_text(encoding="utf-8")
    stale = re.findall(r"1\s?[–~-]\s?2\s?(?:분|min)|1\s?[–~-]\s?5\s?(?:분|min)", source)
    assert stale == [], f"{name}: {stale}"
