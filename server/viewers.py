"""The four dummy viewers of the watch page: a profile each and an activity log the ad decision (server/adserver.py)
reads. Each viewer id is also its playback token's aws:ads-player-params persona, so MediaTailor asks for
vast/ivs/p-<viewerId>.xml at every break.

DynamoDB (single table):
  VIEWERS          VIEWER#<id>     the profile (seeded once, edits in the table are kept)
  VIEWER#<id>      SEED#<nnn>      the seeded history: deterministic from the viewer's seed, stored with `ago` (seconds
                                   before the history's end: the first live event, else now), so it never goes stale
  VIEWER#<id>      ACT#<iso>#<x>   live events: ad impressions (MediaTailor's beacon) and the simulated click or skip
  VIEWER#<id>      WATCH#<jobId>   watch time of one broadcast (the watch page's heartbeat)
  VIEWER#<id>      IMP#<breakId>   one impression per break (a second tab of the same viewer fires a second beacon)
  VIEWER#<id>      EV#<eventId>#<action>  one client event per break and action (the watch page's beacon for the ads it
                                   renders itself: a corner trailer or a playable card shown, clicked, played)
"""
from __future__ import annotations
import hashlib
import random
import time
from datetime import datetime, timezone

from server import i18n, store
from server.adserver import GENRE_LABEL
from server.i18n import tr

ACTIVE_SEC = 30  # a viewer whose tile played within this long is watching right now
WATCH_STEP_MAX_SEC = 30  # one heartbeat adds at most this much watch time (a tab asleep for an hour is not watching)
SEED_DAYS = 14

# (title, genre, tags): the games the seeded viewers played, saw trailers of, bought or wished for
CATALOG = [
    ("그림자 군주: 보스 러시", "arpg", ["boss", "sword"]),
    ("드래곤 레이드 온라인", "arpg", ["boss", "dragon", "magic"]),
    ("심연의 던전", "arpg", ["dungeon", "sword"]),
    ("네온 드리프트 X", "racing", ["drift", "car", "neon"]),
    ("서킷 레전드", "racing", ["speed", "car"]),
    ("한밤의 추격", "racing", ["chase", "car", "city"]),
    ("구름섬 수집가", "explore", ["island", "collect", "cute"]),
    ("골목 탐험 일기", "explore", ["city", "explore"]),
    ("보물 정원", "explore", ["collect", "cute"]),
    ("스타 레인저", "shooter", ["space", "gun"]),
    ("메카 프론트라인", "shooter", ["robot", "gun"]),
    ("은하 침공", "shooter", ["alien", "space"]),
    ("좀비 웨이브 30", "survival", ["zombie", "horde"]),
]

SEED_VIEWERS = [
    {"viewerId": "v-minji", "name": "김민지", "initials": "민지", "color": "#e5484d", "seed": 101, "persona": "action",
     "profile": {"ageBand": "25-34", "region": "서울", "device": "pc", "genres": ["arpg"]},
     "bio": "보스 패턴을 외울 때까지 같은 던전을 도는 액션 RPG 고인물",
     "mix": {"arpg": 0.72, "survival": 0.14, "shooter": 0.14}, "winRate": 0.66, "minutes": (45, 130), "plays": 18},
    {"viewerId": "v-junho", "name": "박준호", "initials": "준호", "color": "#0090ff", "seed": 202, "persona": "racer",
     "profile": {"ageBand": "35-44", "region": "부산", "device": "console", "genres": ["racing"]},
     "bio": "퇴근 후 콘솔로 타임 어택. 드리프트 리플레이를 모으는 레이서",
     "mix": {"racing": 0.78, "explore": 0.12, "shooter": 0.10}, "winRate": 0.52, "minutes": (20, 70), "plays": 16},
    {"viewerId": "v-seoyeon", "name": "이서연", "initials": "서연", "color": "#30a46c", "seed": 303, "persona": "explorer",
     "profile": {"ageBand": "25-34", "region": "대전", "device": "mobile", "genres": ["explore"]},
     "bio": "출퇴근길 모바일로 섬을 꾸미고 도감을 채우는 수집가",
     "mix": {"explore": 0.82, "racing": 0.09, "arpg": 0.09}, "winRate": 0.74, "minutes": (8, 30), "plays": 22},
    {"viewerId": "v-hyunwoo", "name": "최현우", "initials": "현우", "color": "#8e4ec6", "seed": 404, "persona": None,
     "profile": {"ageBand": "18-24", "region": "인천", "device": "pc", "genres": ["shooter"]},
     "bio": "SF 슈터 랭크전을 매일 돌리는 대학생, 우주 배경이면 일단 클릭",
     "mix": {"shooter": 0.70, "survival": 0.20, "arpg": 0.10}, "winRate": 0.57, "minutes": (25, 90), "plays": 17},
]
VIEWER_IDS = [v["viewerId"] for v in SEED_VIEWERS]
# an old persona id's VAST file follows the viewer it became (old links and windows keep working)
PERSONA_VIEWER = {v["persona"]: v["viewerId"] for v in SEED_VIEWERS if v["persona"]}
_PUBLIC = ("viewerId", "name", "initials", "color", "profile", "bio")


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(t * 1000) % 1000:03d}Z"


