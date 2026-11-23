#!/usr/bin/env python3
"""Live-stream check for a broadcast that is on air (start it from the play window: 방송 시작): poll /live until
the IVS stream is live, then watch the IVS playlist as a viewer until IVS stitches an ad break into it (trailer
broadcasts: DATERANGE CLASS="live-video-net-stitched-ad-break-start"), or until a playable card goes out
(playable broadcasts: a "playable" entry in the break log; the card itself rides on timed metadata).

  python3 scripts/live_e2e.py SESSION_ID [--stop]

Prints a line per check and saves playlists to build/live-e2e/. --stop ends the broadcast afterwards.
"""
import pathlib
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from smoke import api_call, cognito_login, get_secret  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "build" / "live-e2e"
OUT.mkdir(parents=True, exist_ok=True)
STITCHED = 'CLASS="live-video-net-stitched-ad-break-start"'


def fetch(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return r.read().decode()


def main():
    sid = sys.argv[1]
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    token = cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"])
    call = lambda m, p, b=None: api_call(base, m, p, token, b)  # noqa: E731

    t0, media_url, result, beat = time.time(), None, 1, 0
    while time.time() - t0 < 1500:
        st = call("GET", f"/api/sessions/{sid}/live")
        stream, job = st.get("stream") or {}, st.get("job") or {}
        breaks = stream.get("breaks") or []
        print(f"[{int(time.time() - t0)}s] active={st['active']} ivs={st['channelState']} adInsertion={st.get('adInsertion')} "
              f"adType={job.get('adType')} rounds={stream.get('rounds')} breaks={len(breaks)}", flush=True)
        if not st["active"]:
            print("FAIL no broadcast on air for this session (start it in the play window)", flush=True)
            return 1
        if job.get("adType") == "playable" and any(b.get("playable") for b in breaks):
            print("PASS playable card sent (timed metadata):", breaks[-1], flush=True)
            result = 0
            break
        if st["channelState"] == "RUNNING":
            if time.time() - beat > 15:  # this script watches the stream: MediaTailor can be shown new creatives now
                call("POST", f"/api/sessions/{sid}/live/viewer", {})
                beat = time.time()
            if not media_url:  # one viewer session: keep its media playlist
                master = fetch(st["playbackUrl"])
                media_url = urllib.parse.urljoin(st["playbackUrl"], next(l for l in master.splitlines() if l and not l.startswith("#")))
            media = fetch(media_url)
            stamp = int(time.time() - t0)
            (OUT / f"media-{stamp}.m3u8").write_text(media)
            hit = next((l for l in media.splitlines() if STITCHED in l), None)
            if hit:
                print("PASS IVS stitched the MediaTailor ad into the live playlist:", hit[:220], flush=True)
                (OUT / "media-with-ad.m3u8").write_text(media)
                result = 0
                break
        time.sleep(4)
    else:
        print("FAIL no ad break seen", flush=True)
    if "--stop" in sys.argv:
        call("DELETE", f"/api/sessions/{sid}/live")
    return result


if __name__ == "__main__":
    sys.exit(main())
