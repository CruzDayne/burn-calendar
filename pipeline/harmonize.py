#!/usr/bin/env python3
"""
MODIS + VIIRS active-fire harmonization -> tiled monthly grid for the Burn Calendar web app.

Input : FIRMS archive CSVs (MODIS C6.1 and VIIRS 375 m, any mix of Terra/Aqua/SNPP/NOAA-20/NOAA-21).
Output: web/data/meta.json + web/data/tiles/<tr>_<tc>.bin   (0.25 deg cells, monthly, 5 deg tiles)
        web/data/harmonization_report.json

Method (one paragraph):
  1. Filter low-confidence detections and static/offshore sources, bin to 0.25 deg x month per satellite.
  2. Normalise observing effort: counts / (sum over satellites of fraction-of-month in operation), i.e.
     "hotspots per satellite-equivalent per month" (handles Terra-only years, partial first months, and the
     VIIRS fleet growing from 1 to 3 satellites).
  3. Calibrate MODIS to the VIIRS-375 m scale. Over a stable overlap window (default 2012-02..2019-12, before
     the Terra/Aqua orbit drift) a ratio f[tile, calendar month, MODIS-mode] = sum(VIIRS)/sum(MODIS) is estimated
     per 5 deg tile and shrunk toward the global ratio (pseudo-count kappa) so sparse tiles stay stable.
     Separate ratios are fitted for the Terra-only and Terra+Aqua eras so the 2000-2002 record is not biased.
  4. Harmonized series = calibrated MODIS before the reference start, observed VIIRS after it.
  5. Quality: leave-one-year-out cross-validation of the calibration inside the overlap window.
"""
import argparse, calendar, datetime as dt, glob, json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))

SAT_ALIASES = {
    "terra": "Terra", "t": "Terra", "aqua": "Aqua", "a": "Aqua",
    "n": "SNPP", "npp": "SNPP", "snpp": "SNPP", "suomi-npp": "SNPP", "suomi npp": "SNPP",
    "1": "NOAA20", "n20": "NOAA20", "noaa-20": "NOAA20", "noaa20": "NOAA20",
    "2": "NOAA21", "n21": "NOAA21", "noaa-21": "NOAA21", "noaa21": "NOAA21",
}
WANTED = {"latitude", "longitude", "acq_date", "satellite", "confidence", "type"}


def month_index(y, m):          # 2000-11 -> 0
    return (y - 2000) * 12 + (m - 1) - 10


def month_ym(idx):
    t = idx + 10
    return 2000 + t // 12, t % 12 + 1


def ym_to_idx(s):
    y, m = s.split("-")
    return month_index(int(y), int(m))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- loading
def load_counts(paths, cfg):
    res = cfg["grid_res"]
    parts, obs, stats = [], {}, {"rows": 0, "kept": 0, "unknown_sat": 0}
    max_date = ""
    # NRT files have no `type` column, so gas flares and other static sources would slip through and inflate recent months.
    # Learn static sites (type 2 / 3 in the archive files) first, then drop NRT detections that fall on them.
    has_type = {p: "type" in pd.read_csv(p, nrows=0).columns for p in paths}
    paths = sorted(paths, key=lambda p: (not has_type[p], p))
    static_keys = np.empty(0, dtype=np.int64)
    SB = 50.0                                         # static-site bins of 0.02 degrees
    skey = lambda la, lo: np.floor((la + 90) * SB).astype(np.int64) * 100000 + np.floor((lo + 180) * SB).astype(np.int64)
    for p in paths:
        log("reading", p)
        if has_type[p]:
            sk = []
            for ch in pd.read_csv(p, chunksize=2_000_000, usecols=["latitude", "longitude", "type"]):
                m = ch["type"].isin([2, 3])
                if m.any(): sk.append(skey(ch.latitude[m].to_numpy(float), ch.longitude[m].to_numpy(float)))
            if sk:
                k, c = np.unique(np.concatenate(sk), return_counts=True)
                static_keys = np.union1d(static_keys, k[c >= 3])
        elif len(static_keys):
            log("  (no type column: masking", len(static_keys), "known static sites)")
        for ch in pd.read_csv(p, chunksize=1_000_000, dtype=str, usecols=lambda c: c in WANTED):
            stats["rows"] += len(ch)
            sat = ch["satellite"].str.strip().str.lower().map(SAT_ALIASES)
            stats["unknown_sat"] += int(sat.isna().sum())
            keep = sat.notna().to_numpy().copy()
            if "confidence" in ch:
                c = ch["confidence"].astype(str).str.strip().str.lower()
                num = pd.to_numeric(c, errors="coerce")
                ok = np.where(num.notna(), num >= cfg["min_confidence_numeric"], ~c.str[:1].isin(["l"]))
                keep &= ok
            if "type" in ch:                      # 0 = vegetation fire; 1 volcano, 2 static land, 3 offshore
                t = pd.to_numeric(ch["type"], errors="coerce")
                keep &= (t.isna() | (t == 0)).to_numpy()
            if not has_type[p] and len(static_keys):
                keep &= ~np.isin(skey(ch["latitude"].astype(float).to_numpy(), ch["longitude"].astype(float).to_numpy()), static_keys)
            d = ch["acq_date"]
            for s, grp in d.groupby(sat):
                obs.setdefault(s, [grp.min(), grp.max()])
                obs[s][0] = min(obs[s][0], grp.min()); obs[s][1] = max(obs[s][1], grp.max())
            max_date = max(max_date, d.max())
            lat = ch["latitude"].astype(float).to_numpy(); lon = ch["longitude"].astype(float).to_numpy()
            row = np.clip(np.floor((lat + 90) / res).astype(int), 0, int(180 / res) - 1)
            col = np.clip(np.floor((lon + 180) / res).astype(int), 0, int(360 / res) - 1)
            y = d.str.slice(0, 4).astype(int).to_numpy(); mo = d.str.slice(5, 7).astype(int).to_numpy()
            df = pd.DataFrame({"sat": sat.to_numpy(), "row": row, "col": col, "m": month_index(y, mo)})[keep]
            df = df[df.m >= 0]
            stats["kept"] += len(df)
            parts.append(df.groupby(["sat", "row", "col", "m"]).size().rename("n").reset_index())
    agg = pd.concat(parts).groupby(["sat", "row", "col", "m"], as_index=False)["n"].sum()
    return agg, obs, max_date, stats


