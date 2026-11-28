# GeoValidate

Does your spatial classifier work in places it has not seen? GeoValidate trains the same Random Forest twice on your points, once with random folds and once with whole blocks of territory held out, and shows the difference. scikit-learn runs in your browser (Pyodide), so your data never leave your computer.

**Live:** https://oloyededavid.github.io/GeoValidate/

## Example
The sample is 5,000 points from the Mau Forest study in Kenya: 5 land-cover classes and 16 Sentinel-2 and terrain predictors.

| Validation | Accuracy | Median distance, test to nearest training point |
|---|---|---|
| Random 5-fold | 93.2% | 158 m |
| Spatial blocks, 10 km | 88.8% | 3.1 km |

Accuracy falls further as the blocks grow (block-size sweep). The sample's labels come from map agreement, so absolute scores are optimistic.

## Features
- **Load data:** upload CSV or GeoJSON points (up to 20 MB and 50,000 rows), or load the sample.
- **Check data:** column mapping, then data checks for missing values, duplicates, class imbalance, identifier-like and coordinate predictors, and possible target leakage.
- **Validation designs:**
  - stratified random k-fold or hold-out;
  - spatial block k-fold with any block size, an optional buffer and a seed;
  - a live map of the folds.
- **Results:**
  - accuracy, kappa, macro and weighted F1, precision and recall per class;
  - confusion matrices, fold spread and distance from test to training points;
  - a block-size sweep.
- **Exports:**
  - evaluation (CSV);
  - fold assignments (CSV);
  - fold map (GeoJSON);
  - charts (PNG);
  - configuration with versions and the file's SHA-256 (JSON);
  - report (print to PDF).

## Checks
- The browser engine and desktop Python give identical predictions.
- Metrics are recomputed independently with NumPy.
- Folds are verified, and a leakage test passes.
- The full journey passes in headless Chromium.

See [docs/test-report.md](docs/test-report.md). The method is in [docs/methodology.md](docs/methodology.md).

## Files
| Path | What |
|---|---|
| `py/geovalidate.py` | The engine: loading, checks, folds, pipeline, metrics, sweep |
| `js/worker.js` | Loads Pyodide 0.26.4 (from jsDelivr) and runs the engine |
| `js/app.js`, `js/version.js`, `index.html`, `css/app.css` | Interface: landing, three steps (data, setup, result), map, export |
| `data/sample_mau_forest.csv` | Sample (CC BY 4.0; contains modified Copernicus Sentinel-2 data) |
| `tests/pyodide_run.mjs` | Runs the engine in Pyodide under Node |
| `tests/verify.py` | Independent checks of a result |
| `tests/browser_e2e.cjs` | End-to-end test in Chromium, desktop and phone |
| `tests/regression_test.py` | Regression tests for review findings (`PYTHONPATH=py python3 tests/regression_test.py`) |
| `tests/version_check.mjs` | Page and engine carry the same version |
| `tools/make_preview.py`, `assets/preview.*` | The landing card, built from a real run's exports |

## Run locally
```bash
npx http-server . -p 8767 -s -c-1      # open http://127.0.0.1:8767 (tests/browser_e2e.cjs expects this port)
python3 tests/verify.py RESULT.json    # after: node tests/pyodide_run.mjs RESULT.json (needs the pyodide npm package)
```

## Licences
- Code: MIT.
- Sample data: CC BY 4.0 (Mau Forest study, D. Oloyede), contains modified Copernicus Sentinel-2 data.
- Basemap © OpenStreetMap contributors, via OpenFreeMap.
- Pyodide, scikit-learn and MapLibre keep their own licences.
