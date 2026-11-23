"""Our ad decision server: the inventory (every finished trailer of the account as a campaign) and, per viewer, the
campaign to show with its reasons in Korean. Pure functions over (viewer, activity log, inventory, now), so a decision
is deterministic and testable; server/live.py calls them at cue time and writes each viewer's VAST.

score = affinity (recency-weighted genre / tag / IP interest from play time and wins, trailers, playables, purchases,
        + clicks, - skips; half-life 7 days)
      + profile (a declared favourite genre)
      + novelty (a creative the viewer saw in its last K breaks is out: the frequency cap; one never seen gets a bonus)
      + exploration (a small stable dice roll per viewer, creative and break)
House rules: only video trailers (the 9:16 shorts are left out: the break is 16:9 and they have no length); at serve
time only creatives MediaTailor has transcoded (a new one is skipped once), else the best warmed one. The broadcast's
own game is not excluded: a viewer is watching it, not playing it. Creatives that share a title are one campaign (two
renders of one game's trailer): a viewer is offered the campaign once and served its best version that is ready, and
two viewers of one break never get the same campaign while the usable inventory has another one left.

Three ad styles share the decision (kind): "trailer" (the full-screen MediaTailor break) and "corner" (the player's own
muted picture-in-picture at a round end) rank the trailer inventory; "playable" ranks the playable inventory (the
owner's published 3D games, played over GameLift Streams). The frequency cap counts the impressions of the same family:
a trailer seen full-screen or in the corner, a game offered as a playable card.

The provider seam: "ipverse" (this module, VAST files on the live CDN) or "gam" (server/gam.py: the viewer's token
selects a second MediaTailor configuration whose ADS is Google Ad Manager). Off by default.
"""
from __future__ import annotations
import hashlib
import os
import re

from server import i18n
from server.i18n import tr

HALF_LIFE_DAYS = 7
FREQ_CAP_BREAKS = 2  # the same creative is not shown to a viewer again within this many of its breaks
EXPLORE = 0.08
PROFILE_BONUS = 0.6
NOVEL_BONUS = 0.15
W = {"genre": 1.0, "tag": 0.4, "ip": 0.6}

GENRE_LABEL = {"arpg": "액션 RPG", "racing": "레이싱", "explore": "탐험·수집", "shooter": "SF 슈터",
               "survival": "서바이벌", "platformer": "플랫포머"}
SESSION_GENRE = {"sf-shooter": "shooter", "sf-survival": "survival", "rpg-explore": "explore", "rpg-quest": "arpg"}
# tag -> (genre, label, words found in a trailer's text: title, intertitles, shot prompts, the session's concept)
TAGS = {
    "boss": ("arpg", "보스전", ["boss", "보스", "raid", "레이드"]),
    "sword": ("arpg", "검술", ["sword", "검", "knight", "기사", "blade"]),
    "dragon": ("arpg", "드래곤", ["dragon", "드래곤"]),
    "dungeon": ("arpg", "던전", ["dungeon", "던전", "quest", "퀘스트"]),
    "magic": ("arpg", "마법", ["magic", "마법", "fantasy", "판타지", "wizard"]),
    "car": ("racing", "자동차", ["car", "cars", "자동차", "차량", "kart", "카트"]),
    "drift": ("racing", "드리프트", ["drift", "drifts", "드리프트"]),
    "speed": ("racing", "스피드", ["race", "racing", "레이스", "레이싱", "speed", "속도", "track", "트랙", "lap"]),
    "chase": ("racing", "추격", ["chase", "추격", "pursuit"]),
    "city": ("explore", "도시", ["city", "도시", "street", "거리", "open world", "오픈월드", "skyline"]),
    "collect": ("explore", "수집", ["collect", "수집", "treasure", "보물", "coin", "코인"]),
    "cute": ("explore", "귀여움", ["cute", "귀여운", "cozy", "아기자기", "chibi"]),
    "island": ("explore", "하늘섬", ["island", "섬", "sky", "하늘", "cloud", "구름"]),
    "explore": ("explore", "탐험", ["explore", "exploration", "탐험", "adventure", "모험"]),
    "space": ("shooter", "우주", ["space", "우주", "galaxy", "은하", "planet", "행성", "starship"]),
    "gun": ("shooter", "총격", ["gun", "총", "blaster", "laser", "레이저", "shoot", "shooter", "사격", "슈터"]),
    "robot": ("shooter", "로봇", ["robot", "로봇", "mech", "메카", "cyborg", "android"]),
    "alien": ("shooter", "외계인", ["alien", "외계"]),
    "neon": ("shooter", "네온", ["neon", "네온", "cyber", "사이버"]),
    "zombie": ("survival", "좀비", ["zombie", "좀비", "undead"]),
    "horde": ("survival", "웨이브", ["survive", "survival", "생존", "서바이벌", "horde", "wave", "웨이브"]),
    "jump": ("platformer", "점프", ["platformer", "플랫포머", "jump", "점프", "climb"]),
}
# corner_engage: one tap on a corner logs two events (expand and unmute), 0.1 each
EVENT_W = {"trailer": 0.2, "purchase": 1.5, "wishlist": 0.8, "ad_click": 0.8, "ad_skip": -0.6,
           "corner_click": 0.8, "corner_engage": 0.1, "playable_play": 0.4}
