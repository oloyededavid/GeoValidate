# GeoValidate test report

Run on 23 November 2026. Evidence files are in `docs/validation/`.

| # | Test | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Browser engine (Pyodide 0.26.4, scikit-learn 1.4.2) runs the sample, 5 folds, seed 42, 10 km blocks | Completes | Random 5-fold accuracy 0.9324, spatial 0.8884, in 17.0 s under Node | Pass | `pyodide-run.txt` |
| 2 | Pooled accuracy, kappa, macro precision, recall and F1, weighted F1, and the confusion matrix, recomputed with NumPy from the per-row predictions | Equal | Equal to 1e-12, both designs | Pass | `verify.txt` |
| 3 | Per-fold accuracy recomputed | Equal | Equal | Pass | `verify.txt` |
| 4 | Every row predicted exactly once | Yes | Yes | Pass | `verify.txt` |
| 5 | Each spatial block in exactly one fold; blocks rebuilt independently | Yes | 81 blocks of 10 km; all match | Pass | `verify.txt` |
| 6 | Spatial folds balanced | Size range no larger than the largest block | Sizes 998, 997, 1002, 1002, 1001 | Pass | `verify.txt` |
| 7 | Random folds stratified | Class counts per fold differ by at most 1 | Yes | Pass | `verify.txt` |
| 8 | Spatial test points farther from training than random ones | Yes | Median 158 m vs 3,093 m | Pass | `verify.txt` |
| 9 | Leakage: imputer learned from training rows only | Median 1.5 (all rows would give 100) | 1.5 | Pass | `verify.txt` |
| 10 | Reproducibility: CPython (scikit-learn 1.9.1) with the same configuration | Same predictions | 100% identical | Pass | `verify.txt` |
| 11 | Whole user journey in headless Chromium, 1440 × 960: example, comparison, preview, sweep, exports | Works; no console errors | Example in 23.9 s (redesigned full-screen page), including 35.8 MB of packages; 2 km preview gives 1,253 blocks; sweep drawn; 5 downloads; no console errors | Pass | `browser-e2e.txt`, `docs/screenshots/` |
| 12 | Invalid file type rejected | Message | "“not-data.txt” is not a CSV or GeoJSON file." | Pass | `browser-e2e.txt` |
| 13 | Empty CSV rejected | Message | "The file has no rows" | Pass | `browser-e2e.txt` |
| 14 | Non-metre or geographic EPSG code rejected | Message | EPSG:2263 (US survey foot) refused | Pass | Run during development (`check_crs`) |
| 15 | Phone width, 390 px | No horizontal scrolling | 0 px | Pass | `browser-e2e.txt` |
| 17 | Points across the 180° meridian; data spread over continents | Projected together; warning above 3,000 km from the centre | Four points at 179.5° E to 179.6° W span 95.5 km; warning raised for points from 60° W to 60° E, not for the sample | Pass | `regression-tests.txt` |
| 16 | Exports correspond to the run | CSV and GeoJSON rows match the run's folds and predictions | Written from the same result object; sizes in `browser-e2e.txt` | Pass, by construction (contents not re-parsed) | `js/app.js` |
| 17 | Deployed site | Same journey on GitHub Pages | Not deployed yet; pushing needs the owner's approval | Pending | — |

## Not tested
- GeoJSON upload in the browser (the parser was run in Python only).
- Categorical predictors and missing predictor values on real data in the browser (covered by the pipeline and the leakage test).
- Files near the 50,000-row limit.
- The PDF print layout.

## Version 1.1.0 (interface upgrade), 25 November 2026

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 18 | `tests/check_expected.py` on the Pyodide result for the sample (fixed inputs) | random 0.9324, kappa 0.9155; spatial 0.8884, kappa 0.8605; 5,000 rows; 81 blocks | identical | Pass |
| 19 | `tests/verify.py` and `tests/regression_test.py` after the upgrade | all pass | all pass | Pass |
| 20 | Whole journey in headless Chromium, 1440 × 900: opening screen, example from the opening screen, Reading, values tables, sweep with progress in the status line, exports with limits and metadata, Tools menu | works, no console errors, 0 axe violations | example 25 s, sweep 30 s, no errors, 0 violations | Pass |
| 21 | Empty file | message without starting the engine | "“empty.csv” is empty." immediately | Pass |
| 22 | Phone, 390 px | title and purpose above the steps; no horizontal scrolling | title at 83 px, opening text 226 px, steps 658 px; 0 px overflow | Pass |

