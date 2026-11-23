#!/usr/bin/env python3
"""Build a static gallery from actual generated game specs and captured gameplay.

Reads local evidence only. Does not authenticate, create games, contact AWS, or upload.
The generated site contains no JavaScript, credentials, external images or model calls.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import math
from pathlib import Path, PurePosixPath
import re
import struct
import sys
import tempfile
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://d12ka835iwfpnx.cloudfront.net"
PREFIX = "showcases/three-game-types-20261101"
TYPE_LABEL = {"exploration": "탐험 RPG", "combat": "SF 전투", "escape": "타임어택 탈출"}
TYPE_ORDER = ("exploration", "combat", "escape")
STAGE_LABEL = {"talk": "대화", "collect": "수집", "reach": "도달", "interact": "상호작용",
               "kills": "처치", "boss": "보스전", "survive": "생존"}
ROLE_LABEL = {"player": "주인공", "weapon": "무기", "prop": "아이템", "enemy": "적", "npc": "NPC"}
ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
HEX = re.compile(r"#[0-9a-fA-F]{6}")


class BuildError(ValueError):
    pass


def escape(value):
    return html.escape(str(value), quote=True)


def obj(value):
    return value if isinstance(value, dict) else {}


def items(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def text(value, limit=240):
    return value[:limit].strip() if isinstance(value, str) else ""


def numeric(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def identifier(value, field):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise BuildError(f"{field} must be a valid generated identifier")
    return value


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def owned_output(value):
    path = Path(value).expanduser().resolve()
    allowed = (ROOT / "artifacts/three-game-showcase", ROOT / ".build")
    if not any(path.is_relative_to(folder.resolve()) and path != folder.resolve() for folder in allowed):
        raise BuildError("Output must be inside artifacts/three-game-showcase or .build")
    return path


def same_host_base(value):
    parts = urlsplit(value)
    if (value.rstrip("/") != BASE or parts.username or parts.password
            or parts.query or parts.fragment):
        raise BuildError("Only the existing IPverse HTTPS CloudFront host is allowed")
    return BASE


def play_url(value, game_id):
    parts = urlsplit(value) if isinstance(value, str) else None
    if (parts is None or parts.scheme != "https" or parts.netloc != urlsplit(BASE).netloc
            or parts.username or parts.password or parts.query or parts.fragment
            or parts.path != f"/games/{game_id}/index.html"):
        raise BuildError("Game preview URL must reference its actual game on the existing CloudFront host")
    return value


def media_blob(folder, kind, suffix):
    source = folder / f"{kind}-{suffix}"
    if not source.exists():
        return None, None
    source = source.resolve()
    if not source.is_relative_to(folder.resolve()) or not source.is_file():
        raise BuildError("Evidence media must be a local file inside the screenshot directory")
    if source.stat().st_size > 60 * 1024 * 1024:
        raise BuildError("Evidence media exceeds the static gallery size limit")
    blob = source.read_bytes()
    if suffix.endswith(".png"):
        if len(blob) < 32 or blob[:8] != b"\x89PNG\r\n\x1a\n" or blob[12:16] != b"IHDR":
            raise BuildError("Gameplay screenshots must be PNG files")
        width, height = struct.unpack(">II", blob[16:24])
        if min(width, height) < 64 or max(width, height) > 10000:
            raise BuildError("Gameplay screenshot dimensions are invalid")
    elif b"ftyp" not in blob[:64]:
        raise BuildError("Optional gameplay clips must be MP4 files")
    return source, blob


def bindings(spec):
    """Names and roles from actual saved entity slots, not a fixed fixture cast."""
    rows = []
    player = obj(spec.get("player"))
    props = items(spec.get("props"))
    npc_index = obj(obj(spec.get("world")).get("npc")).get("propIndex")
    entities = [("player", player)]
    entities.extend(("npc" if index == npc_index else "prop", prop) for index, prop in enumerate(props))
    entities.extend(("enemy", enemy) for enemy in items(spec.get("enemies")))
    for role, entity in entities:
        if entity.get("ipId"):
            rows.append({"ipId": identifier(entity["ipId"], "entity.ipId"), "role": role,
                         "name": text(entity.get("name"), 80) or "이름 없는 IP",
                         "modelBound": bool(entity.get("modelUrl"))})
    if player.get("weaponIpId"):
        rows.append({"ipId": identifier(player["weaponIpId"], "player.weaponIpId"), "role": "weapon",
                     "name": "", "modelBound": bool(player.get("weaponUrl"))})
    return rows


def controls(spec):
    mechanics = obj(spec.get("mechanics"))
    result = [("W A S D", "이동"), ("드래그 · 방향키", "시점")]
    if mechanics.get("sprint") is not False:
        result.append(("Shift", "달리기"))
    if mechanics.get("jump") is not False:
        result.append(("Space", "점프"))
    if mechanics.get("dash") is not False:
        result.append(("Q", "대시"))
    stages = items(obj(spec.get("mission")).get("stages"))
    if any(stage.get("type") in ("interact", "talk") for stage in stages):
        result.append(("E", "상호작용"))
    combat = (bool(items(spec.get("enemies"))) or bool(obj(spec.get("player")).get("weaponUrl"))
              or mechanics.get("autoFire") is True
              or any(stage.get("type") in ("kills", "boss") for stage in stages))
    if combat:
        result.append(("클릭 / F", "공격"))
        if mechanics.get("autoFire") is True:
            result.append(("자동", "공격 켜짐"))
    return result


CSS = """\
:root{color-scheme:dark;--bg:#0e110d;--panel:#181c14;--line:#30372a;--text:#ecf0e7;--muted:#adb6a2;--lime:#b9ce99;--orange:#ff985b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}a{color:inherit;text-decoration:none}a:focus-visible{outline:3px solid var(--orange);outline-offset:5px}button,a{-webkit-tap-highlight-color:transparent}img,video{display:block;width:100%}
.wrap{width:min(1500px,calc(100% - 64px));margin:auto}.nav{height:88px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:20px}.brand{display:flex;align-items:center;gap:12px;font-size:25px;letter-spacing:-1px;font-weight:800}.brand-mark{width:25px;height:25px;border:2px solid var(--orange);transform:rotate(-13deg);position:relative}.brand-mark:after{content:"";position:absolute;width:7px;height:7px;background:var(--orange);top:-9px;right:-8px}.brand-dot{color:var(--orange)}.nav-link{color:var(--muted);font-size:13px}
.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:24px;padding:60px 0 36px}.eyebrow{font-size:11px;letter-spacing:3px;color:var(--orange);margin:0 0 12px}h1{font-size:clamp(31px,4vw,54px);line-height:1.12;letter-spacing:-2px;font-weight:700;margin:0 0 18px}h1 span{color:var(--lime)}.intro{color:var(--muted);max-width:640px;margin:0;font-size:15px}.hero-meta{display:flex;gap:28px;color:var(--muted);font-size:12px}.hero-meta strong{display:block;color:var(--text);font-size:30px;font-weight:600;line-height:1.25}.games{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:stretch;padding-bottom:48px}
.card{min-width:0;border:1px solid var(--line);border-radius:15px;background:var(--panel);overflow:hidden;display:flex;flex-direction:column}.card-top{padding:18px 20px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px}.type-label{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--lime);font-weight:600}.type-label:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.number{font:11px/1.2 ui-monospace,SFMono-Regular,monospace;color:var(--muted)}.visual{aspect-ratio:14/9;background:#090c08;position:relative}.visual img,.visual video{height:100%;object-fit:contain}.visual-placeholder{height:100%;display:grid;place-items:center;color:var(--muted);font-size:13px;border-block:1px dashed var(--line)}.visual figcaption{position:absolute;left:12px;bottom:10px;font-size:10px;color:#eef4e8;background:#111b;padding:3px 7px;border-radius:4px;pointer-events:none}
figure{margin:0}.card-body{padding:23px 20px 20px;display:flex;flex-direction:column;gap:18px;flex:1}h2{margin:0;font-size:23px;letter-spacing:-.7px;line-height:1.25;overflow-wrap:anywhere}.title-meta{display:flex;gap:9px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--muted)}.title-meta span{border:1px solid var(--line);border-radius:20px;padding:3px 9px}.section-title{margin:0 0 9px;color:var(--muted);font-size:11px;letter-spacing:.5px;font-weight:500}.mission{list-style:none;margin:0;padding:0;display:grid;gap:8px}.mission li{display:flex;align-items:flex-start;gap:9px;font-size:13px}.step{flex:none;display:grid;place-items:center;width:20px;height:20px;background:#252d1e;border:1px solid #39442d;color:var(--lime);border-radius:50%;font:10px/1 ui-monospace,SFMono-Regular,monospace}.mission-text{min-width:0;overflow-wrap:anywhere}.mission-detail{display:block;color:var(--muted);font-size:10px;margin-top:2px}
.controls{display:flex;gap:7px 12px;flex-wrap:wrap;font-size:11px;color:var(--muted)}kbd{display:inline-block;min-width:22px;border:1px solid #414a36;background:#20271b;border-radius:4px;padding:2px 5px;font:10px/1.2 ui-monospace,SFMono-Regular,monospace;color:var(--text);margin-right:4px}.ip-list{display:flex;flex-wrap:wrap;gap:6px}.ip{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:3px 6px;overflow-wrap:anywhere}.ip b{color:#d8e2cc;font-weight:500;margin-left:4px}.card-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;margin-top:auto;padding-top:5px}.button{display:flex;justify-content:center;align-items:center;min-height:42px;padding:10px 14px;font-size:12px;font-weight:600;border:1px solid var(--line);border-radius:7px}.button-primary{color:#192310;background:var(--lime);border-color:var(--lime)}.button:hover{filter:brightness(1.1)}.button-secondary{color:var(--muted)}.footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:22px 0 36px;font-size:11px;color:var(--muted)}.pending{border:1px solid #75613d;background:#2b2417;padding:12px 16px;margin-bottom:20px;color:#e5c48e;border-radius:8px;font-size:13px}.disabled{color:var(--muted);pointer-events:none;opacity:.7}
@media(max-width:1150px){.wrap{width:calc(100% - 40px)}.games{gap:12px}.card-body{padding:20px 16px}.card-top{padding-inline:16px}h2{font-size:21px}.card-actions{grid-template-columns:minmax(0,1fr)}}
@media(max-width:850px){.hero{grid-template-columns:minmax(0,1fr)}.hero-meta{gap:32px}.games{grid-template-columns:minmax(0,1fr);gap:24px}.card{max-width:680px;width:100%;margin:auto}.visual{aspect-ratio:14/9}.card-actions{grid-template-columns:minmax(0,1fr) auto}.hero{padding-top:38px}.hero-meta strong{font-size:24px}}
@media(max-width:480px){.wrap{width:calc(100% - 32px)}.nav{height:76px}.brand{font-size:22px}.nav-link{font-size:11px}.hero{padding:32px 0 24px;gap:22px}h1{letter-spacing:-1.2px}.intro{font-size:13px}.hero-meta{gap:28px}.games{gap:18px}.card-body{padding:20px 16px}.card-actions{grid-template-columns:minmax(0,1fr) auto}.button{font-size:11px;padding-inline:10px}.footer{font-size:10px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
"""


def build(args):
    base = same_host_base(args.base_url)
    output = owned_output(args.output)
    report_path = Path(args.report).resolve()
    if report_path.stat().st_size > 8 * 1024 * 1024:
        raise BuildError("Generation report exceeds the expected size")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise BuildError("Generation report must be an object")
    inventory_names = {row["ipId"]: text(row.get("name"), 80)
                       for row in items(report.get("sourceAssetInventory")) if row.get("ipId")}
    cases = items(report.get("cases"))
    if len(cases) != 3:
        raise BuildError("The gallery requires exactly three actual generated games")
    by_type = {}
    for case in cases:
        kind = case.get("type")
        if kind not in TYPE_ORDER or kind in by_type:
            raise BuildError("Three unique case types exploration, combat and escape are required")
        by_type[kind] = case
    folder = Path(args.screenshots).resolve()
    prefix = str(PurePosixPath(args.prefix))
    if prefix != PREFIX:
        raise BuildError("Only the requested isolated showcase prefix is allowed")
    artifacts = {}
    provenance = []
    cards = []
    missing = []
    stage_total = 0
    actual_names = {}
    bound_sets = []
    for index, kind in enumerate(TYPE_ORDER, 1):
        case = by_type[kind]
        game_id = identifier(case.get("gameId"), "gameId")
        session_id = identifier(case.get("sessionId"), "sessionId")
        url = play_url(case.get("previewUrl"), game_id)
        spec = obj(case.get("spec"))
        stages = items(obj(spec.get("mission")).get("stages"))
        if spec.get("version") != 2 or len(stages) != 3:
            raise BuildError("Each actual saved v2 spec must contain its three ordered mission stages")
        if case.get("ok") is False or case.get("messageStatus") in ("pending", "failed"):
            raise BuildError("Pending or failed generation cannot be shown as a completed game")
        # Never publish copied static screenshots under a misleading gameplay claim.
        suffix = ("combat-kill-1.png" if kind == "combat"
                  and (folder / "combat-combat-kill-1.png").exists() else "playing.png")
        png_source, png = media_blob(folder, kind, suffix)
        if png is None:
            missing.append(kind)
            if not args.allow_pending:
                raise BuildError(f"Actual playing.png evidence is required for {kind}")
            visual = '<div class="visual-placeholder">실제 플레이 화면 준비 중</div>'
        else:
            key = f"assets/{kind}-{sha(png)[:12]}.png"
            artifacts[key] = (png, "image/png")
            clip_source, clip = media_blob(folder, kind, "short.mp4")
            if clip is not None:
                clip_key = f"assets/{kind}-{sha(clip)[:12]}.mp4"
                artifacts[clip_key] = (clip, "video/mp4")
                visual = (f'<video controls playsinline preload="none" poster="{escape(key)}" '
                          f'aria-label="{escape(TYPE_LABEL[kind])} 실제 플레이 영상">'
                          f'<source src="{escape(clip_key)}" type="video/mp4"></video>')
            else:
                clip_source = None
                visual = f'<img src="{escape(key)}" alt="{escape(TYPE_LABEL[kind])}의 실제 플레이 화면" loading="lazy" width="1400" height="900">'
            provenance.append({"type": kind, "sourceScreenshot": str(png_source.relative_to(ROOT)),
                               "screenshotSha256": sha(png),
                               "sourceClip": str(clip_source.relative_to(ROOT)) if clip_source else None})
        roles = bindings(spec)
        declared_names = {row["ipId"]: text(row.get("name"), 80) for row in items(case.get("assetBindings")) if row.get("ipId")}
        cast_names = {row["ipId"]: text(row.get("name"), 80) for row in items(case.get("ips")) if row.get("ipId")}
        for row in roles:
            row["name"] = (inventory_names.get(row["ipId"]) or declared_names.get(row["ipId"])
                           or cast_names.get(row["ipId"]) or row["name"] or "무기 IP")
            actual_names[row["ipId"]] = row["name"]
        bound_sets.append({row["ipId"] for row in roles})
        title = text(spec.get("title"), 140) or text(case.get("name"), 140)
        if not title:
            raise BuildError("An actual generated game title is required")
        timer = numeric(obj(spec.get("rules")).get("timeLimitSec"))
        timer_label = "시간 제한 없음" if timer == 0 else f"{timer:g}초 제한" if timer is not None else "저장된 미션 규칙"
        hp = numeric(obj(spec.get("rules")).get("playerHp"))
        meta = [timer_label, f"미션 {len(stages)}단계"]
        if hp is not None:
            meta.append(f"체력 {hp:g}")
        stage_html = []
        for step, stage in enumerate(stages, 1):
            label = text(stage.get("label"), 180) or STAGE_LABEL.get(stage.get("type"), "미션")
            target = numeric(stage.get("target"))
            detail = STAGE_LABEL.get(stage.get("type"), "")
            if target is not None:
                detail += f" · 목표 {target:g}{'초' if stage.get('type') == 'survive' else ''}"
            stage_html.append(f'<li><span class="step">{step}</span><span class="mission-text">{escape(label)}'
                              f'<small class="mission-detail">{escape(detail)}</small></span></li>')
        stage_total += len(stages)
        controls_html = "".join(f'<span><kbd>{escape(key)}</kbd>{escape(label)}</span>' for key, label in controls(spec))
        cast_html = "".join(f'<span class="ip">{ROLE_LABEL[row["role"]]}<b>{escape(row["name"])}</b></span>' for row in roles)
        session_url = base + "/#" + urlencode({"s": session_id, "game": "preview"})
        cards.append(f'''<article class="card" aria-labelledby="title-{kind}">
<header class="card-top"><span class="type-label">{TYPE_LABEL[kind]}</span><span class="number">0{index} / 03</span></header>
<figure class="visual">{visual}<figcaption>{"실제 플레이 캡처" if png is not None else "준비 중"}</figcaption></figure>
<div class="card-body"><div><h2 id="title-{kind}">{escape(title)}</h2><div class="title-meta">{"".join(f"<span>{escape(v)}</span>" for v in meta)}</div></div>
<section aria-label="미션 순서"><h3 class="section-title">MISSION FLOW</h3><ol class="mission">{"".join(stage_html)}</ol></section>
<section aria-label="게임 조작"><h3 class="section-title">조작</h3><div class="controls">{controls_html}</div></section>
<section aria-label="사용한 IP"><h3 class="section-title">같은 IP, 새로운 역할</h3><div class="ip-list">{cast_html}</div></section>
<div class="card-actions"><a class="button button-primary" href="{escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="{escape(title)} 바로 플레이 (새 창)">바로 플레이 ↗</a>
<a class="button button-secondary" href="{escape(session_url)}" target="_blank" rel="noopener noreferrer" aria-label="{escape(title)} 스튜디오 세션 (새 창)">스튜디오 세션 ↗</a></div></div></article>''')
    common_ids = set.intersection(*bound_sets)
    common = [actual_names[ip_id] for ip_id in sorted(common_ids)]
    intro = (f"{' · '.join(common)}. 같은 IP로 탐험하고, 싸우고, 탈출하세요."
             if common else "탐험, 전투, 탈출. 서로 다른 목표와 세계를 직접 플레이해 보세요.")
    ready = not missing
    warning = '<p class="pending" role="status">미리보기 작업 중 · 실제 플레이 화면이 없는 카드는 아직 준비되지 않았습니다.</p>' if missing else ""
    page = f'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="같은 IP로 만든 탐험, SF 전투, 시설 탈출 게임을 바로 플레이하세요.">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="same-origin"><title>세 가지 게임, 하나의 IP · IPverse</title><link rel="stylesheet" href="./styles.css"></head>
<body><div class="wrap"><nav class="nav" aria-label="페이지 탐색"><a class="brand" href="{base}/" aria-label="IPverse 스튜디오"><span class="brand-mark" aria-hidden="true"></span><span>IPverse<span class="brand-dot">.</span></span></a><a class="nav-link" href="{base}/">스튜디오로 돌아가기 ↗</a></nav>
<header class="hero"><div><p class="eyebrow">ONE IP. THREE WAYS TO PLAY.</p><h1>같은 IP,<br><span>세 가지 플레이.</span></h1><p class="intro">{escape(intro)}</p></div>
<div class="hero-meta" aria-label="게임 구성"><div><strong>03</strong>플레이 가능한 게임</div><div><strong>{stage_total:02d}</strong>단계별 미션</div></div></header>
{warning}<main class="games" aria-label="세 가지 게임">{"".join(cards)}</main><footer class="footer"><span>IPverse · 캐릭터에서 플레이 가능한 세계까지</span><span>각 게임은 새 창에서 열립니다. 스튜디오 세션은 로그인이 필요합니다.</span></footer></div></body></html>'''
    artifacts["styles.css"] = (CSS.encode(), "text/css; charset=utf-8")
    artifacts["index.html"] = (page.encode(), "text/html; charset=utf-8")
    output.mkdir(parents=True, exist_ok=True)
    files = []
    for relative, (blob, content_type) in sorted(artifacts.items()):
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temp:
            temp.write(blob)
            temporary = Path(temp.name)
        temporary.replace(destination)
        files.append({"path": relative, "s3Key": f"web/{prefix}/{relative}", "contentType": content_type,
                      "cacheControl": "public,max-age=300" if relative in ("index.html", "styles.css") else "public,max-age=31536000,immutable",
                      "bytes": len(blob), "sha256": sha(blob)})
    manifest = {"status": "READY" if ready else "DRAFT_SCREENSHOTS_PENDING",
                "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(), "generationReport": str(report_path.relative_to(ROOT)),
                "generationReportSha256": sha(report_path.read_bytes()), "siteDirectory": str(output.relative_to(ROOT)),
                "url": f"{base}/{prefix}/index.html", "publicPrefix": f"web/{prefix}/", "caseCount": 3,
                "commonIpNames": common, "missingScreenshots": missing, "sourceMedia": provenance,
                "files": files, "uploadedByBuilder": False,
                "scope": "Static gallery of saved generation specs and supplied actual gameplay media; no model calls or game mutation"}
    manifest_path = output.parent / "build-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", default=str(ROOT / "evidence/three-game-showcase-generation.json"))
    parser.add_argument("--screenshots", default=str(ROOT / "evidence/three-game-showcase"))
    parser.add_argument("--output", default=str(ROOT / "artifacts/three-game-showcase/site"))
    parser.add_argument("--base-url", default=BASE)
    parser.add_argument("--prefix", default=PREFIX)
    parser.add_argument("--allow-pending", action="store_true", help="Local draft only: show clearly marked missing screenshot placeholders")
    args = parser.parse_args()
    try:
        manifest = build(args)
    except (BuildError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"status": "FAILED", "error": text(str(error), 240)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"status": manifest["status"], "siteDirectory": manifest["siteDirectory"],
                      "url": manifest["url"], "files": len(manifest["files"]), "uploaded": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