# the impressions a style's frequency cap counts (and "처음 보는" looks at)
CAP_TYPES = {"trailer": ("ad_impression", "corner_impression"), "corner": ("ad_impression", "corner_impression"),
             "playable": ("playable_impression",)}
NOVEL_TEXT = {"trailer": "처음 보는 광고", "corner": "처음 보는 광고", "playable": "아직 안 해 본 게임"}
PLAYABLE_ENGINES = ("three", "unreal")  # the web player streams three.js builds (an unreal game keeps one too)


def _hit(word: str, text: str) -> bool:
    if word.isascii():  # whole words: "car" is not in "scar"
        return re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", text) is not None
    return word in text


def classify(text: str, session_genre: str = "") -> tuple:
    """(genre, tags) of a trailer from its text; the session's genre counts as one more hit and wins a tie."""
    text = (text or "").lower()
    tags = [t for t, (_, _, words) in TAGS.items() if any(_hit(w, text) for w in words)]
    votes = {g: 0.0 for g in GENRE_LABEL}
    for t in tags:
        votes[TAGS[t][0]] += 1
    home = SESSION_GENRE.get(session_genre)
    if home:
        votes[home] += 1.01
    genre = max(votes, key=lambda g: (votes[g], g == home))
    return (genre if votes[genre] > 0 else home or "shooter"), tags


# ── the inventory ─────────────────────────────────────────────────────────────

def campaigns(ctx, snap: dict) -> list:
    """One session's finished trailers as campaigns: the creative (url, seconds, id = MediaTailor's creative id) and
    its metadata (game title, genre, tags, the IP names in its shots, art style, created)."""
    from server import ads
    jobs = {j["jobId"]: j for j in snap.get("jobs", [])}
    ips = {i["ipId"]: i.get("name", "") for i in snap.get("ips", [])}
    session = snap.get("session") or {}
    concept = session.get("concept") or {}
    games = snap.get("games") or []
    out = []
    for t in ads.trailers(ctx, snap):
        inp = (jobs.get(t.get("jobId")) or {}).get("input") or {}
        cast = [j["input"]["ipId"] for j in (jobs.get(s) for s in inp.get("shot_job_ids") or [])
                if j and j.get("input", {}).get("ipId") in ips]
        names = list(dict.fromkeys(ips[i] for i in cast if ips[i]))
        style = concept.get("style") or ""
        genre, tags = classify(" ".join([t["text"], concept.get("logline") or "", style, *names]), session.get("genre", ""))
        game = trailer_game(games, cast) or {}
        out.append({"campaignId": t["creative"], "creative": t["creative"], "url": t["url"], "title": t["title"],
                    "seconds": t["seconds"], "game": game.get("title") or t["title"],
                    "gameUrl": game.get("publishedUrl") or "",
                    "genre": genre, "tags": tags, "ips": names[:4], "style": style[:60],
                    "sessionId": session.get("sessionId", ""), "createdAt": t["createdAt"]})
    return out


