#!/usr/bin/env python3
"""Score harmonize.py output against the ground truth of make_demo_data.py (synthetic data only).

Key test: the MODIS era (before VIIRS exists) is OUT-OF-SAMPLE for the calibration, which only ever saw
the 2012-2019 overlap. We compare harmonized region monthly totals to the true VIIRS-equivalent expectation.
Also reports the 'step' at the sensor switch for: truth, naive (raw counts of whichever sensor is primary), harmonized.
"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harmonize as H

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
raw, data = os.path.join(root, "demo_raw"), os.path.join(root, "web", "data")
meta = json.load(open(os.path.join(data, "meta.json")))
truth = np.load(os.path.join(raw, "truth.npz"))
regions = json.load(open(os.path.join(raw, "regions.json")))
nm, ref, T, res = meta["n_months"], meta["viirs_start_idx"], meta["tile_cells"], meta["grid_res"]

def load_tile(key):
    b = open(os.path.join(data, "tiles", key + ".bin"), "rb").read()
    n = int(np.frombuffer(b, "<u4", 1)[0]); idx = np.frombuffer(b, "<u2", n, 4)
    off = (4 + 2 * n + 3) & ~3
    return idx, np.frombuffer(b, "<f4", n * nm, off).reshape(n, nm)

harm = {}
for key in meta["tiles"]:
    tr, tc = map(int, key.split("_")); idx, A = load_tile(key)
    for i, a in zip(idx, A):
        harm[(tr * T + i // T, tc * T + i % T)] = a

# naive: raw counts from the primary sensor (MODIS before ref, VIIRS after), no calibration, no effort normalisation
cfg = json.load(open(os.path.join(root, "pipeline", "satellites.json")))
import glob
agg, *_ = H.load_counts(sorted(glob.glob(os.path.join(raw, "*.csv.gz"))), cfg)
fam = {k: v["family"] for k, v in cfg["satellites"].items()}
agg["fam"] = agg.sat.map(fam)

def corr(a, b): return float(np.corrcoef(a, b)[0, 1])
def window(x, a, b): return x[H.ym_to_idx(a):H.ym_to_idx(b) + 1]

print(f"{'region':14s} {'r(monthly)':>10s} {'r(anomaly)':>10s} {'bias':>7s} {'WAPE':>6s} | step 2009-11 -> 2012-14: truth  naive  harmonized")
tot = {"r": [], "ra": [], "b": [], "w": []}
for name, box in regions.items():
    t = truth; rows, cols, lam = t[f"{name}__rows"], t[f"{name}__cols"], t[f"{name}__lam"]
    T_ = lam.sum(0).astype(float)
    Hs = np.zeros(nm)
    for r, c in zip(rows, cols):
        if (r, c) in harm: Hs += harm[(r, c)]
    sl = slice(0, ref)                      # MODIS era = out-of-sample
    cal = np.array([H.month_ym(m)[1] - 1 for m in range(nm)])
    def anom(x):
        mu = np.array([x[:ref][cal[:ref] == c].mean() for c in range(12)]); return x[:ref] / mu[cal[:ref]]
    r, ra = corr(T_[sl], Hs[sl]), corr(anom(T_), anom(Hs))
    bias = Hs[sl].sum() / T_[sl].sum(); wape = np.abs(Hs[sl] - T_[sl]).sum() / T_[sl].sum()
    # naive series
    sub = agg[(agg.row.isin(set(rows))) & (agg.col.isin(set(cols)))]
    nv = np.zeros(nm)
    for f, g in sub.groupby("fam"):
        s = g.groupby("m").n.sum()
        if f == "MODIS": nv[s.index[s.index < ref]] = s[s.index < ref].to_numpy()
        else: nv[s.index[s.index >= ref]] = s[s.index >= ref].to_numpy()
    step = lambda x: window(x, "2012-02", "2014-12").mean() / window(x, "2009-01", "2011-12").mean()
    print(f"{name:14s} {r:10.3f} {ra:10.3f} {bias:7.3f} {wape:6.3f} | {'':24s}{step(T_):5.2f}  {step(nv):5.2f}  {step(Hs):5.2f}")
    tot["r"].append(r); tot["ra"].append(ra); tot["b"].append(bias)
print(f"\nmean r(monthly)={np.mean(tot['r']):.3f}  mean r(anomaly)={np.mean(tot['ra']):.3f}  mean bias={np.mean(tot['b']):.3f}")
print("bias = sum(harmonized)/sum(truth) over the MODIS era (1.00 = perfect scale match).")
