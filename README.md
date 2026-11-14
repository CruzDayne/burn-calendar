# Burn Calendar

Harmonized MODIS + VIIRS active-fire hotspot history, with a web app for area-of-interest calendars,
anomaly detection against the historical median, and CSV export.

```
pipeline/  fetch_firms.py  ->  harmonize.py  ->  web/data/ (meta.json + tiles/*.bin)
web/       static app (index.html, app.js, style.css, vendored Leaflet). Serve with: cd web && python3 -m http.server
           or open web/dist/burn-calendar.html (single file, built by pipeline/build_single_file.py)
```

> **The bundled dataset is real FIRMS data** for three regions: California, Mesopotamia (Iraq and neighbours) and Australia.
> Inputs were the FIRMS archive and NRT CSVs for MODIS C6.1 (Terra/Aqua), S-NPP, NOAA-20 and NOAA-21 VIIRS, 2000-11 to 2026-11-14.
> NRT files carry no `type` column, so `harmonize.py` learns static sources (gas flares etc.) from the archive files and masks them in NRT.
> Leave-one-year-out check on the real data, weighted by tile: Terra+Aqua era r = 0.98, miss (WAPE) = 11%; Terra-only era r = 0.97, miss = 17%.
> The synthetic generator (`make_demo_data.py`) is kept only for the validation table below.

## Run on real data

```bash
export FIRMS_MAP_KEY=...                       # free key from FIRMS
python3 pipeline/fetch_firms.py --bbox -124.5,32,-114,42 --out raw/california          # or use FIRMS "Archive Download"
python3 pipeline/fetch_firms.py --bbox -10,36,3,44 --out raw/iberia
python3 pipeline/harmonize.py --inputs 'raw/**/*.csv' \
    --region "California=32,-124.5,42,-114" --region "Iberia=36,-10,44,3" \
    --name "FIRMS MODIS C6.1 + VIIRS 375 m" --out web/data
cd web && python3 -m http.server 8000          # http://localhost:8000
```
Needs Python 3 with numpy and pandas. Inputs: FIRMS archive CSVs (MODIS Terra/Aqua, VIIRS S-NPP/NOAA-20/NOAA-21; plain or .gz).
Always pass `--region` boxes for the areas you downloaded: they define "covered, zero fires" vs "not covered" in the app.
`harmonize.py` holds all tiles in memory, so process regions or continents rather than the whole globe in one go.

## What the harmonization does

1. Drops low-confidence and static/offshore detections, bins to 0.25° x month x satellite.
2. Divides by satellite operating time in the month (Terra-only 2000-02, partial first months, VIIRS fleet growth).
3. Fits a MODIS→VIIRS ratio per 5° tile and calendar month over 2012-02..2019-12 (before Terra/Aqua orbit drift),
   shrunk toward the global ratio (`shrinkage_kappa` pseudo-counts); separate ratios for Terra-only and Terra+Aqua.
4. Series = calibrated MODIS before 2012-02, observed VIIRS after. Unit: VIIRS-375 m-equivalent hotspots per satellite per month.
5. Leave-one-year-out cross-validation inside the overlap is stored per tile and shown in the app.

Settings live in `pipeline/satellites.json`. Start dates were checked against the FIRMS Archive Download page (Aqua's 2002-07-04 is unverified). FIRMS replaces NRT with standard-processing data after roughly five months, so use `*_SP` for history and `*_NRT` only for the latest months.

## Validation on the synthetic set

`python3 pipeline/make_demo_data.py` (regenerates the raw CSVs and truth, seed 42), then `python3 pipeline/harmonize.py --inputs "demo_raw/*.csv.gz" --synthetic ...`, then `python3 pipeline/validate_synthetic.py`.

Scored on the MODIS era (2000-11..2012-01), which the calibration never saw:

| region | r monthly | r anomaly | bias | step at 2012: truth / naive / harmonized |
|---|---|---|---|---|
| California | 0.999 | 0.987 | 1.003 | 1.42 / 1.79 / 1.42 |
| Iberia | 1.000 | 0.793 | 0.997 | 1.48 / 1.37 / 1.49 |
| SE Australia | 1.000 | 0.980 | 1.000 | 0.83 / 1.33 / 0.83 |
| Amazon arc | 0.999 | 0.963 | 1.005 | 0.77 / 1.00 / 0.77 |

This is an optimistic test: the simulated sensor relationship is stable over time by construction. On real data
expect weaker agreement; the in-app quality card (leave-one-year-out on real overlap data) is the number to trust.

## Known limitations

- Counts are monthly 0.25° aggregates. The CSV exports are the harmonized aggregates, not raw hotspot points
  (use FIRMS for those). A daily layer would need a different tile format.
- Hotspot counts mix fire number, size, intensity, cloud cover and overpass time; they are not burned area.
- The pre-2012 record is a calibrated estimate. Terra (since ~2020) and Aqua (since ~2022) orbit drift changes MODIS
  sampling times, which is why the calibration window ends in 2019 and VIIRS takes over from Feb 2012.
- Month-to-date comparisons are pro-rated against the median (assumes fire activity is spread evenly within the month).
- `fetch_firms.py` was not run in the authoring sandbox.