def trailer_game(games: list, cast_ip_ids) -> dict | None:
    """The published game a trailer's 게임 보기 opens: of the trailer's own session, the one casting most of the IPs in
    its shots (the newest of a tie), else the session's newest published game; None when the session has none (a
    draft or a preview is not a game to send a viewer to)."""
    shot = set(cast_ip_ids or ())
    published = [g for g in games if g.get("publishedUrl")]
    if not published:
        return None
    return max(published, key=lambda g: (len(shot & set(g.get("castIpIds") or ())),
                                         g.get("publishedAt") or g.get("createdAt") or "", g["gameId"]))


def games(snap: dict) -> list:
    """One session's published 3D games as playable campaigns: creative = "pg_<gameId>" (the frequency cap's key), the
    published page (url), its genre and tags (title, the session's logline and style) and the IPs it casts."""
    session = snap.get("session") or {}
    concept = session.get("concept") or {}
    ips = {i["ipId"]: i.get("name", "") for i in snap.get("ips", [])}
    by_id = {g["gameId"]: g for g in snap.get("games", [])}

    def root(g):  # a revision (baseGameId) is a version of the game it was made from: one family
        seen = {g["gameId"]}
        while g.get("baseGameId") in by_id and g["baseGameId"] not in seen:
            g = by_id[g["baseGameId"]]
            seen.add(g["gameId"])
        return g["gameId"]
    out = []
    for g in snap.get("games", []):
        if not g.get("publishedUrl") or g.get("engine") not in PLAYABLE_ENGINES:
            continue
        names = list(dict.fromkeys(ips[i] for i in g.get("castIpIds") or [] if ips.get(i)))
        genre, tags = classify(" ".join([g.get("title") or "", concept.get("logline") or "", concept.get("style") or "",
                                         *names]), g.get("genre") or session.get("genre", ""))
        out.append({"campaignId": "pg_" + g["gameId"], "creative": "pg_" + g["gameId"], "gameId": g["gameId"],
                    "sessionId": session.get("sessionId", ""), "title": g.get("title") or "게임",
                    "url": g["publishedUrl"], "gameUrl": g["publishedUrl"], "genre": genre, "tags": tags,
                    "ips": names[:4], "seconds": 0.0, "createdAt": g.get("publishedAt") or g.get("createdAt") or "",
                    "family": f"{session.get('sessionId', '')}/{root(g)}"})
    return out


def inventories(ctx, owner_sub: str, extra_sessions: tuple = ()) -> tuple:
    """(trailers, playables): every finished trailer and every published 3D game across the owner's sessions (each
    once), oldest first. One snapshot read per session serves both."""
    from server import store
    ids = [s["sessionId"] for s in store.list_sessions(ctx, owner_sub)] if owner_sub else []
    ids += [s for s in extra_sessions if s not in ids]
    trailers, playables, seen = [], [], set()
    for sid in ids:
        snap = store.snapshot(ctx, sid)
        for c in campaigns(ctx, snap) + games(snap):
            if c["creative"] not in seen:
                seen.add(c["creative"])
                (playables if c["creative"].startswith("pg_") else trailers).append(c)

    def order(c):
        return c["createdAt"], c["creative"]
    return sorted(trailers, key=order), sorted(playables, key=order)


def inventory(ctx, owner_sub: str, extra_sessions: tuple = ()) -> list:
    """Every finished trailer across the owner's sessions (one creative once), oldest first."""
    return inventories(ctx, owner_sub, extra_sessions)[0]


def playable_inventory(ctx, owner_sub: str, extra_sessions: tuple = ()) -> list:
    """Every published 3D game across the owner's sessions, oldest first."""
    return inventories(ctx, owner_sub, extra_sessions)[1]


# ── affinity from the activity log ────────────────────────────────────────────

def _epoch(ts: str) -> float:
    from server.viewers import epoch
    return epoch(ts)


def weight(ev: dict) -> float:
    t = ev.get("type")
    if t == "play":
        return ev.get("minutes", 0) / 60 * (1.25 if ev.get("win") else 0.85)
    if t == "playable":
        return 0.3 + ev.get("minutes", 0) / 60
    if t == "watch":
        return 0.5 * ev.get("minutes", 0) / 60
    return EVENT_W.get(t, 0.0)