def epoch(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def unit(*parts) -> float:
    """A stable number in [0, 1) from the parts (the simulation's dice, the exploration term)."""
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "big") / 2**64


# ── the seeded history ────────────────────────────────────────────────────────

def _game(rnd: random.Random, mix: dict):
    genre = rnd.choices(list(mix), weights=list(mix.values()))[0]
    return rnd.choice([g for g in CATALOG if g[1] == genre])


def seed_log(viewer: dict) -> list:
    """The viewer's two weeks before the broadcast, from its seed alone: events with `ago` (seconds before the end),
    newest first. Plays (minutes, win or loss), trailers watched, ad impressions with clicks and skips (clicks on the
    favourite genres, skips elsewhere), playable ads, and a purchase or a wishlist."""
    rnd = random.Random(viewer["seed"])
    favs = set(viewer["profile"]["genres"])
    out = []

    def add(ago, **ev):
        out.append({**ev, "ago": int(ago)})

    for _ in range(viewer["plays"]):
        title, genre, tags = _game(rnd, viewer["mix"])
        add(rnd.uniform(0.5, SEED_DAYS) * 86400, type="play", title=title, genre=genre, tags=tags,
            minutes=rnd.randint(*viewer["minutes"]), win=rnd.random() < viewer["winRate"])
    for _ in range(rnd.randint(3, 5)):
        title, genre, tags = _game(rnd, viewer["mix"])
        add(rnd.uniform(0.5, SEED_DAYS) * 86400, type="trailer", title=title, genre=genre, tags=tags, seconds=30)
    for _ in range(rnd.randint(6, 9)):
        title, genre, tags = rnd.choice(CATALOG)
        ago = rnd.uniform(0.3, SEED_DAYS) * 86400
        add(ago, type="ad_impression", title=title, genre=genre, tags=tags)
        roll = rnd.random()
        if genre in favs and roll < 0.6:
            add(ago - 5, type="ad_click", title=title, genre=genre, tags=tags)
        elif genre not in favs and roll < 0.55:
            add(ago - 5, type="ad_skip", title=title, genre=genre, tags=tags)
    for _ in range(rnd.randint(1, 2)):
        title, genre, tags = _game(rnd, viewer["mix"])
        add(rnd.uniform(0.5, SEED_DAYS) * 86400, type="playable", title=title, genre=genre, tags=tags,
            minutes=rnd.randint(1, 4))
    title, genre, tags = _game(rnd, viewer["mix"])
    add(rnd.uniform(0.5, SEED_DAYS) * 86400, type="purchase" if rnd.random() < 0.5 else "wishlist",
        title=title, genre=genre, tags=tags)
    out.sort(key=lambda e: e["ago"])
    return out


# ── storage ───────────────────────────────────────────────────────────────────

def ensure(ctx) -> list:
    """The viewers' profiles (seeded with their history on first read), in seed order."""
    items = {i["viewerId"]: store._strip(i) for i in store._query(ctx, "VIEWERS")}
    for v in SEED_VIEWERS:
        if v["viewerId"] in items:
            continue
        for n, ev in enumerate(seed_log(v)):
            store._put(ctx, f"VIEWER#{v['viewerId']}", f"SEED#{n:03d}", ev)
        doc = {k: v[k] for k in (*_PUBLIC, "seed", "persona")}
        store._put(ctx, "VIEWERS", f"VIEWER#{v['viewerId']}", {**doc, "createdAt": store.now()})
        items[v["viewerId"]] = doc
    order = {vid: i for i, vid in enumerate(VIEWER_IDS)}
    return sorted(items.values(), key=lambda v: (order.get(v["viewerId"], len(order)), v["viewerId"]))


def resolve(viewer_id: str) -> str | None:
    """A viewer id, or the old persona id it replaced → the viewer id; anything else None."""
    return viewer_id if viewer_id in VIEWER_IDS else PERSONA_VIEWER.get(viewer_id)


