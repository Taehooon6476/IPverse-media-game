"""A fake storyboard image GPU box behind its MCP proxy, on a fake clock (no network). It works like the real one
(see server/providers/mediagen_image.py): one job at a time in arrival order, GEN_SEC per image plus SWAP_SEC when a
job needs the other model, and a job that waited BUSY_SEC for the box fails with the proxy's real text."""
from __future__ import annotations
import json
import types
from datetime import datetime, timedelta, timezone

from server.providers import mcp_client

BUSY_TEXT = "RuntimeError: GPU server busy with other jobs for 10 minutes; try again later"


class Clock:
    """Fake seconds. `now()` for time.monotonic, `sleep()` for the old in-turn polling."""

    def __init__(self, t: float = 1000.0):
        self.t = t

    def now(self) -> float:
        return self.t

    def sleep(self, sec: float) -> None:
        self.t += sec


class FakeImageBox:
    """Replaces mcp_client._post and mcp_client.download. `starts` records every start_image call (duplicates show
    up there); `png(job)` gives the bytes the box returns for a job."""

    def __init__(self, clock: Clock, gen_sec=15.0, swap_sec=120.0, busy_sec=600.0, loaded="klein9", png=None):
        self.clock, self.gen_sec, self.swap_sec, self.busy_sec = clock, gen_sec, swap_sec, busy_sec
        self.loaded, self.free_at = loaded, 0.0
        self.jobs: dict = {}
        self.starts: list = []
        self.fail_next: list = []  # texts: the next start_image calls fail like this (busy at submit, a 502 ...)
        self.png = png or (lambda job: b"\x89PNG-" + job["id"].encode())

    def install(self, monkeypatch):
        monkeypatch.setattr(mcp_client, "_post", self)
        monkeypatch.setattr(mcp_client, "download", self.download)
        return self

    def _start(self, args):
        if self.fail_next:
            raise RuntimeError(f"start_image: {self.fail_next.pop(0)}")
        now = self.clock.now()
        job = {"id": f"g{len(self.starts) + 1}", "args": args, "submitted": now}
        self.starts.append(args)
        begin = max(now, self.free_at)
        if begin - now > self.busy_sec:  # never got the box: the proxy gives up on it
            job["failAt"] = now + self.busy_sec
        else:
            if args["model"] != self.loaded:
                begin += self.swap_sec
                self.loaded = args["model"]
            job["end"] = self.free_at = begin + self.gen_sec
        self.jobs[job["id"]] = job
        return {"job_id": job["id"], "status": "RUNNING", "model": args["model"]}

    def _status(self, job_id):
        job, now = self.jobs[job_id], self.clock.now()
        if "failAt" in job:
            return {"job_id": job_id, "status": "FAILED", "error": BUSY_TEXT} if now >= job["failAt"] \
                else {"job_id": job_id, "status": "RUNNING"}
        if now < job["end"]:
            return {"job_id": job_id, "status": "RUNNING"}
        return {"job_id": job_id, "status": "SUCCEEDED", "url": f"https://img.example/{job_id}.png",
                "seed": job["args"].get("seed") or 7, "ms": int(self.gen_sec * 1000), "size": [1216, 688]}

    def __call__(self, url, body, key):
        tool, args = body["params"]["name"], body["params"]["arguments"]
        out = self._start(args) if tool == "start_image" else self._status(args["job_id"])
        return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}}

    def download(self, url):
        return self.png(self.jobs[url.rsplit("/", 1)[1][:-4]])


def fake_time(monkeypatch, clock: Clock, *modules) -> None:
    """Item timestamps (store.now / age_sec) and each module's time.monotonic follow the fake clock."""
    from server import store
    base = datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc)

    def now(offset_ms: int = 0) -> str:
        t = base + timedelta(seconds=clock.now(), milliseconds=offset_ms)
        return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"

    def age_sec(ts: str) -> float:
        then = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return (base + timedelta(seconds=clock.now()) - then).total_seconds()

    monkeypatch.setattr(store, "now", now)
    monkeypatch.setattr(store, "age_sec", age_sec)
    for module in modules:
        monkeypatch.setattr(module, "time", types.SimpleNamespace(monotonic=clock.now, sleep=clock.sleep))
