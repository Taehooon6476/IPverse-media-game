"""Games keep up with their IPs' files.

make_game copies every IP file a game shows (cutout, GLB, rigged GLB, background picture) into games/<id>/assets/.
refresh() copies the IP's current file over the same key, so a later fix to an IP reaches games made before it.
jobs.py runs it for the session's games when a job links new files to an IP; the refresh_game_assets tool runs it for
one game on request. A rig takes the IP's raw mesh along: the runtime shows that mesh when it drops the rig
(game3d/world.js brokenRig).

The spec stays as it was made: an IP that a game shows as a cutout panel, or as a model without its rig, stays that
way (it would need another modelUrl/animUrl, so a re-made game), and the tool says so. The runtime's own files
(assets/ual.glb) stay as they shipped.

Idempotent: a file that already holds the same bytes (same ETag: the bucket is SSE-S3 and the copies are single-part)
is not copied again. A second pass re-copies any file whose IP moved to a newer one meanwhile, so a slow copy of an
older file never stays last. The Lambda cannot invalidate CloudFront, so refreshed files get Cache-Control no-cache;
a copy cached before its first refresh can be served for up to 24 h (/games/* uses CachingOptimized).
"""
from __future__ import annotations
import json
import traceback

from botocore.exceptions import ClientError

from server import gamespec, store

NO_CACHE = "no-cache"
RIG = ".rig.glb"  # a rigged model in a game folder; its raw mesh stands next to it as .glb (tools._game_asset_keys)
SPEC = {
    "name": "refresh_game_assets",
    "description": (
        "이미 만든 게임(gameId)에 그 게임에 나오는 IP의 최신 그림(배경을 지운 그림)·3D 모델(GLB)·움직임 뼈대 파일을 다시 "
        "복사해 같은 게임, 같은 주소에 반영한다. 예: '이 게임에 새 3D 반영해줘', '고친 움직임 뼈대를 예전 게임에도 넣어줘'. "
        "게임 설계(spec)와 미션은 그대로다. 3D·움직임 뼈대·이미지 작업이 끝나면 서버가 그 IP를 쓰는 세션의 게임에 "
        "자동으로도 반영한다. 게임을 만들 때 납작한 그림 판으로 들어간 IP를 3D 모델로, 움직임 뼈대 없는 모델을 뼈대가 "
        "들어간 모델로 바꾸지는 않는다: 결과 needsRemake의 IP는 make_game으로 게임을 다시 만들어야 바뀐다."),
    "inputSchema": {"json": {"type": "object", "properties": {"gameId": {"type": "string"}}, "required": ["gameId"]}},
}


def refresh(ctx, session_id: str, game_id: str = None, new_keys=None) -> list:
    """Copies the IPs' current files over the copies that differ in the session's games (or in game_id only).
    new_keys: only the files copied from these S3 keys (what a job just linked), a rig among them with its raw mesh.
    → [(gameId, file, ipId)] copied."""
    specs, first, copied = {}, None, []
    for _ in range(2):
        snap = store.snapshot(ctx, session_id)
        ips, assets = {i["ipId"]: i for i in snap["ips"]}, {a["assetId"]: a for a in snap["assets"]}
        owner = {a["key"]: a.get("ipId") for a in assets.values()}
        files = {}
        for game in snap["games"]:
            if game_id is None or game["gameId"] == game_id:
                if game["gameId"] not in specs:  # a game's spec never changes: read once
                    specs[game["gameId"]] = _spec(ctx, game)
                files.update({(game["gameId"], name): src
                              for name, src in _ip_files(specs[game["gameId"]], ips, assets).items()})
        if first is None:
            todo = first = {k: src for k, src in files.items() if new_keys is None or src in new_keys}
            # A rig copied into a game takes the IP's raw mesh along: the runtime falls back to it when it drops the rig
            raw = [(gid, name.removesuffix(RIG) + ".glb") for gid, name in todo if name.endswith(RIG)]
            todo.update({k: files[k] for k in raw if k in files})
        else:  # second pass, after copying: only the files whose IP moved on since the first
            todo = {k: files[k] for k, src in first.items() if files.get(k, src) != src}
        done = [(gid, name, owner.get(src)) for (gid, name), src in todo.items() if _copy(ctx, src, f"games/{gid}/{name}")]
        copied += done
        if not done:
            break
    return copied