### 1.1.1 (after the independent review)

| # | Check | Expected | Result | Status |
|---|---|---|---|---|
| 23 | Whole journey (`tests/browser_e2e.cjs`) after the 1.1.1 changes | 93.2% random, 88.8% spatial; five exports; no errors | as expected; 0 px overflow at 390 px | Pass |
| 24 | 40-row file, five folds | data check warns about test points per fold; Reading does not conclude that nearness does not matter | "about 8 test points per fold …"; "too few to tell a small gap from chance" | Pass |
| 25 | Chart image before the sweep | folds chart only, no empty half | folds chart only | Pass |
| 26 | Version check | page and engine agree | 1.1.1 | Pass |

Changes in 1.1.1: the small-sample warning; the Reading says when the gap is smaller than the fold-to-fold spread; the per-class sentence says it comes from one seed and one split instead of "least likely to transfer"; the result heading states the finding, with the file name below it; the three example buttons use one wording. The engine is unchanged apart from its version number.

Phone map overlays (after 1.1.1, same version): at 860 px and below the scale bar sits bottom-left above the Legend chip, the map credits start closed behind the i button, and layer chips stay in one scrolling row. Checked at 390 px after an example run: no overlapping overlays; axe 0 violations.

## Version 1.2.0 (interface rebuilt), 27 November 2026

| # | Test | Expected | Result | Status |
|---|---|---|---|---|
| 27 | Version check | page and engine agree | 1.2.0 | Pass |
| 28 | `tests/browser_e2e.cjs`, 1440 × 900: Mau Forest example from the opening screen | random 0.9324, spatial 0.8884 as in `tests/check_expected.py` | 93.2% and 88.8%, gap −4.4 points; engine start and run in 32 s; the fold-spread caution shown (±7.2 points) | Pass |
| 29 | Same run: four map views, block-size sweep, five file exports | views drawn, sweep chart, files written | sweep 91.4% at 1 km to 87.7% at 20 km; evaluation CSV, folds CSV, GeoJSON, configuration JSON and charts PNG written | Pass |
| 30 | Block size changed after a result | result cleared, new folds shown | Result step disabled; "25 blocks hold points … fold 5 lacks Water and wetland" | Pass |
| 31 | 390 px phone: sample file chosen through the file input, tour, setup, run | tour on first entry, data check passes, result, no horizontal scroll | as expected; 93.2% and 88.8%; 0 px overflow | Pass |
| 32 | Console errors | none from the page | none apart from the two landing-card files, which did not exist until this run produced them (`tools/make_preview.py`) | Pass |

Not checked in 1.2.0: the printed report, screen readers, real touch devices, and a GeoJSON or projected-coordinate file in the browser (the engine's own tests cover them).

## Version 1.2.1 (after an independent audit), 28 November 2026

| # | Check | Expected | Result | Status |
|---|---|---|---|---|
| 33 | `tests/regression_test.py` with new cases: EPSG:12, EPSG:99999 and EPSG:4269 rejected, EPSG:32737 accepted, a missing predictor value reported | all pass | all pass (local scikit-learn) | Pass |
| 34 | Browser: projected CSV (EPSG:32737), entering 12, then 99999, then 32737 | a message for each bad code; the engine keeps working; the run completes | messages shown, Run disabled; with 32737 the run completed (400 points) | Pass |
| 35 | Browser: a CSV whose class column cannot be guessed | no column chosen silently; Run disabled | "Choose the column that holds the class labels"; Run disabled | Pass |
| 36 | axe on the result with All metrics open | no violations | no colour-contrast or other violations after the fix | Pass |

The audit found that an unknown EPSG code could abort the Python engine in the browser, after which nothing worked until a reload. `check_crs` now looks the code up in PROJ's own list of projected EPSG codes before PROJ parses it, and the data check calls it too. Also fixed: missing predictor values are now reported (they are filled per training fold); a loaded file always opens Setup, where any problem is shown; the class column is not guessed when no name matches; confusion-matrix text keeps 4.5:1 contrast; labelled corner cells; a page h1 and one map region for axe; How it works and Method reachable on phones; New analysis disabled during a run; a compact layer legend on phones; the projection shown in plain words; and the docs.
