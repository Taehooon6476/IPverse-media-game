"""DynamoDB single-table access (`ipverse-main`, pk/sk). Items in and out are plain JSON-able dicts."""
from __future__ import annotations
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

DEFAULT_TITLE = "새 세션"
DEFAULT_GENRE = "sf-shooter"
_GROUPS = {"MSG": "messages", "IP": "ips", "ASSET": "assets", "JOB": "jobs", "GAME": "games"}


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def now(offset_ms: int = 0) -> str:
    """UTC ISO-8601 with milliseconds and Z, like JS toISOString(); sorts as text."""
    t = datetime.now(timezone.utc) + timedelta(milliseconds=offset_ms)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def public_url(ctx, key: str) -> str:
    """CDN_DOMAIN can be empty (CloudFormation cycle); the SPA and games share the CloudFront origin."""
    return f"https://{ctx.cdn_domain}/{key}" if ctx.cdn_domain else f"/{key}"


def age_sec(ts: str) -> float:
    then = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - then).total_seconds()


def _num(v):
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    raise TypeError(f"not JSON serializable: {type(v).__name__}")


def plain(obj):
    """DynamoDB Decimals → int/float (for JSON responses and Converse documents)."""
    return json.loads(json.dumps(obj, default=_num))


def _ddb(obj):
    """floats → Decimal: boto3 rejects Python floats (e.g. ffprobe's trailer seconds)."""
    return json.loads(json.dumps(obj, default=_num), parse_float=Decimal)


def _pk(session_id: str) -> str:
    return f"SESSION#{session_id}"


def _index_key(session: dict) -> tuple:
    return f"USER#{session['userSub']}", f"SESSION#{session['createdAt']}#{session['sessionId']}"


def _strip(item: dict) -> dict:
    return plain({k: v for k, v in item.items() if k not in ("pk", "sk")})


def _put(ctx, pk: str, sk: str, item: dict) -> dict:
    ctx.table.put_item(Item=_ddb({**item, "pk": pk, "sk": sk}))
    return item


def _get(ctx, pk: str, sk: str):
    item = ctx.table.get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True).get("Item")
    return _strip(item) if item else None