def effort_table(cfg, nm, agg, warnings):
    eff = {}
    for sat, info in cfg["satellites"].items():
        s = dt.date.fromisoformat(info["start"]); e = dt.date.fromisoformat(info["end"]) if info["end"] else None
        v = np.zeros(nm)
        for m in range(nm):
            y, mo = month_ym(m); nd = calendar.monthrange(y, mo)[1]
            a = max(dt.date(y, mo, 1), s); b = dt.date(y, mo, nd)
            if e: b = min(b, e)
            v[m] = ((b - a).days + 1) / nd if b >= a else 0.0
        seen = np.zeros(nm); sub = agg[agg.sat == sat].groupby("m")["n"].sum()
        seen[sub.index.to_numpy()] = sub.to_numpy()
        bad = (seen > 0) & (v == 0)
        if bad.any():
            warnings.append(f"{sat}: detections found in {int(bad.sum())} month(s) outside the configured schedule; "
                            f"treating those months as fully observed. Check satellites.json.")
            v[bad] = 1.0
        eff[sat] = v
    return eff


# --------------------------------------------------------------------------- calibration maths
def shrunk_factor(sv, sm, g, kappa):
    return (sv + kappa * g) / (sm + kappa)


def corr(a, b):
    a = np.asarray(a, float); b = np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3 or a[ok].std() == 0 or b[ok].std() == 0:
        return None
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def loyo(SV, SM, have, GSV, GSM, kappa):
    """Leave-one-year-out prediction of VIIRS from MODIS for one tile. Arrays are (years, 12)."""
    ny = SV.shape[0]
    tsv = (SV * have).sum(0); tsm = (SM * have).sum(0)
    gsv = (GSV * have).sum(0); gsm = (GSM * have).sum(0)
    pred = np.zeros_like(SV)
    for y in range(ny):
        g = np.where(gsm - GSM[y] * have[y] > 0, (gsv - GSV[y] * have[y]) / np.maximum(gsm - GSM[y] * have[y], 1e-9), 1.0)
        f = shrunk_factor(tsv - SV[y] * have[y], tsm - SM[y] * have[y], g, kappa)
        pred[y] = f * SM[y]
    m = have.astype(bool)
    obs_v, pred_v = SV[m], pred[m]
    out = {"r": corr(obs_v, pred_v),
           "wape": float(np.abs(pred_v - obs_v).sum() / obs_v.sum()) if obs_v.sum() > 0 else None}

    def anom(X):
        mu = np.where(have.sum(0) > 0, (X * have).sum(0) / np.maximum(have.sum(0), 1), 0)
        return np.where(mu > 0, X / np.where(mu > 0, mu, 1), np.nan)
    out["r_anom"] = corr(anom(SV)[m], anom(pred)[m])
    out["w"] = float(obs_v.sum())
    return {k: (None if v is None else round(v, 3) if k != "w" else round(v, 1)) for k, v in out.items()}


