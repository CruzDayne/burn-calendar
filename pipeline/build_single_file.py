#!/usr/bin/env python3
"""Bundle web/ (app + Leaflet + gzipped data tiles) into ONE html file that opens by double-click: web/dist/burn-calendar.html"""
import base64, gzip, json, os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
rd = lambda p: open(os.path.join(root, p), encoding="utf-8").read()
meta = json.load(open(os.path.join(root, "data", "meta.json")))
tiles = {}
for k in meta["tiles"]:
    raw = open(os.path.join(root, "data", "tiles", k + ".bin"), "rb").read()
    tiles[k] = base64.b64encode(gzip.compress(raw, 9)).decode()
html = rd("index.html")
import re
html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', lambda m: "<style>" + rd(m.group(1)) + "</style>", html)
embed = "<script>window.__EMBED=" + json.dumps({"meta": meta, "tiles": tiles}, separators=(",", ":")) + ";</script>"
first = [True]
def inline(m):
    code = rd(m.group(1)).replace("</script", "<\\/script")
    pre = embed if first[0] else ""
    first[0] = False
    return pre + "<script>" + code + "</script>"
html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
os.makedirs(os.path.join(root, "dist"), exist_ok=True)
out = os.path.join(root, "dist", "burn-calendar.html")
open(out, "w", encoding="utf-8").write(html)
print(out, round(len(html) / 1e6, 2), "MB")