def _update(ctx, pk: str, sk: str, fields: dict, expect: dict = None) -> bool:
    """SET the given fields. With `expect={attr: value}` only if the item has that value right now
    (`{attr: None}`: only if the attribute is absent); returns False when the condition fails."""
    names = {f"#f{i}": k for i, k in enumerate(fields)}
    values = {f":f{i}": v for i, v in enumerate(fields.values())}
    kwargs = {"Key": {"pk": pk, "sk": sk}, "UpdateExpression": "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields)))}
    if expect:
        [(attr, value)] = expect.items()
        names["#c"] = attr
        if value is None:
            kwargs["ConditionExpression"] = "attribute_not_exists(#c)"
        else:
            values[":c"] = value
            kwargs["ConditionExpression"] = "#c = :c"
    try:
        ctx.table.update_item(ExpressionAttributeNames=names, ExpressionAttributeValues=_ddb(values), **kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _delete(ctx, pk: str, sk: str, expect: dict) -> bool:
    """Delete the item only if it has `expect={attr: value}` right now; False when it has not (or is gone)."""
    [(attr, value)] = expect.items()
    try:
        ctx.table.delete_item(Key={"pk": pk, "sk": sk}, ConditionExpression="#c = :c",
                              ExpressionAttributeNames={"#c": attr}, ExpressionAttributeValues=_ddb({":c": value}))
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _query(ctx, pk: str, forward: bool = True) -> list:
    kwargs = {"KeyConditionExpression": Key("pk").eq(pk), "ScanIndexForward": forward, "ConsistentRead": True}
    items = []
    while True:
        resp = ctx.table.query(**kwargs)
        items += resp.get("Items", [])
        if "LastEvaluatedKey" not in resp:
            return items
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


# ── sessions ───────────────────────────────────────────────────────────────────

def put_session(ctx, sub: str, title: str = None, genre: str = None) -> dict:
    ts = now()
    session = {"sessionId": new_id("ses"), "userSub": sub, "title": title or DEFAULT_TITLE,
               "genre": genre or DEFAULT_GENRE, "concept": None, "createdAt": ts, "updatedAt": ts}
    _put(ctx, _pk(session["sessionId"]), "META", session)
    _put(ctx, *_index_key(session), {k: session[k] for k in ("sessionId", "title", "genre", "createdAt")})
    return session


def get_session(ctx, session_id: str):
    return _get(ctx, _pk(session_id), "META")


def update_session(ctx, session: dict, **fields) -> dict:
    fields["updatedAt"] = now()
    _update(ctx, _pk(session["sessionId"]), "META", fields)
    listed = {k: fields[k] for k in ("title", "genre") if k in fields}
    if listed:  # keep the sidebar index in step
        _update(ctx, *_index_key(session), listed)
    session.update(fields)
    return session


def set_lang(ctx, session: dict, lang: str) -> None:
    """The language of the latest request that started work in the session (server/i18n.py remember): for what the
    server writes into the session outside a request. Not an edit of the session: updatedAt stays."""
    _update(ctx, _pk(session["sessionId"]), "META", {"lang": lang})
    session["lang"] = lang


def list_sessions(ctx, sub: str) -> list:
    return [_strip(i) for i in _query(ctx, f"USER#{sub}", forward=False)]  # newest first


# ── session children ───────────────────────────────────────────────────────────

def put_message(ctx, session_id: str, role: str, text: str, status: str, ts: str = None) -> dict:
    ts = ts or now()
    message = {"messageId": new_id("msg"), "role": role, "text": text, "status": status, "toolEvents": [], "ts": ts}
    return _put(ctx, _pk(session_id), f"MSG#{ts}#{message['messageId']}", message)


def update_message(ctx, session_id: str, message: dict, expect: dict = None, **fields) -> bool:
    ok = _update(ctx, _pk(session_id), f"MSG#{message['ts']}#{message['messageId']}", fields, expect)
    if ok:
        message.update(fields)
    return ok


def _put_child(ctx, session_id: str, kind: str, id_field: str, item: dict) -> dict:
    item.setdefault("createdAt", now())
    return _put(ctx, _pk(session_id), f"{kind}#{item[id_field]}", item)


def put_ip(ctx, session_id: str, ip: dict) -> dict:
    return _put_child(ctx, session_id, "IP", "ipId", ip)


def get_ip(ctx, session_id: str, ip_id: str):
    return _get(ctx, _pk(session_id), f"IP#{ip_id}")


def update_ip(ctx, session_id: str, ip_id: str, **fields) -> bool:
    return _update(ctx, _pk(session_id), f"IP#{ip_id}", fields)


def put_asset(ctx, session_id: str, asset: dict) -> dict:
    """asset = {kind, key, contentType, meta?, ipId?, jobId?, assetId?}; fills id, url, meta, createdAt."""
    asset.setdefault("assetId", new_id("ast"))
    asset.setdefault("meta", {})
    asset["url"] = public_url(ctx, asset["key"])
    return _put_child(ctx, session_id, "ASSET", "assetId", asset)


def put_job(ctx, session_id: str, job: dict) -> dict:
    return _put_child(ctx, session_id, "JOB", "jobId", job)


def get_job(ctx, session_id: str, job_id: str):
    return _get(ctx, _pk(session_id), f"JOB#{job_id}")


def update_job(ctx, session_id: str, job_id: str, expect: dict = None, **fields) -> bool:
    return _update(ctx, _pk(session_id), f"JOB#{job_id}", fields, expect)


# The sessions that hold a queued or running job, one small item each under one partition: what the scheduled advance
# reads every minute (server/jobs.py advance_active) instead of scanning the table.
ACTIVE_PK = "JOBSACTIVE"


def mark_active(ctx, session_id: str) -> None:
    """Written before the job it stands for (a mark with no job is harmless, a job with no mark waits for a tab);
    each write renews `at`, which is what clear_active checks."""
    _put(ctx, ACTIVE_PK, _pk(session_id), {"sessionId": session_id, "at": now()})


def active_sessions(ctx) -> list:
    """[{sessionId, at}]: one read of one partition; empty when nothing is in flight anywhere."""
    return [_strip(i) for i in _query(ctx, ACTIVE_PK)]


def clear_active(ctx, mark: dict) -> bool:
    """The session's last job settled. Only the mark that was read goes: one renewed since (a job created while the
    caller looked) stays, so that job is not left without one."""
    return _delete(ctx, ACTIVE_PK, _pk(mark["sessionId"]), expect={"at": mark["at"]})


def put_game(ctx, session_id: str, game: dict) -> dict:
    return _put_child(ctx, session_id, "GAME", "gameId", game)


def get_game(ctx, session_id: str, game_id: str):
    return _get(ctx, _pk(session_id), f"GAME#{game_id}")


def update_game(ctx, session_id: str, game_id: str, **fields) -> bool:
    return _update(ctx, _pk(session_id), f"GAME#{game_id}", fields)


def snapshot(ctx, session_id: str) -> dict:
    """{session, messages, ips, assets, jobs, games}, each list oldest first."""
    snap = {"session": None, **{group: [] for group in _GROUPS.values()}}
    for item in _query(ctx, _pk(session_id)):
        sk = item["sk"]
        if sk == "META":
            snap["session"] = _strip(item)
        elif sk.split("#")[0] in _GROUPS:
            snap[_GROUPS[sk.split("#")[0]]].append(_strip(item))
    for group in _GROUPS.values():
        snap[group].sort(key=lambda i: i.get("createdAt") or i.get("ts", ""))
    return snap


def _delete_prefix(ctx, prefix: str, bucket: str = None) -> list:
    """Every object under the prefix (of the assets bucket unless another is named), a list page (≤1000 keys) at a
    time; nothing there is not an error. → the Errors of the keys S3 refused: DeleteObjects answers 200 with them."""
    bucket, refused = bucket or ctx.assets_bucket, []
    kwargs = {"Bucket": bucket, "Prefix": prefix}
    while True:
        page = ctx.s3.list_objects_v2(**kwargs)
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if keys:
            refused += ctx.s3.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True}).get("Errors") or []
        if not page.get("IsTruncated"):
            return refused
        kwargs["ContinuationToken"] = page["NextContinuationToken"]