def log(ctx, viewer_id: str, now: float | None = None) -> list:
    """The viewer's whole activity, oldest first, every event with an ISO `at`: the seeded history ends where the live
    one starts (or now), so "the last 7 days" always has it. A seeded event says so (seeded); an event of a broadcast
    names that broadcast's owner (owner: `shown` reads both)."""
    now = time.time() if now is None else now
    seeded, live = [], []
    for item in store._query(ctx, f"VIEWER#{viewer_id}"):
        kind, ev = item["sk"].split("#")[0], store._strip(item)
        if kind == "SEED":
            seeded.append(ev)
        elif kind == "ACT":
            live.append(ev)
        elif kind == "WATCH" and ev.get("sec", 0) >= 60:
            live.append({"type": "watch", "at": ev["first"], "minutes": round(ev["sec"] / 60), "title": ev.get("title", ""),
                         "genre": ev.get("genre", ""), "tags": ev.get("tags", []), "ips": ev.get("ips", []),
                         **({"owner": ev["owner"]} if ev.get("owner") else {})})
    end = min([epoch(e["at"]) for e in live] + [now]) - 60
    out = [{**{k: v for k, v in e.items() if k != "ago"}, "at": _iso(end - e["ago"]), "seeded": True}
           for e in seeded] + live
    return sorted(out, key=lambda e: e["at"])


def shown(events: list, owner: str, unowned: bool = False) -> list:
    """The events this account may read: the seeded history and the events of its own broadcasts (the four viewers'
    logs serve every account, and their lines name a broadcast's games). An event with no owner predates owner marks:
    only the account passing unowned (the shared demo account) reads it. The ad decision still reads the whole log."""
    return [e for e in events if e.get("seeded") or (owner and e.get("owner") == owner)
            or (unowned and not e.get("owner"))]


def append(ctx, viewer_id: str, event: dict, at: float | None = None) -> dict:
    at = time.time() if at is None else at
    ev = {**event, "at": _iso(at)}
    store._put(ctx, f"VIEWER#{viewer_id}", f"ACT#{ev['at']}#{event['type']}#{unit(viewer_id, at, event)*1e6:06.0f}", ev)
    return ev


def watch(ctx, viewer_ids: list, job: dict, now: float | None = None):
    """The watch page's heartbeat for these viewers: their watch time of this broadcast grows (one item each)."""
    now = time.time() if now is None else now
    for vid in viewer_ids:
        cur = store._get(ctx, f"VIEWER#{vid}", f"WATCH#{job['jobId']}")
        if cur:
            step = min(WATCH_STEP_MAX_SEC, max(0.0, now - cur["last"]))
            cur.update(last=now, sec=round(cur.get("sec", 0) + step))
        else:
            cur = {"first": _iso(now), "last": now, "sec": 0, "jobId": job["jobId"], "title": job.get("adTitle", ""),
                   "genre": job.get("genre", ""), "tags": job.get("tags", [])}
        if job.get("ownerSub"):  # whose broadcast it is (shown)
            cur["owner"] = job["ownerSub"]
        store._put(ctx, f"VIEWER#{vid}", f"WATCH#{job['jobId']}", {**cur, "last": round(now, 3)})


# ── live ad events: the impression beacon and the simulated reaction ──────────

def react(viewer_id: str, break_id: str, share: float, fav: bool) -> str:
    """What this viewer does with an ad it sees: "click", "skip" or "complete". A deterministic dice roll per viewer
    and break, weighted by how much of the viewer's interest the ad's genre has (share, 0..1) and the profile."""
    p_click = min(0.85, 0.08 + 0.6 * share + (0.15 if fav else 0))
    p_skip = max(0.0, 0.55 * (1 - share) - (0.2 if fav else 0))
    roll = unit("react", viewer_id, break_id)
    return "click" if roll < p_click else "skip" if roll > 1 - p_skip else "complete"


def impression(ctx, viewer_id: str, break_id: str, served: dict, share: float, now: float | None = None) -> list:
    """MediaTailor fired this viewer's impression of break_id: the impression joins its log once, with the simulated
    click or skip. served: the campaign the break gave the viewer (adserver.serve). → the events added."""
    now = time.time() if now is None else now
    if not store._update(ctx, f"VIEWER#{viewer_id}", f"IMP#{break_id}", {"at": _iso(now)}, expect={"at": None}):
        return []
    base = {k: served.get(k) for k in ("title", "genre", "tags", "ips", "creative") if served.get(k) is not None}
    if served.get("owner"):  # the broadcast's owner, from the break's record (shown)
        base["owner"] = served["owner"]
    out = [append(ctx, viewer_id, {"type": "ad_impression", "breakId": break_id, **base}, now)]
    profile = next((v["profile"] for v in SEED_VIEWERS if v["viewerId"] == viewer_id), {})
    got = react(viewer_id, break_id, share, served.get("genre") in profile.get("genres", []))
    if got != "complete":
        out.append(append(ctx, viewer_id, {"type": f"ad_{got}", "breakId": break_id, "simulated": True, **base}, now + 1))
    return out