# --------------------------------------------------------------------------- main
def run(args):
    cfg = json.load(open(args.config))
    res, T = cfg["grid_res"], cfg["tile_cells"]
    kappa = cfg["shrinkage_kappa"]
    warnings = []
    paths = sorted({p for pat in args.inputs for p in glob.glob(pat, recursive=True) if os.path.isfile(p)})
    if not paths:
        sys.exit("no input files matched " + str(args.inputs))
    agg, obs, max_date, stats = load_counts(paths, cfg)
    log(f"rows read {stats['rows']:,}; kept {stats['kept']:,}; unknown satellite {stats['unknown_sat']:,}")
    nm = int(agg.m.max()) + 1
    de = dt.date.fromisoformat(max_date)
    partial = de < dt.date(de.year, de.month, calendar.monthrange(de.year, de.month)[1])
    sats = cfg["satellites"]
    for s, (a, b) in obs.items():
        if s in sats:
            gap = abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(sats[s]["start"])).days)
            if a > sats[s]["start"] and gap > 7 and not args.allow_regional_start:
                log(f"note: {s} first detection {a} vs schedule {sats[s]['start']} (fine for small regions)")
    eff = effort_table(cfg, nm, agg, warnings)
    fam = {k: v["family"] for k, v in sats.items()}
    viirs = [s for s in sats if fam[s] == "VIIRS" and s in set(agg.sat)]
    modis = [s for s in sats if fam[s] == "MODIS" and s in set(agg.sat)]
    if not viirs: warnings.append("no VIIRS detections in input: calibration impossible, ratios default to 1")
    if not modis: warnings.append("no MODIS detections in input")
    ref = ym_to_idx(cfg["viirs_reference_start"])
    w0, w1 = (ym_to_idx(x) for x in cfg["calibration_window"])
    w1 = min(w1, nm - 1)
    win = np.arange(w0, w1 + 1)
    wy0 = month_ym(w0)[0]
    ny = month_ym(w1)[0] - wy0 + 1
    have = np.zeros((ny, 12))
    for m in win:
        y, mo = month_ym(m); have[y - wy0, mo - 1] = 1

    def mode_of(m):
        return "+".join(s for s in ("Terra", "Aqua") if s in modis and eff[s][m] >= 0.5)
    modes_m = [mode_of(m) for m in range(nm)]
    modes_needed = sorted({modes_m[m] for m in range(min(ref, nm)) if modes_m[m]})
    log("MODIS modes needing calibration:", modes_needed)

    veff = sum((eff[s] for s in viirs), np.zeros(nm))
    meff = {md: sum((eff[s] for s in md.split("+")), np.zeros(nm)) for md in modes_needed}

    # ---- pass 1: per-tile effort-normalised series, calibration sums
    agg["tr"] = agg.row // T; agg["tc"] = agg.col // T
    tiles, GSV, GSM = {}, np.zeros((ny, 12)), {md: np.zeros((ny, 12)) for md in modes_needed}
    def calsum(X):                                  # X: (ncell, nm) -> (ny,12)
        tot = X[:, win].sum(0)
        out = np.zeros((ny, 12))
        for k, m in enumerate(win):
            y, mo = month_ym(m); out[y - wy0, mo - 1] = tot[k]
        return out
    for (tr, tc), df in agg.groupby(["tr", "tc"]):
        local = ((df.row % T) * T + (df.col % T)).to_numpy()
        cells = np.unique(local); pos = np.searchsorted(cells, local)
        C = {}
        for s in set(df.sat):
            sub = df.sat.to_numpy() == s
            flat = pos[sub] * nm + df.m.to_numpy()[sub]
            C[s] = np.bincount(flat, weights=df.n.to_numpy()[sub], minlength=len(cells) * nm).reshape(len(cells), nm)
        z = np.zeros((len(cells), nm))
        V = sum((C.get(s, z) for s in viirs), z.copy()) / np.where(veff > 0, veff, 1)
        M = {md: sum((C.get(s, z) for s in md.split("+")), z.copy()) / np.where(meff[md] > 0, meff[md], 1)
             for md in modes_needed}
        t = {"cells": cells, "V": V.astype(np.float32), "M": {k: v.astype(np.float32) for k, v in M.items()},
             "SV": calsum(V), "SM": {md: calsum(M[md]) for md in modes_needed}}
        tiles[(int(tr), int(tc))] = t
        GSV += t["SV"]
        for md in modes_needed: GSM[md] += t["SM"][md]

    gfac = {}
    for md in modes_needed:
        sv = (GSV * have).sum(0); sm = (GSM[md] * have).sum(0)
        gfac[md] = np.where(sm > 0, sv / np.maximum(sm, 1e-9), 1.0)

    # ---- pass 2: factors, harmonized arrays, quality, export
    out_dir = args.out; os.makedirs(os.path.join(out_dir, "tiles"), exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, "tiles", "*.bin")): os.remove(f)
    meta_tiles, step = {}, {}
    cal = np.array([month_ym(m)[1] - 1 for m in range(nm)])
    for (tr, tc), t in tiles.items():
        H = np.zeros((len(t["cells"]), nm), np.float32)
        if ref < nm: H[:, ref:] = t["V"][:, ref:]
        quality = {}
        for md in modes_needed:
            f = shrunk_factor((t["SV"] * have).sum(0), (t["SM"][md] * have).sum(0), gfac[md], kappa)
            for m in range(min(ref, nm)):
                if modes_m[m] == md: H[:, m] = f[cal[m]] * t["M"][md][:, m]
            quality[md] = loyo(t["SV"], t["SM"][md], have, GSV, GSM[md], kappa)
        keep = H.sum(1) > 0
        if not keep.any(): continue
        key = f"{tr}_{tc}"
        idx, Hk = t["cells"][keep], np.round(H[keep], 2)
        with open(os.path.join(out_dir, "tiles", key + ".bin"), "wb") as fh:
            fh.write(np.uint32(len(idx)).tobytes()); fh.write(idx.astype("<u2").tobytes())
            fh.write(b"\0" * ((-(4 + 2 * len(idx))) % 4)); fh.write(Hk.astype("<f4").tobytes())
        meta_tiles[key] = {"n": int(len(idx)), "q": quality}
        # step-change diagnostic: raw MODIS-era mean vs harmonized, per tile sums
    # ---- regions
    regions = []
    for r in args.region or []:
        name, box = r.split("=")
        s, w, n, e = (float(x) for x in box.split(","))
        regions.append({"id": name.lower().replace(" ", "_"), "name": name, "bbox": [s, w, n, e]})
    if not regions:
        rr = [k for k in tiles];
        regions = [{"id": "data", "name": "Data coverage", "bbox": [
            min(r for r, _ in rr) * T * res - 90, min(c for _, c in rr) * T * res - 180,
            (max(r for r, _ in rr) + 1) * T * res - 90, (max(c for _, c in rr) + 1) * T * res - 180]}]
    meta = {
        "format_version": 1, "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "dataset": {"name": args.name, "synthetic": bool(args.synthetic),
                    "description": args.description or ""},
        "grid_res": res, "tile_cells": T, "start": "2000-11", "n_months": nm,
        "viirs_start_idx": ref, "viirs_start": cfg["viirs_reference_start"],
        "data_end": max_date, "partial_last_month": bool(partial), "days_covered": de.day if partial else None,
        "calibration": {"window": cfg["calibration_window"], "kappa": kappa, "modes": modes_needed},
        "units": "VIIRS-375m-equivalent hotspots per satellite per month",
        "regions": regions, "tiles": meta_tiles,
    }
    json.dump(meta, open(os.path.join(out_dir, "meta.json"), "w"), separators=(",", ":"))
    report = {"warnings": warnings, "observed_satellite_ranges": obs, "input_files": paths, "stats": stats,
              "global_ratio_viirs_per_modis": {md: [round(float(x), 3) for x in gfac[md]] for md in modes_needed},
              "tiles": len(meta_tiles)}
    json.dump(report, open(os.path.join(out_dir, "harmonization_report.json"), "w"), indent=1)
    for w in warnings: log("WARNING:", w)
    log(f"wrote {len(meta_tiles)} tiles, {nm} months -> {out_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inputs", nargs="+", required=True, help="glob(s) of FIRMS CSV / CSV.GZ files")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "web", "data"))
    ap.add_argument("--config", default=os.path.join(HERE, "satellites.json"))
    ap.add_argument("--region", action="append", help='coverage region, e.g. "California=32,-124.5,42,-114"')
    ap.add_argument("--name", default="FIRMS MODIS+VIIRS harmonized")
    ap.add_argument("--description", default="")
    ap.add_argument("--synthetic", action="store_true", help="flag the dataset as synthetic in the UI")
    ap.add_argument("--allow-regional-start", action="store_true")
    run(ap.parse_args())