def _scratch(ctx, job: dict) -> list:
    """(bucket, prefix)s of what a 3D job keeps outside sessions/<id>/, under its own id: the GPU box's input and
    output (server/providers/img3d.py), what the Deadline farm was handed and wrote (deadline.py, rig.py). collect()
    copies the results into the session and leaves these, and nothing else expires them."""
    job_id, provider = job.get("jobId"), job.get("provider")
    if not job_id:
        return []
    if provider == "img3d":
        return [(ctx.assets_bucket, f"img3d/in/{job_id}.png"), (ctx.assets_bucket, f"img3d/out/{job_id}/")]
    if provider in ("deadline", "rig", "griptape_deadline"):
        return [(ctx.queue_bucket, f"{ctx.queue_prefix}/{job_id}/")]
    return []


# Wildcard paths of one delete's CloudFront invalidation. CloudFront keeps at most 15 wildcard paths in progress at a
# time and refuses a batch that would pass that (Service Quotas L-DAD40481); three leaves room for five deletes in a
# row.
CDN_MAX_PATHS = 3
_distribution: dict = {}  # SSM parameter name → the CloudFront distribution's id, per process


def _cloudfront(ctx):
    """The injected client, else one that gives up in seconds: the delete waits on it inside a request."""
    if getattr(ctx, "cloudfront", None) is None:
        import boto3
        from botocore.config import Config
        ctx.cloudfront = boto3.client("cloudfront", region_name="us-east-1", config=Config(
            connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 2}))
    return ctx.cloudfront


def _invalidate(ctx, sid: str, game_ids) -> None:
    """One CloudFront invalidation for a deleted session's folder and its games' folders: /sessions/* and /games/*
    keep a file without Cache-Control for a day. A session with CDN_MAX_PATHS games or more names all of /games/
    instead (the other games' files are then fetched again from the bucket). Not sent or refused: logged, the
    session goes."""
    games = [f"/games/{game_id}/*" for game_id in sorted(game_ids)]
    paths = [f"/sessions/{sid}/*"] + (games if len(games) < CDN_MAX_PATHS else ["/games/*"])
    try:
        param = os.environ["CDN_DISTRIBUTION_PARAM"]  # the stack names it; unit tests and local dev have none
        if param not in _distribution:
            _distribution[param] = ctx.ssm.get_parameter(Name=param)["Parameter"]["Value"]
        _cloudfront(ctx).create_invalidation(DistributionId=_distribution[param], InvalidationBatch={
            "Paths": {"Quantity": len(paths), "Items": paths}, "CallerReference": new_id(sid)})
    except Exception as e:  # noqa: BLE001 — the session still goes
        print(f"delete_session {sid}: no CloudFront invalidation of {' '.join(paths)} ({type(e).__name__}: {e}); "
              "an edge's copy of a file under them is served until it expires, a day at most")


