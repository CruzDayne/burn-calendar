#!/usr/bin/env python3
"""
Generate SYNTHETIC FIRMS-format hotspot CSVs (MODIS Terra/Aqua + VIIRS SNPP/NOAA-20/NOAA-21) for four regions,
plus a ground-truth file. NOT real fire data. Purpose: exercise and validate harmonize.py end-to-end when
NASA FIRMS is unreachable, with a known truth to score the harmonization against.

Latent truth: lambda_V[cell, month] = expected VIIRS-375m detections per satellite-equivalent.
Sensor model: MODIS sees lambda_V / r  (r ~ 2.2 with tile-level and seasonal variation, mild saturation),
Terra = 0.8x and Aqua = 1.2x the MODIS mean; low-confidence rows (~12%) and static sources are added.
"""
import argparse, calendar, datetime as dt, json, os
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
RES, T = 0.25, 20
DATA_END = dt.date(2026, 11, 12)

REGIONS = {
    "California":      dict(bbox=(33, -123, 42, -115),   peak=8.0, kappa=1.7, ratio_peak=8,
                            ev=[("2008-06", "2008-09", 2.2), ("2012-08", "2012-10", 1.6), ("2015-07", "2015-09", 1.5),
                                ("2017-10", "2017-12", 2.0), ("2018-07", "2018-11", 2.6), ("2020-08", "2020-10", 3.2),
                                ("2021-07", "2021-09", 2.2), ("2024-07", "2024-09", 1.8), ("2026-10", "2026-11", 2.4)]),
    "Iberia":          dict(bbox=(36.5, -9.5, 43.5, -2),  peak=6.8, kappa=2.4, ratio_peak=2,
                            ev=[("2003-07", "2003-09", 2.4), ("2005-07", "2005-09", 2.0), ("2012-07", "2012-09", 1.8),
                                ("2017-06", "2017-10", 2.8), ("2022-07", "2022-08", 2.3), ("2025-08", "2025-08", 2.6)]),
    "SE Australia":    dict(bbox=(-38, 142, -31, 152),    peak=0.5, kappa=1.9, ratio_peak=0,
                            ev=[("2002-12", "2003-02", 1.9), ("2006-12", "2007-02", 1.8), ("2009-01", "2009-02", 3.0),
                                ("2019-12", "2020-02", 3.8), ("2023-12", "2024-02", 1.4)]),
    "Amazon arc":      dict(bbox=(-12, -60, -4, -50),     peak=8.0, kappa=2.2, ratio_peak=9,
                            ev=[("2005-08", "2005-10", 1.9), ("2007-08", "2007-10", 1.8), ("2009-01", "2014-12", 0.65),
                                ("2010-08", "2010-10", 2.3), ("2019-08", "2019-09", 1.9), ("2020-07", "2020-10", 1.6),
                                ("2024-08", "2024-10", 2.4)]),
}
SATS = {  # name: (family, start, end, FIRMS label, sensitivity vs family mean)
    "Terra":  ("MODIS", "2000-11-01", None, "Terra", 0.8),
    "Aqua":   ("MODIS", "2002-07-04", None, "Aqua", 1.2),
    "SNPP":   ("VIIRS", "2012-01-20", None, "N", 1.0),
    "NOAA20": ("VIIRS", "2018-04-01", None, "N20", 1.0),
    "NOAA21": ("VIIRS", "2024-01-17", None, "N21", 1.0),
}
NM = (DATA_END.year - 2000) * 12 + DATA_END.month - 1 - 10 + 1


def ym(i):
    t = i + 10
    return 2000 + t // 12, t % 12 + 1


def midx(s):
    y, m = s.split("-"); return (int(y) - 2000) * 12 + int(m) - 1 - 10


def active_range(info, y, mo):
    s = dt.date.fromisoformat(info[1]); nd = calendar.monthrange(y, mo)[1]
    a = max(dt.date(y, mo, 1), s); b = min(dt.date(y, mo, nd), DATA_END)
    if info[2]: b = min(b, dt.date.fromisoformat(info[2]))
    return (a.day, b.day, nd) if b >= a else None