CLIENT_EVENTS = {  # (style, action) → the activity type, for the ads the watch page renders itself
    ("corner", "impression"): "corner_impression", ("corner", "click"): "corner_click",
    ("corner", "expand"): "corner_engage", ("corner", "unmute"): "corner_engage",
    ("playable", "impression"): "playable_impression", ("playable", "play"): "playable_play",
    ("playable", "end"): "playable",
}


def client_event(ctx, viewer_id: str, event_id: str, kind: str, action: str, pick: dict, seconds=None,
                 now: float | None = None, owner: str = "") -> dict | None:
    """The watch page saw this viewer's corner trailer or playable card do something (shown, clicked, played, ended):
    the event joins its log once per break and action, with the pick's metadata from the break log (the server's own
    record, not the page's). The once-only row is keyed on the action, not the type: a tap on a corner sends expand
    and unmute together, both corner_engage. owner: the broadcast's owner (shown). → the event added, or None
    (unknown, or already there)."""
    now = time.time() if now is None else now
    t = CLIENT_EVENTS.get((kind, action))
    if not t or not store._update(ctx, f"VIEWER#{viewer_id}", f"EV#{event_id}#{action}", {"at": _iso(now)}, expect={"at": None}):
        return None
    base = {k: pick.get(k) for k in ("title", "genre", "tags", "ips", "creative", "gameId") if pick.get(k) is not None}
    ev = {"type": t, "eventId": event_id, **base, **({"owner": owner} if owner else {})}
    if action in ("expand", "unmute", "click"):
        ev["action"] = action
    if t == "playable":  # the play time (its weight: 0.3 + minutes/60)
        secs = max(0, min(int(seconds or 0), 600))
        ev.update(seconds=secs, minutes=round(secs / 60, 1))
    return append(ctx, viewer_id, ev, now)


# ── for the watch page ────────────────────────────────────────────────────────

_ACTIVITY = {"trailer": "트레일러 시청", "ad_impression": "광고 노출", "ad_click": "광고 클릭", "ad_skip": "광고 스킵",
             "purchase": "구매", "wishlist": "찜", "corner_impression": "코너 광고 노출",
             "corner_click": "코너 광고 → 게임 보기", "playable_impression": "플레이어블 카드 노출",
             "playable_play": "플레이어블 광고 시작"}


def text(ev: dict) -> str:
    """One activity line, in the language of the page that reads it (a seeded game's title by its English one)."""
    g = i18n.label(GENRE_LABEL.get(ev.get("genre"), ""))
    title = i18n.data(ev.get("title") or "")
    t = ev["type"]
    if t == "play":
        return (tr("{genre} · {title} {minutes}분 플레이 (승리)", genre=g, title=title, minutes=ev.get("minutes", 0))
                if ev.get("win") else
                tr("{genre} · {title} {minutes}분 플레이 (패배)", genre=g, title=title, minutes=ev.get("minutes", 0)))
    if t == "watch":
        return tr("방송 시청 {minutes}분 · {title}", minutes=ev.get("minutes", 0), title=title)
    if ev.get("seconds") is None:  # the seeded history: whole minutes
        played = f"{round(ev.get('minutes', 0))}분"
    else:  # a play on air: minutes and seconds as played, not the rounded minutes
        m, s = divmod(int(ev["seconds"]), 60)
        played = f"{m}분 {s}초" if m and s else f"{m}분" if m else f"{s}초"
    if t == "playable":
        label = tr("플레이어블 광고 {played}", played=i18n.span(played))
    elif t == "corner_engage":
        label = tr("코너 광고 크게 보기") if ev.get("action") == "expand" else tr("코너 광고 소리 켬")
    else:
        label = tr(_ACTIVITY[t]) if t in _ACTIVITY else t
    return f"{label} · {title}" + (f" ({g})" if g and t != "playable" else "")


def _shown(viewer: dict) -> dict:
    """A simulated viewer's profile in the page's language: the four seeded viewers' name, initials, line and region
    have English versions (i18n.DATA); the stored record stays Korean."""
    out = {k: viewer.get(k) for k in _PUBLIC}
    if i18n.lang() == "en":
        out.update({k: i18n.data(out[k]) for k in ("name", "initials", "bio")})
        if isinstance(out.get("profile"), dict):
            out["profile"] = {**out["profile"], "region": i18n.data(out["profile"].get("region"))}
    return out


def public(ctx, viewer: dict, events: list, recent: int = 5) -> dict:
    return {**_shown(viewer),
            "recent": [{"type": e["type"], "at": e["at"], "text": text(e), **({"simulated": True} if e.get("simulated") else {})}
                       for e in reversed(events[-recent:])],
            "events": len(events)}
