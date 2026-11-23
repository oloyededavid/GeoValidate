# GeoValidate methodology

Version 1.0.0. All computation is in `py/geovalidate.py`. In the browser it runs inside Pyodide 0.26.4 with scikit-learn 1.4.2; in tests it runs in CPython. Function names below refer to that file.

## 1. Question
Does a classifier trained on point data keep its accuracy at places that are geographically separate from its training points? GeoValidate answers this by evaluating the same model under two designs:
- random folds;
- spatial block folds.

It reports both side by side, with the distance between test and training points.

## 2. Inputs (`read_table`, `guess_columns`)
- **File types:**
  - CSV;
  - GeoJSON FeatureCollection of points, where the point coordinates become columns `lon` and `lat`.
- **Limits:** 20 MB (checked in the page) and 50,000 rows (checked in Python).
- **The user chooses:**
  - the target column;
  - the coordinate columns;
  - the coordinate system: longitude/latitude, or a projected CRS in metres given by EPSG code (`check_crs` refuses geographic or non-metre CRSs);
  - the predictors.
- **Integrity:** a SHA-256 fingerprint of the file text is recorded (`fingerprint`).

## 3. Data checks (`inspect`)
Reported, never silently fixed:
- **Missing values:** missing or out-of-range coordinates, and missing targets. These rows are left out of the analysis, and the counts are shown.
- **Duplicates:** exact duplicate rows, and duplicate locations.
- **Class balance:** class counts, and the ratio of the largest to the smallest class.
- **Suspicious predictors:**
  - constant;
  - unique per row (identifier-like);
  - categorical with more than 50 levels;
  - coordinate-named, or the chosen coordinate columns themselves;
  - possible target leakage: each value maps to a single class.

## 4. Coordinates and distances (`prepare`, `project_aeqd`)
- **Longitude/latitude** are projected with an azimuthal equidistant projection (pyproj) centred on the median latitude and the circular mean of longitude, so data on both sides of the 180° meridian are centred correctly. Distances from the centre are exact. Across the radial direction the scale is stretched by θ/sin θ − 1, where θ is the distance from the centre divided by 6,371 km: about 0.4% at 1,000 km and 3.8% at 3,000 km. When points lie more than 3,000 km from the centre, the data check says so (`max_spread_km`, `aeqd_stretch`).
- **Projected coordinates** are used as given, in metres.

## 5. Folds
- **Random k-fold (`random_folds`):** stratified by class with `StratifiedKFold(shuffle=True, random_state=seed)`. If a class has fewer members than k, plain `KFold` is used.
- **Random hold-out (`holdout`, optional):** a stratified 25% test set.
- **Spatial block k-fold (`spatial_folds`, `block_ids`):**
  - Square blocks of side B metres, anchored at the minimum x and y of the projected points.
  - Occupied blocks are shuffled with the seed, then assigned largest first to the fold with the fewest points so far (a greedy balance).
  - Every block belongs to exactly one fold.
  - Fewer occupied blocks than folds is an error.
- **Buffer (`apply_buffer`, optional):** in each fold, training points within D metres of any test point are removed.

## 6. Model and leakage control (`make_pipeline`, `evaluate`)
For each fold, a new scikit-learn `Pipeline` is fitted on that fold's training rows only:
1. `ColumnTransformer`:
   - numeric predictors: `SimpleImputer(median)`;
   - categorical predictors: `SimpleImputer(most_frequent)`, then `OneHotEncoder(handle_unknown='ignore')`.
2. `RandomForestClassifier(n_estimators, max_depth, min_samples_leaf, max_features='sqrt', class_weight, random_state=seed, n_jobs=1)`.

No statistic is learned from test rows. The test in `tests/verify.py` fits a fold pipeline on three training rows and confirms that the imputer's median comes from those rows only.

Both designs use the same pipeline, settings and seed. Every row is predicted exactly once (k-fold) or once in the test set (hold-out).

## 7. Metrics (`metrics`)
Over the pooled out-of-fold predictions, and per fold:
- overall accuracy;
- Cohen's kappa;
- precision, recall and F1 per class;
- macro averages (classes weighted equally) and weighted averages (by support);
- the confusion matrix (rows: labels; columns: predictions).

**Classes:**
- Classes that appear in neither the truth nor the predictions of a fold are left out of that fold's averages, which uses the scikit-learn `labels` argument with `zero_division=0`.
- If a class is absent from a fold's training rows, a warning is reported.

**Other outputs:**
- **Fold spread:** the sample standard deviation of fold accuracy.
- **Distance:** for each design, the median over folds of the median distance from each test point to its nearest training point (`scipy.spatial.cKDTree`).
- **Block-size sweep (`sweep`):** the spatial design repeated for 1, 2, 5, 10 and 20 km blocks, plus the chosen size, with the same model, seed and folds count.

## 8. Reproducibility record
The configuration export holds everything needed to rerun the analysis:
- **Versions:** the engine version, scikit-learn, NumPy, pandas and Pyodide.
- **Input:** the file name, its SHA-256, and the rows used and in total.
- **Settings:** the projection, the full configuration (target, coordinates, predictors, folds, seed, block size, buffer and model settings), and the run time.
- **Results:** the headline results, and the sweep if run.

## 9. Verification
Detailed results are in `docs/test-report.md`.
- **Engine against desktop Python:** the browser engine (Pyodide, scikit-learn 1.4.2) and CPython (scikit-learn 1.9.1) give 100% identical predictions on the sample with the same configuration.
- **Metrics recomputed:** every pooled metric and the confusion matrix are recomputed with plain NumPy from the per-row predictions, and agree to 1e-12.
- **Folds checked:** spatial blocks are rebuilt with separate code and each lies in exactly one fold; random folds are stratified (class counts per fold differ by at most 1).

## 10. Limits
- Spatial block validation answers a different question from random validation; it is not better in general. Large blocks can leave classes out of folds, and the tool reports when that happens.
- Block size should be chosen with the range of spatial autocorrelation in mind. The sweep shows the sensitivity; it does not choose a size.
- Classification only, Random Forest only, single-threaded in the browser.
- **The sample dataset:**
  - Source: the Mau Forest study (Kenya), 5,000 rows, 1,000 per class, drawn with seed 2026 from 20,000 training cells.
  - Predictors: 16 Sentinel-2 bands, indices and terrain values.
  - Labels: cells where two existing land-cover maps agree in uniform 3 × 3 neighbourhoods, so they are easy cases. Its scores are agreement with those labels, not map accuracy.

## References
- Roberts, D. R., et al. (2017). Cross-validation strategies for data with temporal, spatial, hierarchical, or phylogenetic structure. *Ecography*, 40(8), 913–929.
- Valavi, R., Elith, J., Lahoz-Monfort, J. J., & Guillera-Arroita, G. (2019). blockCV: An R package for generating spatially or environmentally separated folds for k-fold cross-validation of species distribution models. *Methods in Ecology and Evolution*, 10(2), 225–232.
- Ploton, P., et al. (2020). Spatial validation reveals poor predictive performance of large-scale ecological mapping models. *Nature Communications*, 11, 4540.
- Wadoux, A. M. J.-C., Heuvelink, G. B. M., de Bruin, S., & Brus, D. J. (2021). Spatial cross-validation is not the right way to evaluate map accuracy. *Ecological Modelling*, 457, 109692.
