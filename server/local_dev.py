"""Local dev server: the Lambda handler behind http.server on http://127.0.0.1:8787.

    LOCAL_DEV=1 python3 server/local_dev.py

Real AWS clients (default profile, env vars as in server/README.md). Every request is the fixed user
"local" (no Cognito); agent turns run in a background thread of this process instead of a Lambda self-invoke.
"""
from __future__ import annotations
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # repo root, for `server.` imports

from server import app, auth  # noqa: E402
from server.providers.base import Ctx  # noqa: E402

HOST, PORT = "127.0.0.1", int(os.environ.get("LOCAL_DEV_PORT", "8787"))  # web/vite.config.ts proxies /api to 8787
LOCAL_USER = {"sub": "local", "username": "local"}


class InlineLambda:
    """lambda:Invoke(InvocationType=Event) stand-in: runs the payload through the handler on a thread."""

    def invoke(self, FunctionName, InvocationType, Payload):
        threading.Thread(target=app.handler, args=(json.loads(Payload), None), daemon=True).start()
        return {"StatusCode": 202}


class Handler(BaseHTTPRequestHandler):
    def _serve(self):
        length = int(self.headers.get("content-length") or 0)
        path, _, query = self.path.partition("?")
        event = {"requestContext": {"http": {"method": self.command}}, "rawPath": path, "rawQueryString": query,
                 "headers": {k.lower(): v for k, v in self.headers.items()},
                 "body": self.rfile.read(length).decode() if length else None, "isBase64Encoded": False}
        resp = app.handler(event, None)
        data = resp["body"].encode()
        self.send_response(resp["statusCode"])
        for name, value in resp["headers"].items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PATCH = _serve


def main() -> None:
    if os.environ.get("LOCAL_DEV") != "1":
        sys.exit("Set LOCAL_DEV=1: this server skips Cognito and treats every request as user 'local'.")
    os.environ.setdefault("SELF_FUNCTION_NAME", "local")
    ctx = Ctx.from_env()
    ctx.lambda_ = InlineLambda()
    app.CTX = ctx
    auth.user_from_event = lambda ctx, event: LOCAL_USER
    print(f"IPverse API (local) http://{HOST}:{PORT}  table={ctx.table_name}  bucket={ctx.assets_bucket or '-'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