def after_job(ctx, session_id: str, new_keys) -> None:
    """jobs.py, once a finished job linked new files to an IP: the session's games that show them take them. Never
    raises: the job is done whatever happens here, and refresh_game_assets can redo a game."""
    try:
        refresh(ctx, session_id, new_keys=set(new_keys))
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def refresh_game_assets(ctx, session, args) -> dict:
    sid, game_id = session["sessionId"], args.get("gameId")
    game = next((g for g in store.snapshot(ctx, sid)["games"] if g["gameId"] == game_id), None)
    if not game:
        return {"error": "not_found", "message": f"게임을 찾을 수 없습니다: {game_id}. 상태(state)에 있는 id만 쓰세요."}
    copied = refresh(ctx, sid, game_id=game["gameId"])
    snap = store.snapshot(ctx, sid)
    ips, assets = {i["ipId"]: i for i in snap["ips"]}, {a["assetId"]: a for a in snap["assets"]}

    def name(ip_id):
        return (ips.get(ip_id) or {}).get("name") or ip_id

    updated = [{"ipId": ip_id, "name": name(ip_id), "file": file} for _, file, ip_id in dict.fromkeys(copied)]
    remake = [{"ipId": ip_id, "name": name(ip_id)} for ip_id in _needs_remake(_spec(ctx, game), ips, assets)]
    if updated:
        text = (f"{', '.join(dict.fromkeys(u['name'] for u in updated))}의 최신 파일 {len(updated)}개를 이 게임에 "
                "반영했습니다. 게임 설정과 주소는 그대로이고 미리보기를 새로고침하면 보입니다. 예전 파일이 브라우저나 CDN에 "
                "남아 있으면 강력 새로고침이 필요하거나 길게는 하루 뒤에 바뀔 수 있습니다.")
    else:
        text = "이 게임은 이미 IP의 최신 그림·3D 모델·움직임 뼈대 파일을 쓰고 있습니다."
    if remake:
        text += (f" {', '.join(r['name'] for r in remake)}은(는) 이 게임을 만들 때 3D나 움직임 뼈대가 없어 납작한 그림 판이나 "
                 "뼈대 없는 모델로 들어가 있어 이 게임에서는 바뀌지 않습니다. 3D로 보이려면 게임을 다시 만들어야 합니다(get_game_spec으로 "
                 "spec을 읽어 make_game, base_game_id). 사용자에게 알리고 원하면 다시 만드세요.")
    return {"gameId": game["gameId"], "updated": updated, "needsRemake": remake, "message": text}


def _spec(ctx, game):
    """The game's spec.json, or None when it cannot be read (that game is left as it is)."""
    try:
        return json.loads(ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=game["specKey"])["Body"].read())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return None


def _keys(spec, ips, assets) -> dict:
    """{file in the game folder: S3 key it is copied from}, as make_game copies them for this spec now."""
    from server import tools  # tools imports this module
    try:
        return tools._game_asset_keys(spec, ips, assets) if spec else {}
    except Exception:  # noqa: BLE001 - e.g. a spec naming an IP that is gone: that game is left as it is
        traceback.print_exc()
        return {}


def _ip_files(spec, ips, assets) -> dict:
    """The game's files that are copies of IP assets (not the runtime's)."""
    keys = {a["key"] for a in assets.values()}
    return {name: src for name, src in _keys(spec, ips, assets).items() if src in keys}


def _needs_remake(spec, ips, assets) -> list:
    """IPs the game shows as a cutout or as an unrigged model although they now have 3D or a rig: a game made now
    would show those (another modelUrl, an animUrl), this one cannot. → ipIds in spec order."""
    from server import tools
    if not spec:
        return []
    three = spec.get("engine") == "three"
    glb = {i for i, ip in ips.items() if three and ip.get("glbAssetId") in assets}
    rig = {i for i, ip in ips.items() if three and ip.get("riggedGlbAssetId") in assets}
    now = _keys(gamespec.resolve_sprites(tools._unresolved(spec), ips, glb | rig, rig), ips, assets)
    have, owner = _keys(spec, ips, assets), {a["key"]: a.get("ipId") for a in assets.values()}
    return list(dict.fromkeys(owner[src] for file, src in now.items() if file not in have and owner.get(src)))


def _copy(ctx, src: str, dst: str) -> bool:
    """src over dst unless dst already holds the same bytes. → True if it copied."""
    s3, bucket = ctx.s3, ctx.assets_bucket
    head = s3.head_object(Bucket=bucket, Key=src)
    try:
        if s3.head_object(Bucket=bucket, Key=dst).get("ETag") == head.get("ETag"):
            return False
    except ClientError:
        pass  # not in the game folder yet: write it
    s3.copy_object(CopySource={"Bucket": bucket, "Key": src}, Bucket=bucket, Key=dst, MetadataDirective="REPLACE",
                   ContentType=head.get("ContentType") or "binary/octet-stream", CacheControl=NO_CACHE)
    return True