# What a delete leaves at the address of each game it had published, in place of the game: without it a share link
# shows S3's raw "AccessDenied" XML (the distribution has no error pages: they would replace the API's own 403 and
# 404 answers too). Self-contained: the folder's stylesheet and scripts are gone with the game. The colours are the
# studio's (web/src/styles.css).
TOMBSTONE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>삭제된 게임 · IPverse</title>
<style>
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; background: #10120f; color: #ecede6; text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif; }
main { max-width: 26em; padding: 24px; }
h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.35; }
p { margin: 0 0 28px; color: #9aa190; font-size: 16px; line-height: 1.6; }
a { display: inline-block; padding: 12px 20px; border-radius: 8px; background: #d0ef98; color: #1b2112;
  font-size: 16px; font-weight: 700; line-height: 24px; text-decoration: none; }
a:focus-visible { outline: 3px solid #ecede6; outline-offset: 3px; }
</style>
</head>
<body>
<main>
<h1>이 게임은 삭제됐어요</h1>
<p>만든 사람이 게임을 지워서 더는 플레이할 수 없어요.</p>
<a href="/">IPverse Studio로 가기</a>
</main>
</body>
</html>
"""


def bury_ad(ctx, ad_id: str) -> None:
    """A playable ad whose game is gone: everything it held goes (its record's fields, the names its pages gave their
    starts) and one small record stays under its key, {adId, gone, goneAt}, by which its address answers "삭제됐어요"
    at every visit (server/playable.py _record).
    ponytail: the small records stay for good (the table has no expiry); a demo's handful."""
    for row in _query(ctx, f"AD#{ad_id}"):
        if row["sk"] != "META":
            ctx.table.delete_item(Key={"pk": row["pk"], "sk": row["sk"]})
    _put(ctx, f"AD#{ad_id}", "META", {"adId": ad_id, "gone": True, "goneAt": now()})


def delete_session(ctx, session: dict) -> None:
    """The session's files (sessions/<id>/, games/<gameId>/ of its games, its 3D jobs' scratch), the edges' copies of
    them, its playable ads, every item under its pk, its sidebar index item, META last: a delete that dies part way
    is finished by the next one (the owner check reads META; the job items, the only record of where the scratch is,
    the game items, the only record of the games' folders, and the pointers to its ads go after what they point
    at). A game that was published keeps one file at its address: the page that says it was deleted (TOMBSTONE); a
    playable ad keeps one small record that says the same to its link (bury_ad)."""
    sid = session["sessionId"]
    items = _query(ctx, _pk(sid))
    games = [i for i in items if i["sk"].startswith("GAME#") and i.get("gameId")]
    game_ids = {i["gameId"] for i in games}
    for game in games:
        _delete_prefix(ctx, f"games/{game['gameId']}/")
        if game.get("publishedUrl"):  # once the folder is empty, and before the edges are told (_invalidate)
            ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=f"games/{game['gameId']}/index.html",
                              Body=TOMBSTONE.encode(), ContentType="text/html; charset=utf-8", CacheControl="no-cache")
    for job in (i for i in items if i["sk"].startswith("JOB#")):
        for bucket, prefix in _scratch(ctx, job):
            refused = _delete_prefix(ctx, prefix, bucket)
            if refused:  # a role without s3:DeleteObject there: the copies stay, the session still goes
                print(f"delete_session {sid}: {len(refused)} objects left under s3://{bucket}/{prefix} "
                      f"({refused[0].get('Code')})")
    _delete_prefix(ctx, f"sessions/{sid}/")
    _invalidate(ctx, sid, game_ids)  # after the files: an edge that asks again finds nothing to keep
    # Its playable ads (pk AD#<adId>), by the pointers server/playable.py create keeps under the session: what the ad
    # held goes, so its public link cannot start a paid stream; what stays says that it is gone (bury_ad)
    for pointer in (i for i in items if i["sk"].startswith("AD#")):
        bury_ad(ctx, pointer["sk"].split("#", 1)[1])
    for item in items:
        if item["sk"] != "META":
            ctx.table.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
    ctx.table.delete_item(Key=dict(zip(("pk", "sk"), _index_key(session))))
    ctx.table.delete_item(Key={"pk": _pk(sid), "sk": "META"})