def affinity(events: list, now: float) -> dict:
    """{"g:<genre>" | "t:<tag>" | "ip:<name>": interest}, each event decayed by its age (half-life 7 days)."""
    out: dict = {}
    for ev in events:
        w = weight(ev)
        if not w:
            continue
        w *= 0.5 ** (max(0.0, now - _epoch(ev["at"])) / 86400 / HALF_LIFE_DAYS)
        if ev.get("genre"):
            out["g:" + ev["genre"]] = out.get("g:" + ev["genre"], 0) + w
        for t in ev.get("tags") or []:
            out["t:" + t] = out.get("t:" + t, 0) + 0.5 * w
        for n in ev.get("ips") or []:
            out["ip:" + n] = out.get("ip:" + n, 0) + 0.7 * w
    return out


def share(events: list, genre: str, now: float) -> float:
    """How much of the viewer's positive genre interest this genre has (0..1)."""
    aff = affinity(events, now)
    pos = {k: v for k, v in aff.items() if k.startswith("g:") and v > 0}
    return max(0.0, aff.get("g:" + genre, 0)) / sum(pos.values()) if pos else 0.0


def recent_creatives(events: list, k: int = FREQ_CAP_BREAKS, types: tuple = ("ad_impression",)) -> list:
    """The creatives of the viewer's last k impressions on air of these types (seeded ones have none)."""
    return [e["creative"] for e in events if e.get("type") in types and e.get("creative")][-k:]


def campaign_key(c: dict) -> str:
    """Creatives with one title are one campaign (two renders of one game's trailer)."""
    return " ".join(str(c.get("title") or c.get("creative") or "").split()).casefold()


def same_keys(c: dict) -> set:
    """What makes two campaigns the same for one break: the title (campaign_key), and for a game its family (the
    session and the game its revisions were made from: v2 of a game is still that game)."""
    return {campaign_key(c), *([c["family"]] if c.get("family") else [])}


def distinct(items: list) -> int:
    """How many different campaigns a list holds, as a break tells them apart (same_keys; campaigns that share a key
    through a third are one): the most viewers that can each get an ad of their own."""
    groups: list = []
    for c in items:
        keys = same_keys(c)
        for g in [g for g in groups if g & keys]:
            groups.remove(g)
            keys |= g
        groups.append(keys)
    return len(groups)


def _hours(minutes: float) -> str:
    h, m = divmod(round(minutes), 60)
    return i18n.span(f"{h}시간 {m}분" if h and m else f"{h}시간" if h else f"{m}분")


def _reasons(c: dict, events: list, profile: dict, aff: dict, now: float, novel: bool, kind: str = "trailer") -> list:
    """(weight, text) candidates for why this campaign suits the viewer, in the language of the break's request."""
    g, label = c["genre"], i18n.label(GENRE_LABEL.get(c["genre"], c["genre"]))
    week = [e for e in events if e.get("genre") == g and now - _epoch(e["at"]) <= 7 * 86400]
    out = []
    play = sum(e.get("minutes", 0) for e in week if e["type"] == "play")
    if play:
        wins = sum(1 for e in week if e["type"] == "play" and e.get("win"))
        out.append((play / 60, tr("최근 7일 {label} {hours}", label=label, hours=_hours(play))
                    + (tr(" ({wins}승)", wins=wins) if wins else "")))
    mine = [e for e in events if e.get("genre") == g]
    clicks = sum(1 for e in mine if e["type"] == "ad_click")
    if clicks:
        out.append((0.8 * clicks, tr("{label} 광고 클릭 {n}회", label=label, n=clicks)))
    for t in ("purchase", "wishlist"):
        n = sum(1 for e in mine if e["type"] == t)
        if n:
            out.append((EVENT_W[t] * n, tr("{label} 게임 구매 {n}회", label=label, n=n) if t == "purchase"
                        else tr("{label} 게임 찜 {n}회", label=label, n=n)))
    watched = sum(e.get("minutes", 0) for e in mine if e["type"] == "watch")
    if watched:
        out.append((0.5 * watched / 60 + 0.05, tr("{label} 방송 시청 {hours}", label=label, hours=_hours(watched))))
    if g in (profile.get("genres") or []):
        out.append((PROFILE_BONUS, tr("관심 장르 {label}", label=label)))
    tag = max(c.get("tags") or [], key=lambda t: aff.get("t:" + t, 0), default=None)
    if tag and aff.get("t:" + tag, 0) > 0.2:
        out.append((W["tag"] * aff["t:" + tag], tr("'{tag}' 좋아함", tag=i18n.data(TAGS[tag][1]))))
    ip = max(c.get("ips") or [], key=lambda n: aff.get("ip:" + n, 0), default=None)
    if ip and aff.get("ip:" + ip, 0) > 0:
        out.append((W["ip"] * aff["ip:" + ip], tr("IP '{ip}' 반응", ip=ip)))
    tried = sum(1 for e in mine if e["type"] in ("playable", "playable_play"))
    if kind == "playable" and tried:
        out.append((0.3 * tried, tr("{label} 플레이어블 체험 {n}회", label=label, n=tried)))
    if novel:
        out.append((NOVEL_BONUS, tr("아직 안 해 본 게임") if kind == "playable" else tr("처음 보는 광고")))
    skips = sum(1 for e in mine if e["type"] == "ad_skip")
    if skips:
        out.append((-0.01, tr("{label} 광고 스킵 {n}회 (감점)", label=label, n=skips)))
    return out


