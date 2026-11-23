#!/usr/bin/env python3
"""List the GLB models (and license line) inside official Kenney packs, without saving or executing anything.

  python3 scripts/list_kenney_packs.py nature-kit castle-kit space-kit ...
"""
import http.cookiejar
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import zipfile

LIMIT = 60 * 1024 * 1024


def archive(pack):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]
    page = "https://kenney.nl/assets/" + pack
    html = opener.open(page, timeout=25).read().decode("utf-8")
    download_id = re.search(r'data-download-id=["\']([a-f0-9]+)', html).group(1)
    req = urllib.request.Request("https://kenney.nl/download-link/" + download_id,
                                 headers={"Referer": page, "Origin": "https://kenney.nl", "Accept": "application/json"})
    link = json.load(opener.open(req, timeout=25))["url"]
    host = urllib.parse.urlsplit(link).hostname or ""
    if not (host == "kenney.nl" or host.endswith(".kenney.nl")):
        raise ValueError(f"unexpected download host {host}")
    with opener.open(link, timeout=60) as r:
        blob = r.read(LIMIT + 1)
    if len(blob) > LIMIT:
        raise ValueError("archive too large")
    return zipfile.ZipFile(io.BytesIO(blob)), len(blob)


for pack in sys.argv[1:]:
    try:
        z, size = archive(pack)
    except Exception as e:  # noqa: BLE001
        print(f"## {pack}: FAILED {e}")
        continue
    names = z.namelist()
    lic = next((n for n in names if n.lower().endswith("license.txt")), None)
    cc0 = lic and b"CC0" in z.read(lic)
    glbs = sorted(n.rsplit("/", 1)[1][:-4] for n in names if n.lower().endswith(".glb"))
    print(f"## {pack}: {size // 1024} KB, CC0={bool(cc0)}, {len(glbs)} GLB")
    print(" ".join(glbs))
