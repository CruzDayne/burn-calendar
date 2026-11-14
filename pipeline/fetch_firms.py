#!/usr/bin/env python3
"""
Download FIRMS archive hotspots for a bounding box via the FIRMS area API (needs a free MAP_KEY:
https://firms.modaps.eosdis.nasa.gov/api/map_key/).  Writes one CSV per source and chunk into --out.

    export FIRMS_MAP_KEY=xxxxxxxx
    python3 fetch_firms.py --bbox -124.5,32,-114,42 --start 2000-11-01 --end 2026-11-12 --out raw/california

NOTE: written against the documented endpoint
  /api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}/{START_DATE}
and NOT run in the authoring sandbox (FIRMS was unreachable there). Check the API page for current source names,
the maximum DAY_RANGE (5 in the current docs) and your transaction quota, then adjust SOURCES / --day-range.
For whole countries or the full record, the 'Archive Download' page on FIRMS is usually quicker than this API.
Use *_SP (standard processing, ~2-3 month latency) for history and *_NRT for the most recent weeks.
"""
import argparse, datetime as dt, os, sys, time, urllib.request, urllib.error

BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
# (source, first date available). Verify these against the FIRMS data-availability page.
SOURCES = [
    ("MODIS_SP", "2000-11-01"),
    ("VIIRS_SNPP_SP", "2012-01-20"),
    ("VIIRS_NOAA20_SP", "2018-04-01"),
    ("MODIS_NRT", None), ("VIIRS_SNPP_NRT", None), ("VIIRS_NOAA20_NRT", None), ("VIIRS_NOAA21_NRT", None),
]


def fetch(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and k < tries - 1:
                time.sleep(15 * (k + 1)); continue
            raise
        except urllib.error.URLError:
            if k < tries - 1: time.sleep(5 * (k + 1)); continue
            raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True, help="west,south,east,north")
    ap.add_argument("--start", default="2000-11-01"); ap.add_argument("--end", default=dt.date.today().isoformat())
    ap.add_argument("--out", required=True); ap.add_argument("--day-range", type=int, default=5)
    ap.add_argument("--sources", nargs="*", default=[s for s, _ in SOURCES if s.endswith("_SP")])
    ap.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    a = ap.parse_args()
    if not a.key: sys.exit("set FIRMS_MAP_KEY or pass --key")
    os.makedirs(a.out, exist_ok=True)
    first = dict(SOURCES)
    for src in a.sources:
        d0 = max(dt.date.fromisoformat(a.start), dt.date.fromisoformat(first.get(src) or a.start))
        d1 = dt.date.fromisoformat(a.end); cur = d0; n = 0
        path = os.path.join(a.out, f"{src}.csv")
        with open(path, "w") as out:
            header_done = False
            while cur <= d1:
                span = min(a.day_range, (d1 - cur).days + 1)
                txt = fetch(f"{BASE}/{a.key}/{src}/{a.bbox}/{span}/{cur.isoformat()}")
                lines = txt.strip().splitlines()
                if lines and lines[0].startswith("latitude"):
                    if not header_done: out.write(lines[0] + "\n"); header_done = True
                    out.write("\n".join(lines[1:]) + ("\n" if len(lines) > 1 else ""))
                elif lines: print("unexpected response:", lines[0][:120], file=sys.stderr)
                cur += dt.timedelta(days=span); n += 1
                if n % 50 == 0: print(src, cur, flush=True)
        print("wrote", path)


if __name__ == "__main__":
    main()