def rank(viewer: dict, events: list, items: list, now: float, break_no: int = 0, kind: str = "trailer") -> list:
    """Every campaign the viewer may get, best first: {campaign, score, parts, reasons, alts}. A creative within the
    frequency cap (or another version of it: the same title) is left out, unless that leaves nothing. Creatives of one
    title count once: the best-scoring one stands for the campaign, the others are its alts (other versions)."""
    aff = affinity(events, now)
    profile = viewer.get("profile") or {}
    types = CAP_TYPES.get(kind, CAP_TYPES["trailer"])
    capped = set(recent_creatives(events, types=types))
    by_creative = {c["creative"]: c for c in items}
    capped_keys = set().union(*(same_keys(by_creative[c]) for c in capped if c in by_creative))
    seen = {e.get("creative") for e in events if e.get("type") in types}
    pool = [c for c in items if c["creative"] not in capped and not same_keys(c) & capped_keys] or list(items)
    out = []
    for c in pool:
        parts = {"affinity": round(W["genre"] * aff.get("g:" + c["genre"], 0)
                                   + W["tag"] * sum(aff.get("t:" + t, 0) for t in (c.get("tags") or [])[:4])
                                   + W["ip"] * sum(aff.get("ip:" + n, 0) for n in c.get("ips") or []), 4),
                 "profile": PROFILE_BONUS if c["genre"] in (profile.get("genres") or []) else 0.0,
                 "novelty": NOVEL_BONUS if c["creative"] not in seen else 0.0,
                 "explore": round(EXPLORE * _dice(viewer["viewerId"], c["creative"], break_no), 4)}
        cands = sorted(_reasons(c, events, profile, aff, now, c["creative"] not in seen, kind), key=lambda r: -r[0])
        pos = [t for w, t in cands if w > 0][:3] or [tr("새로운 장르 탐색")]
        neg = [t for w, t in cands if w <= 0]
        out.append({"campaign": c, "score": round(sum(parts.values()), 4), "parts": parts,
                    "reasons": (pos + neg)[:3]})
    # ties: the newer campaign, then the creative id
    out.sort(key=lambda r: (-r["score"], -_epoch(r["campaign"]["createdAt"]) if r["campaign"]["createdAt"] else 0,
                            r["campaign"]["creative"]))
    best: dict = {}
    for r in out:  # one entry per campaign: its best version, the other versions behind it in score order
        key = campaign_key(r["campaign"])
        if key in best:
            best[key]["alts"].append(r["campaign"])
        else:
            best[key] = {**r, "alts": []}
    return list(best.values())


def _ready_version(r: dict, usable) -> dict | None:
    """The ranked campaign as it can be served now: its best usable version (another version of the same campaign is
    still that campaign, not a fallback), or None."""
    if usable is None or usable(r["campaign"]):
        return r
    alt = next((c for c in r.get("alts", []) if usable(c)), None)
    return {**r, "campaign": alt, "version": True} if alt else None


