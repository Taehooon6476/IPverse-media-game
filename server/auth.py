"""Cognito access token (X-Auth-Token header) → user, via cognito-idp:GetUser."""
from __future__ import annotations
import time

from botocore.exceptions import ClientError

CACHE_SEC = 300  # ponytail: bounded so an expired/revoked token stops working within 5 min on a warm Lambda
_CACHE: dict = {}  # token -> (user, expires_at)
_TRANSIENT = ("TooManyRequestsException", "InternalErrorException")


def user_from_event(ctx, event: dict):
    """{"sub", "username"} or None. Header names are matched case-insensitively."""
    token = next((v for k, v in (event.get("headers") or {}).items() if k.lower() == "x-auth-token"), None)
    if not token:
        return None
    hit = _CACHE.get(token)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        resp = ctx.cognito.get_user(AccessToken=token)
    except ClientError as e:
        if e.response["Error"]["Code"] in _TRANSIENT:
            raise  # a Cognito hiccup is a 500, not a forced re-login
        return None
    sub = next((a["Value"] for a in resp.get("UserAttributes", []) if a["Name"] == "sub"), None)
    if not sub:
        return None
    user = {"sub": sub, "username": resp["Username"]}
    _CACHE[token] = (user, time.time() + CACHE_SEC)
    return user