def build_truth(rng, name, R, scale):
    S, W, N, E = R["bbox"]
    row0, row1 = int(np.floor((S + 90) / RES)), int(np.floor((N + 90) / RES))
    col0, col1 = int(np.floor((W + 180) / RES)), int(np.floor((E + 180) / RES))
    rows, cols = np.meshgrid(np.arange(row0, row1), np.arange(col0, col1), indexing="ij")
    rows, cols = rows.ravel(), cols.ravel(); nc = len(rows)
    y = (rows - row0) / max(1, row1 - row0 - 1); x = (cols - col0) / max(1, col1 - col0 - 1)
    field = np.full(nc, 0.15)
    for _ in range(7):
        cy, cx, sg, amp = rng.random(), rng.random(), 0.1 + 0.2 * rng.random(), 0.5 + 2 * rng.random()
        field += amp * np.exp(-(((y - cy) ** 2 + (x - cx) ** 2) / (2 * sg ** 2)))
    b = field * rng.lognormal(0, 0.9, nc)
    b[b < np.quantile(b, 0.3)] = 0
    b *= (scale / 12) / b.mean()
    peak = np.clip(R["peak"] + rng.normal(0, 0.45, nc), 0, 11.99)
    cm = np.arange(12)[None, :]
    d = np.minimum(np.abs(cm - peak[:, None]), 12 - np.abs(cm - peak[:, None]))
    prof = np.exp(R["kappa"] * np.cos(2 * np.pi * d / 12)); prof /= prof.mean(1, keepdims=True)
    # region-wide AR(1) monthly anomaly + events
    z = np.zeros(NM); phi = 0.55
    for t in range(1, NM): z[t] = phi * z[t - 1] + np.sqrt(1 - phi ** 2) * rng.normal()
    yf = np.exp(0.33 * z)
    for a, bb, mult in R["ev"]:
        yf[max(0, midx(a)):min(NM, midx(bb) + 1)] *= mult
    cell_year = np.exp(0.22 * rng.normal(size=(nc, NM // 12 + 2)))
    mi = np.arange(NM); cal = np.array([ym(m)[1] - 1 for m in mi]); yr = np.array([ym(m)[0] - 2000 for m in mi])
    lam = b[:, None] * prof[:, cal] * yf[None, :] * cell_year[:, yr]
    if name == "California": lam *= (1.015 ** yr)[None, :]
    # MODIS/VIIRS ratio by 5-deg tile and calendar month
    tr, tc = rows // T, cols // T
    keys = np.unique(tr * 1000 + tc); eta = {k: rng.normal() for k in keys}
    r_tile = np.array([2.2 * np.exp(0.25 * eta[k]) for k in (tr * 1000 + tc)])
    seas = 1 + 0.35 * np.cos(2 * np.pi * (cm - R["ratio_peak"]) / 12)
    ratio = r_tile[:, None] * seas[:, cal]
    modis_mean = lam / ratio * (1 + lam / 150.0) ** -0.12
    return dict(rows=rows, cols=cols, lam=lam.astype(np.float32), modis_mean=modis_mean)


def emit(rng, name, R, tr, sat, info, out_dir):
    fam, _, _, label, sens = info
    base = tr["lam"] if fam == "VIIRS" else tr["modis_mean"] * sens
    rows, cols = tr["rows"], tr["cols"]
    chunks = []
    for m in range(NM):
        y, mo = ym(m); ar = active_range(info, y, mo)
        if not ar: continue
        a, b, nd = ar; frac = (b - a + 1) / nd
        mu = base[:, m] * frac
        for lowconf, factor in ((False, 1.0), (True, 0.12)):
            n = rng.poisson(mu * factor); tot = int(n.sum())
            if tot == 0: continue
            ci = np.repeat(np.arange(len(n)), n)
            lat = rows[ci] * RES - 90 + rng.random(tot) * RES
            lon = cols[ci] * RES - 180 + rng.random(tot) * RES
            day = rng.integers(a, b + 1, tot)
            if fam == "MODIS":
                conf = rng.integers(0, 30, tot) if lowconf else rng.integers(30, 101, tot)
            else:
                conf = np.array(["l"] * tot) if lowconf else rng.choice(["n", "h"], tot, p=[0.8, 0.2])
            chunks.append(pd.DataFrame({"latitude": lat.round(4), "longitude": lon.round(4),
                                        "acq_date": [f"{y}-{mo:02d}-{d:02d}" for d in day],
                                        "confidence": conf}))
    df = pd.concat(chunks, ignore_index=True)
    # static land sources (type 2) that must be filtered out
    S, W, N, E = R["bbox"]
    days = pd.date_range(max(pd.Timestamp(info[1]), pd.Timestamp("2000-11-01")), pd.Timestamp(DATA_END), freq="3D")
    stat = pd.DataFrame([{"latitude": S + (N - S) * (0.3 + 0.2 * k), "longitude": W + (E - W) * (0.4 + 0.1 * k),
                          "acq_date": d.strftime("%Y-%m-%d"), "confidence": 100 if fam == "MODIS" else "h"}
                         for k in range(3) for d in days])
    df["type"] = 0; stat["type"] = 2
    df = pd.concat([df, stat], ignore_index=True)
    n = len(df)
    df["acq_time"] = rng.choice(["1030", "1330", "2230", "0130"], n)
    df["satellite"] = label
    df["instrument"] = fam
    df["version"] = "6.1NRT" if fam == "MODIS" else "2.0NRT"
    df["frp"] = rng.lognormal(1.5, 1.0, n).round(1)
    df["daynight"] = np.where(df.acq_time.isin(["1030", "1330"]), "D", "N")
    bt = "brightness" if fam == "MODIS" else "bright_ti4"
    df[bt] = rng.uniform(305, 400, n).round(1)
    df["scan"] = 1.0; df["track"] = 1.0
    df = df[["latitude", "longitude", bt, "scan", "track", "acq_date", "acq_time", "satellite", "instrument",
             "confidence", "version", "frp", "daynight", "type"]]
    path = os.path.join(out_dir, f"{name.lower().replace(' ', '_')}_{sat}.csv.gz")
    df.to_csv(path, index=False, compression="gzip")
    return len(df)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "demo_raw"))
    ap.add_argument("--scale", type=float, default=6.0, help="mean annual VIIRS detections per cell (all cells)")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(a.seed)
    truth, total = {}, 0
    for name, R in REGIONS.items():
        tr = build_truth(rng, name, R, a.scale)
        truth[name] = tr
        for sat, info in SATS.items():
            total += emit(rng, name, R, tr, sat, info, a.out)
        print(f"{name}: {len(tr['rows'])} cells", flush=True)
    np.savez_compressed(os.path.join(a.out, "truth.npz"),
                        **{f"{n}__{k}": v for n, t in truth.items() for k, v in t.items()})
    json.dump({n: list(R["bbox"]) for n, R in REGIONS.items()}, open(os.path.join(a.out, "regions.json"), "w"))
    print(f"wrote {total:,} synthetic rows to {a.out}")


if __name__ == "__main__":
    main()