def _dice(*parts) -> float:
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "big") / 2**64


def decide(people: list, logs: dict, items: list, now: float, break_no: int = 0, usable=None,
           kind: str = "trailer") -> dict:
    """{viewerId: decision} for one break. usable(campaign) → whether it may be served now (warmed, short enough); the
    best usable campaign is taken (its best usable version), marked fallback when the viewer's best campaign has no
    usable version. Viewers go in seed order, and each takes its best usable campaign that no earlier viewer got: one
    title (or one game's family, same_keys) goes to one viewer while the usable inventory has another. The same rule
    holds for every kind."""
    out, taken = {}, set()
    for v in people:
        ranked = rank(v, logs.get(v["viewerId"], []), items, now, break_no, kind)
        if not ranked:
            continue
        ok = [x for x in (_ready_version(r, usable) for r in ranked) if x]
        if not ok:
            out[v["viewerId"]] = {"best": ranked[0], "pick": None, "fallback": True, "ranked": ranked}
            continue
        pick = next((r for r in ok if not same_keys(r["campaign"]) & taken), ok[0])
        taken |= same_keys(pick["campaign"])
        out[v["viewerId"]] = {"best": ranked[0], "pick": pick, "ranked": ranked,
                              "fallback": campaign_key(pick["campaign"]) != campaign_key(ranked[0]["campaign"])
                              and _ready_version(ranked[0], usable) is None}
    return out


def short(title: str, n: int = 12) -> str:
    title = " ".join(str(title or "").split())
    return title if len(title) <= n else title[:n - 1].rstrip() + "…"


def served(decision: dict, note: str = None) -> dict | None:
    """What a break records for a viewer: the campaign, the score and the reasons ("이유" on the watch page). A fallback
    (its best campaign could not go; note = why: "준비 중" while MediaTailor transcodes it) says so first, in a few
    words: "차선 · 1순위 '<title>' 준비 중"."""
    p = decision.get("pick")
    if not p:
        return None
    c = p["campaign"]
    reasons = list(p["reasons"])
    if decision.get("fallback"):
        reasons = [tr("차선 · 1순위 '{title}' {note}", title=short(decision["best"]["campaign"].get("title", "")),
                      note=tr("준비 중") if note is None else note)] + reasons[:2]
    out = {"title": c["title"], "creative": c["creative"], "seconds": c["seconds"], "url": c["url"],
           "campaignId": c["campaignId"], "genre": c["genre"], "tags": c.get("tags", []), "ips": c.get("ips", []),
           "score": p["score"], "reasons": reasons, "reason": " · ".join(reasons)}
    for k in ("gameId", "sessionId", "gameUrl"):
        if c.get(k):
            out[k] = c[k]
    return out


# ── features (the GAM key-values) and the provider seam ───────────────────────

def features(viewer: dict, events: list, now: float) -> dict:
    """Non-PII features: the top-2 genres by affinity, skill from the win rate, device and age band."""
    aff = affinity(events, now)
    genres = sorted((k[2:] for k in aff if k.startswith("g:") and aff[k] > 0), key=lambda g: -aff["g:" + g])
    plays = [e for e in events if e.get("type") == "play"]
    rate = sum(1 for e in plays if e.get("win")) / len(plays) if plays else 0.0
    p = viewer.get("profile") or {}
    return {"g1": genres[0] if genres else "none", "g2": genres[1] if len(genres) > 1 else "none",
            "skill": "hi" if rate >= 0.6 else "mid" if rate >= 0.45 else "lo",
            "dev": p.get("device", "pc"), "age": p.get("ageBand", "unknown")}


def provider(viewer_id: str = "") -> str:
    """"gam" for this viewer when GAM is configured and switched on (AD_DECISION_PROVIDER=gam, or the viewer is in
    GAM_VIEWERS); else "ipverse"."""
    from server import gam
    if not gam.config():
        return "ipverse"
    if os.environ.get("AD_DECISION_PROVIDER", "ipverse") == "gam":
        return "gam"
    return "gam" if viewer_id and viewer_id in os.environ.get("GAM_VIEWERS", "").split(",") else "ipverse"

