"""GeoValidate engine: does a classifier generalise to geographically separate places?

The same file runs in the browser (Pyodide, scikit-learn 1.4.2) and in CPython for the tests. Every function takes plain
Python or NumPy inputs and returns JSON-serialisable dictionaries, so the page only displays what is computed here.
Methods are described in docs/methodology.md; names here match that document."""
from __future__ import annotations

import hashlib
import io
import json
import re
import math
from dataclasses import dataclass, field, asdict

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from sklearn import __version__ as SKLEARN_VERSION
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import accuracy_score, cohen_kappa_score, confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import StratifiedKFold, KFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

VERSION = "1.2.1"
MAX_ROWS = 50_000
COORD_NAMES = {"x", "y", "lon", "lng", "long", "longitude", "lat", "latitude", "easting", "northing", "row", "col", "column"}


# ---------------------------------------------------------------- JSON
def to_json(obj) -> str:
    """JSON with NaN and infinities written as null (JSON has no NaN; the browser's JSON.parse would reject it)."""
    def clean(o):
        if isinstance(o, float):
            return o if math.isfinite(o) else None
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        if isinstance(o, np.generic):
            return clean(o.item())
        return o
    return json.dumps(clean(obj), allow_nan=False)


# ---------------------------------------------------------------- loading
def read_table(text: str, kind: str) -> pd.DataFrame:
    """Parse CSV text or a GeoJSON FeatureCollection of points into a DataFrame. GeoJSON points become columns lon, lat."""
    if kind == "csv":
        try:
            df = pd.read_csv(io.StringIO(text), low_memory=False)
        except pd.errors.EmptyDataError:
            raise ValueError("The file is empty")
        except UnicodeDecodeError:
            raise ValueError("The file could not be read as text. Save it as a UTF-8 CSV and try again")
        except pd.errors.ParserError as e:
            m = re.search(r"line (\d+)", str(e))
            where = f" near line {m.group(1)}" if m else ""
            raise ValueError(f"The file could not be read as CSV{where}. Check that it is comma-separated, has one header row and that every quote is closed")
    elif kind == "geojson":
        try:
            gj = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"The file is not valid GeoJSON: it could not be read as JSON (line {e.lineno}, column {e.colno})")
        if not isinstance(gj, dict) or gj.get("type") != "FeatureCollection":
            raise ValueError("GeoJSON must be a FeatureCollection of point features")
        rows, other = [], {}
        for i, f in enumerate(gj.get("features", [])):
            g = f.get("geometry") or {}
            props = dict(f.get("properties") or {})
            if g.get("type") == "Point" and isinstance(g.get("coordinates"), list) and len(g["coordinates"]) >= 2:
                props["lon"], props["lat"] = g["coordinates"][0], g["coordinates"][1]
            else:
                props["lon"], props["lat"] = None, None   # reported as invalid geometry by inspect()
                t = g.get("type") or "no geometry"; other[t] = other.get(t, 0) + 1
            rows.append(props)
        if rows and sum(other.values()) == len(rows):
            kinds = ", ".join(f"{n:,} {t}" for t, n in other.items())
            raise ValueError(f"GeoValidate needs point features, and this file has none ({kinds}). Convert the features to points first, for example to their centroids")
        df = pd.DataFrame(rows)
    else:
        raise ValueError(f"Unsupported file type: {kind}")
    if len(df) == 0:
        raise ValueError("The file has no rows")
    if len(df) > MAX_ROWS:
        raise ValueError(f"The file has {len(df):,} rows; the limit for an in-browser run is {MAX_ROWS:,}")
    df.columns = [str(c).strip() for c in df.columns]
    if len(set(df.columns)) != len(df.columns):
        raise ValueError("Column names must be unique")
    return df


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def guess_columns(df: pd.DataFrame) -> dict:
    """Suggest coordinate and target columns from names only; the user confirms them."""
    low = {c.lower(): c for c in df.columns}
    pick = lambda names: next((low[n] for n in names if n in low), None)
    x = pick(["lon", "lng", "longitude", "long", "x", "easting"])
    y = pick(["lat", "latitude", "y", "northing"])
    target = pick(["label", "class", "target", "landcover", "land_cover", "lc", "y_true"])
    return {"x": x, "y": y, "target": target}


# ---------------------------------------------------------------- inspection
def inspect(df: pd.DataFrame, target: str, x: str, y: str, features: list[str], crs: str) -> dict:
    """Data-quality report. Nothing is modified; problems are described for the user to decide."""
    check_crs(crs)
    for c in [target, x, y, *features]:
        if c not in df.columns:
            raise ValueError(f"Column not found: {c}")
    n = len(df)
    xs, ys = pd.to_numeric(df[x], errors="coerce"), pd.to_numeric(df[y], errors="coerce")
    missing_xy = int((xs.isna() | ys.isna()).sum())
    if crs == "EPSG:4326":
        bad_xy = int(((xs.abs() > 180) | (ys.abs() > 90)).sum())
    else:
        bad_xy = 0
    tgt = df[target]
    missing_target = int(tgt.isna().sum())
    classes = tgt.dropna().astype(str).value_counts()
    dup_rows = int(df.duplicated().sum())
    dup_xy = int(pd.DataFrame({"x": xs, "y": ys}).dropna().duplicated().sum())
    feats = []
    for c in features:
        s = df[c]
        num = pd.to_numeric(s, errors="coerce")
        is_num = bool(num.notna().sum() >= 0.95 * s.notna().sum()) and s.notna().sum() > 0
        info = {"name": c, "type": "numeric" if is_num else "categorical", "missing": int(s.isna().sum()),
                "unique": int(s.nunique(dropna=True)), "warnings": []}
        if info["unique"] <= 1:
            info["warnings"].append("constant: carries no information")
        if not is_num and info["unique"] > 50:
            info["warnings"].append(f"{info['unique']} categories: one-hot encoding will be wide")
        if info["unique"] == n and not is_num:
            info["warnings"].append("unique for every row: looks like an identifier")
        if c.lower() in COORD_NAMES or c in (x, y):
            info["warnings"].append("a coordinate: the model can learn location itself, which inflates random validation")
        if is_num:
            bad = int((num.isna() & s.notna()).sum())
            if bad:
                info["warnings"].append(f"{bad} non-numeric values will be treated as missing")
        # a categorical predictor whose values each map to a single class, with at least 5 rows per value, is suspicious
        # (target leakage); numeric columns are not tested because near-unique values map to one class trivially
        if not is_num and classes.size > 1:
            pair = pd.DataFrame({"v": s, "t": tgt}).dropna()
            if len(pair):
                g = pair.groupby("v")["t"].agg(["nunique", "size"])
                if (g["nunique"] == 1).all() and g["size"].min() >= 5 and len(g) >= classes.size:
                    info["warnings"].append("each value maps to a single class: possible target leakage")
        feats.append(info)
    imbalance = float(classes.max() / classes.min()) if classes.size > 1 else None
    problems = []
    rows_ = lambda n: f"{n:,} row" + ("" if n == 1 else "s")
    if missing_xy: problems.append(f"{rows_(missing_xy)} without point coordinates will be left out")
    if bad_xy: problems.append(f"{rows_(bad_xy)} with longitude or latitude out of range will be left out")
    if missing_target: problems.append(f"{rows_(missing_target)} without a target value will be left out")
    if classes.size < 2: problems.append("the target has fewer than two classes")
    if classes.size > 50: problems.append(f"the target has {classes.size} classes; is it a continuous variable?")
    if dup_rows: problems.append(f"{rows_(dup_rows)} {'is an exact duplicate' if dup_rows == 1 else 'are exact duplicates'}; duplicates split across training and test inflate accuracy")
    if dup_xy: problems.append(f"{rows_(dup_xy)} {'shares' if dup_xy == 1 else 'share'} a location with an earlier row")
    if imbalance and imbalance > 10: problems.append(f"the largest class is {imbalance:.0f} times the smallest; macro averages weigh classes equally")
    if not features: problems.append("no predictors selected")
    miss_pred = int(df[features].isna().any(axis=1).sum()) if features else 0
    if miss_pred: problems.append(f"{rows_(miss_pred)} {'has' if miss_pred == 1 else 'have'} a missing predictor value; it is filled "
                                  "with the median (numeric) or the most frequent value (categorical) of each training fold")
    if crs == "EPSG:4326":
        ok = (xs.abs() <= 180) & (ys.abs() <= 90) & xs.notna() & ys.notna()
        if ok.sum() > 1:
            spread = max_spread_km(xs[ok].to_numpy(float), ys[ok].to_numpy(float))
            if spread > 3000:
                problems.append(f"points lie up to {spread:,.0f} km from their centre; the equidistant projection stretches blocks far "
                                f"from the centre ({f"about {100 * aeqd_stretch(spread):.0f}%" if spread < 10000 else "without a useful bound"} at that distance), so block sizes are approximate there")
    return {"rows": n, "missing_coordinates": missing_xy, "invalid_coordinates": bad_xy, "missing_target": missing_target,
            "duplicate_rows": dup_rows, "duplicate_locations": dup_xy, "classes": {str(k): int(v) for k, v in classes.items()},
            "imbalance_ratio": imbalance, "features": feats, "problems": problems}


@dataclass
class Prepared:
    X: pd.DataFrame
    y: np.ndarray
    xy: np.ndarray          # projected metres
    keep: np.ndarray        # indices of kept rows in the original table
    numeric: list
    categorical: list
    classes: list
    projection: str


def prepare(df, target, x, y, features, crs) -> Prepared:
    """Keep rows with coordinates and a target; project coordinates to metres. Feature values are not changed here:
    imputation and encoding happen inside each fold's pipeline (no leakage)."""
    xs, ys = pd.to_numeric(df[x], errors="coerce"), pd.to_numeric(df[y], errors="coerce")
    ok = xs.notna() & ys.notna() & df[target].notna()
    if crs == "EPSG:4326":
        ok &= (xs.abs() <= 180) & (ys.abs() <= 90)
    keep = np.flatnonzero(ok.to_numpy())
    if keep.size < 20:
        raise ValueError("Fewer than 20 usable rows")
    sub = df.iloc[keep]
    X = sub[features].copy()
    numeric, categorical = [], []
    for c in features:
        num = pd.to_numeric(X[c], errors="coerce")
        if num.notna().sum() >= 0.95 * X[c].notna().sum() and X[c].notna().sum() > 0:
            X[c] = num; numeric.append(c)
        else:
            X[c] = X[c].map(lambda v: np.nan if pd.isna(v) else str(v)).astype(object); categorical.append(c)
    yv = sub[target].astype(str).to_numpy()
    lon, lat = xs.iloc[keep].to_numpy(float), ys.iloc[keep].to_numpy(float)
    if crs == "EPSG:4326":
        xy, proj = project_aeqd(lon, lat)
    else:
        xy, proj = np.column_stack([lon, lat]), f"{crs} (used as given)"
    return Prepared(X, yv, xy, keep, numeric, categorical, sorted(np.unique(yv).tolist()), proj)


_PROJECTED_EPSG = None


def _projected_epsg() -> set:
    """EPSG codes of projected CRSs in PROJ's database, read once. Codes are looked up here before PROJ parses them:
    in Pyodide an unknown code can abort the whole Python runtime instead of raising an exception."""
    global _PROJECTED_EPSG
    if _PROJECTED_EPSG is None:
        from pyproj.database import query_crs_info
        from pyproj.enums import PJType
        _PROJECTED_EPSG = {i.code for i in query_crs_info(auth_name="EPSG", pj_types=PJType.PROJECTED_CRS)}
    return _PROJECTED_EPSG


def check_crs(crs: str) -> None:
    """Coordinates must be longitude/latitude (EPSG:4326) or a projected CRS in metres."""
    if crs == "EPSG:4326":
        return
    m = re.fullmatch(r"EPSG:(\d{1,6})", str(crs))
    if not m:
        raise ValueError("Enter the EPSG code of the projected coordinates as a number, for example 32737")
    if m.group(1) not in _projected_epsg():
        raise ValueError(f"EPSG:{m.group(1)} is not a projected coordinate system in the EPSG database; check the code "
                         "(for example 32737 is UTM zone 37 South)")
    from pyproj import CRS
    c = CRS.from_user_input(crs)
    if not c.is_projected:
        raise ValueError(f"{crs} is not a projected CRS; choose longitude/latitude or a projected CRS in metres")
    unit = c.axis_info[0].unit_name.lower()
    if unit not in ("metre", "meter"):
        raise ValueError(f"{crs} uses {unit}; block sizes and buffers need a CRS in metres")


def lonlat_of(df, keep, x, y, crs):
    """Longitude and latitude of the kept rows, for the map only."""
    xs = pd.to_numeric(df[x], errors="coerce").iloc[keep].to_numpy(float)
    ys = pd.to_numeric(df[y], errors="coerce").iloc[keep].to_numpy(float)
    if crs == "EPSG:4326":
        return np.column_stack([xs, ys])
    from pyproj import Transformer
    lon, lat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(xs, ys)
    return np.column_stack([lon, lat])


def unwrap(lon, lon0):
    """Longitude shifted by whole turns to lie within 180 degrees of lon0, so a block across the 180 degree meridian keeps
    continuous corners (e.g. 179.9 and 180.1) instead of spanning the globe. Values may therefore exceed 180."""
    return float(lon0 + ((lon - lon0 + 180.0) % 360.0) - 180.0)


def block_polygons(prep: Prepared, block_m: float, ix, iy, blocks, folds) -> dict:
    """GeoJSON of the occupied blocks with their fold, corners transformed back to longitude/latitude for the map."""
    from pyproj import Transformer
    x0, y0 = prep.xy[:, 0].min(), prep.xy[:, 1].min()
    src = prep.projection.split(" (")[0]
    inv = Transformer.from_crs(src, "EPSG:4326", always_xy=True)
    m = re.search(r"\+lon_0=(-?[\d.]+)", src)
    lon0 = float(m.group(1)) if m else 0.0   # projected input: no wrapping needed in practice
    feats = []
    seen = {}
    for b, i, j, f in zip(blocks, ix, iy, folds):
        if b in seen: continue
        seen[b] = 1
        xs = [x0 + i * block_m, x0 + (i + 1) * block_m]; ys = [y0 + j * block_m, y0 + (j + 1) * block_m]
        ring = [(xs[0], ys[0]), (xs[1], ys[0]), (xs[1], ys[1]), (xs[0], ys[1]), (xs[0], ys[0])]
        lon, lat = inv.transform([p[0] for p in ring], [p[1] for p in ring])
        lon = [unwrap(a, lon0) for a in lon]
        feats.append({"type": "Feature", "properties": {"block": int(b), "fold": int(f)},
                      "geometry": {"type": "Polygon", "coordinates": [[[round(a, 6), round(c, 6)] for a, c in zip(lon, lat)]]}})
    return {"type": "FeatureCollection", "features": feats}


def fold_preview(df: pd.DataFrame, cfg: dict) -> dict:
    """Spatial fold assignment without training, for the live block-size preview on the map."""
    check_crs(cfg["crs"])
    prep = prepare(df, cfg["target"], cfg["x"], cfg["y"], cfg["features"], cfg["crs"])
    k, seed, bm = int(cfg.get("k", 5)), int(cfg.get("seed", 42)), float(cfg.get("block_km", 10)) * 1000
    sp = spatial_folds(prep.xy, bm, k, seed)
    return {"lonlat": lonlat_of(df, prep.keep, cfg["x"], cfg["y"], cfg["crs"]).round(6).tolist(), "folds": sp["folds"].tolist(),
            "n_blocks": sp["n_blocks"], "fold_sizes": np.bincount(sp["folds"], minlength=k).tolist(),
            "fold_class_counts": [{c: int(((sp["folds"] == f) & (prep.y == c)).sum()) for c in prep.classes} for f in range(k)],
            "blocks": block_polygons(prep, bm, sp["block_ix"], sp["block_iy"], sp["blocks"], sp["folds"]), "classes": prep.classes,
            "y": prep.y.tolist()}


def max_spread_km(lon, lat):
    """Largest great-circle distance (km, sphere of 6,371 km) from the projection centre used by project_aeqd."""
    r = np.radians(lon); lon0 = np.arctan2(np.mean(np.sin(r)), np.mean(np.cos(r))); lat0 = np.radians(np.median(lat))
    p = np.radians(lat); c = np.sin(lat0) * np.sin(p) + np.cos(lat0) * np.cos(p) * np.cos(r - lon0)
    return float(np.degrees(np.arccos(np.clip(c, -1, 1))).max() * np.pi / 180 * 6371.0)


def aeqd_stretch(d_km):
    """Scale error across the radial direction of an azimuthal equidistant projection at distance d: theta / sin(theta) - 1."""
    t = min(d_km / 6371.0, 3.0)   # near the antipode the stretch has no useful bound; 3 rad (19,000 km) is used as a cap
    return float(t / np.sin(t) - 1)


def project_aeqd(lon, lat):
    """Azimuthal equidistant projection centred on the data: distances from the centre are exact and block sizes are in
    metres. pyproj is imported lazily so the module loads without it when coordinates are already projected."""
    from pyproj import Transformer
    # circular mean of longitude, so data on both sides of the 180 degree meridian get a centre between them
    r = np.radians(np.asarray(lon, float))
    lon0, lat0 = float(np.degrees(np.arctan2(np.mean(np.sin(r)), np.mean(np.cos(r))))), float(np.median(lat))
    proj = f"+proj=aeqd +lat_0={lat0:.6f} +lon_0={lon0:.6f} +datum=WGS84 +units=m +no_defs"
    t = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
    x, y = t.transform(lon, lat)
    return np.column_stack([x, y]), proj


# ---------------------------------------------------------------- folds
def random_folds(y, k: int, seed: int) -> np.ndarray:
    """Stratified random k-fold: every class spread over the folds in proportion."""
    folds = np.full(len(y), -1)
    min_count = min(np.unique(y, return_counts=True)[1])
    splitter = StratifiedKFold(k, shuffle=True, random_state=seed) if min_count >= k else KFold(k, shuffle=True, random_state=seed)
    for f, (_, te) in enumerate(splitter.split(np.zeros(len(y)), y)):
        folds[te] = f
    return folds, min_count >= k


def holdout(y, test_share: float, seed: int) -> np.ndarray:
    """Random stratified hold-out: fold 0 is the test set, -2 marks training rows (single split)."""
    idx = np.arange(len(y))
    strat = y if min(np.unique(y, return_counts=True)[1]) >= 2 else None
    _, te = train_test_split(idx, test_size=test_share, random_state=seed, stratify=strat)
    folds = np.full(len(y), -2); folds[te] = 0
    return folds


def block_ids(xy, block_m: float):
    """Square blocks of side block_m metres, anchored at the minimum x and y of the data."""
    ix = np.floor((xy[:, 0] - xy[:, 0].min()) / block_m).astype(np.int64)
    iy = np.floor((xy[:, 1] - xy[:, 1].min()) / block_m).astype(np.int64)
    _, blk = np.unique(np.column_stack([ix, iy]), axis=0, return_inverse=True)
    return blk.ravel(), ix, iy


def spatial_folds(xy, block_m: float, k: int, seed: int) -> dict:
    """Spatial block k-fold. Whole blocks go to one fold. Blocks are shuffled with the seed, then assigned largest first to the
    fold with the fewest points, so folds are balanced in size; points in one block never appear in two folds."""
    blk, ix, iy = block_ids(xy, block_m)
    nb = int(blk.max()) + 1
    if nb < k:
        raise ValueError(f"Only {nb} blocks of {block_m / 1000:g} km contain data; use smaller blocks or fewer folds")
    sizes = np.bincount(blk, minlength=nb)
    rng = np.random.default_rng(seed)
    order = rng.permutation(nb)
    order = order[np.argsort(-sizes[order], kind="stable")]
    load, fold_of_block = np.zeros(k), np.empty(nb, int)
    for b in order:
        f = int(np.argmin(load)); fold_of_block[b] = f; load[f] += sizes[b]
    return {"folds": fold_of_block[blk], "blocks": blk, "n_blocks": nb, "block_ix": ix, "block_iy": iy}


def apply_buffer(xy, folds, fold, buffer_m: float):
    """Training indices for one fold, dropping training points within buffer_m of any test point."""
    te = np.flatnonzero(folds == fold)
    tr = np.flatnonzero((folds != fold) & (folds != -1))
    if buffer_m > 0 and te.size and tr.size:
        d, _ = cKDTree(xy[te]).query(xy[tr], k=1)
        tr = tr[d > buffer_m]
    return tr, te


# ---------------------------------------------------------------- model and metrics
@dataclass
class ModelConfig:
    n_estimators: int = 100
    max_depth: int | None = None
    min_samples_leaf: int = 1
    max_features: str = "sqrt"
    class_weight: str | None = None


def make_pipeline(numeric, categorical, cfg: ModelConfig, seed: int) -> Pipeline:
    """Imputation and encoding are learned inside the pipeline, so in each fold they see training rows only."""
    pre = ColumnTransformer([
        ("num", SimpleImputer(strategy="median"), numeric),
        ("cat", Pipeline([("imp", SimpleImputer(strategy="most_frequent")), ("ohe", OneHotEncoder(handle_unknown="ignore"))]), categorical),
    ], remainder="drop")
    rf = RandomForestClassifier(n_estimators=cfg.n_estimators, max_depth=cfg.max_depth, min_samples_leaf=cfg.min_samples_leaf,
                                max_features=cfg.max_features, class_weight=cfg.class_weight, random_state=seed, n_jobs=1)
    return Pipeline([("pre", pre), ("rf", rf)])


def metrics(y_true, y_pred, labels) -> dict:
    """Metrics over the given label set. Classes absent from both truth and prediction get zero_division=0 and are left out of
    the macro averages (scikit-learn computes macro averages only over labels passed)."""
    present = [l for l in labels if (np.asarray(y_true) == l).any() or (np.asarray(y_pred) == l).any()]
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=present, zero_division=0)
    pm, rm, fm, _ = precision_recall_fscore_support(y_true, y_pred, labels=present, average="macro", zero_division=0)
    pw, rw, fw, _ = precision_recall_fscore_support(y_true, y_pred, labels=present, average="weighted", zero_division=0)
    kappa = cohen_kappa_score(y_true, y_pred, labels=present) if len(present) > 1 else float("nan")
    return {"n": int(len(y_true)), "accuracy": float(accuracy_score(y_true, y_pred)), "kappa": float(kappa),
            "macro": {"precision": float(pm), "recall": float(rm), "f1": float(fm)},
            "weighted": {"precision": float(pw), "recall": float(rw), "f1": float(fw)},
            "per_class": {l: {"precision": float(a), "recall": float(b), "f1": float(c), "support": int(d)} for l, a, b, c, d in zip(present, p, r, f, s)},
            "labels_present": present}


def evaluate(prep: Prepared, folds: np.ndarray, cfg: ModelConfig, seed: int, buffer_m: float = 0.0, progress=None) -> dict:
    """Fit one pipeline per fold on that fold's training rows; predict its test rows. Returns pooled and per-fold metrics,
    the pooled confusion matrix, per-row predictions and train-test distances."""
    ks = sorted(int(f) for f in np.unique(folds) if f >= 0)
    pred = np.full(len(prep.y), None, dtype=object)
    per_fold, dist_med, warnings = [], [], []
    for i, f in enumerate(ks):
        tr, te = apply_buffer(prep.xy, folds, f, buffer_m)
        if te.size == 0:
            warnings.append(f"fold {f + 1} has no test rows"); continue
        if tr.size == 0:
            warnings.append(f"fold {f + 1} has no training rows left"); continue
        missing = sorted(set(prep.classes) - set(np.unique(prep.y[tr])))
        if missing:
            warnings.append(f"fold {f + 1}: classes {', '.join(missing)} are absent from training, so they cannot be predicted")
        model = make_pipeline(prep.numeric, prep.categorical, cfg, seed)
        model.fit(prep.X.iloc[tr], prep.y[tr])
        p = model.predict(prep.X.iloc[te]); pred[te] = p
        d, _ = cKDTree(prep.xy[tr]).query(prep.xy[te], k=1)
        dist_med.append(float(np.median(d)))
        m = metrics(prep.y[te], p, prep.classes)
        m.update({"fold": f, "n_train": int(tr.size), "n_test": int(te.size), "median_test_to_train_m": float(np.median(d)),
                  "test_classes_missing": sorted(set(prep.classes) - set(np.unique(prep.y[te])))})
        per_fold.append(m)
        if progress: progress(i + 1, len(ks))
    done = np.array([p is not None for p in pred])
    yt, yp = prep.y[done], pred[done].astype(str)
    pooled = metrics(yt, yp, prep.classes)
    cm = confusion_matrix(yt, yp, labels=prep.classes)
    accs = [m["accuracy"] for m in per_fold]
    if not done.all():
        warnings.append(f"{int((~done).sum())} rows were not predicted (a fold was skipped); the pooled metrics cover {int(done.sum())} rows")
    return {"pooled": pooled, "confusion_matrix": cm.tolist(), "labels": prep.classes, "per_fold": per_fold,
            "fold_accuracy_mean": float(np.mean(accs)) if accs else float("nan"),
            "fold_accuracy_sd": float(np.std(accs, ddof=1)) if len(accs) > 1 else float("nan"),
            "median_test_to_train_m": float(np.median(dist_med)) if dist_med else float("nan"),
            "predictions": [None if p is None else str(p) for p in pred], "warnings": warnings}


# ---------------------------------------------------------------- one call for the page
def run(df: pd.DataFrame, cfg: dict, progress=None) -> dict:
    """cfg: target, x, y, features, crs, k, seed, block_km, buffer_km, holdout_share, method ('compare' | 'holdout'),
    model (ModelConfig fields), text_sha256."""
    check_crs(cfg["crs"])
    model_cfg = ModelConfig(**cfg.get("model", {}))
    prep = prepare(df, cfg["target"], cfg["x"], cfg["y"], cfg["features"], cfg["crs"])
    seed, k = int(cfg.get("seed", 42)), int(cfg.get("k", 5))
    out = {"lonlat": lonlat_of(df, prep.keep, cfg["x"], cfg["y"], cfg["crs"]).round(6).tolist(), "y": prep.y.tolist(), "version": VERSION, "sklearn": SKLEARN_VERSION, "numpy": np.__version__, "pandas": pd.__version__,
           "config": {**{k2: v for k2, v in cfg.items() if k2 != "model"}, "model": asdict(model_cfg)},
           "rows_used": int(prep.keep.size), "rows_total": int(len(df)), "projection": prep.projection,
           "numeric": prep.numeric, "categorical": prep.categorical, "classes": prep.classes, "kept_index": prep.keep.tolist(),
           "xy": prep.xy.round(2).tolist()}
    step = lambda name: (lambda i, n: progress and progress(f"{name}: fold {i} of {n}"))
    if cfg.get("method", "compare") == "holdout":
        folds = holdout(prep.y, float(cfg.get("holdout_share", 0.25)), seed)
        out["random"] = evaluate(prep, folds, model_cfg, seed, 0.0, step("Random hold-out"))
        out["random"]["folds"] = folds.tolist(); out["random"]["design"] = "random hold-out"
    else:
        rf, strat = random_folds(prep.y, k, seed)
        out["random"] = evaluate(prep, rf, model_cfg, seed, 0.0, step("Random k-fold"))
        out["random"]["folds"] = rf.tolist()
        out["random"]["design"] = f"stratified random {k}-fold" if strat else f"random {k}-fold (not stratified)"
        if not strat:
            out["random"]["warnings"].append(f"the smallest class has fewer than {k} rows, so the random folds are not stratified")
    sp = spatial_folds(prep.xy, float(cfg.get("block_km", 10)) * 1000, k, seed)
    out["spatial"] = evaluate(prep, sp["folds"], model_cfg, seed, float(cfg.get("buffer_km", 0)) * 1000, step("Spatial block k-fold"))
    out["spatial"].update({"folds": sp["folds"].tolist(), "blocks": sp["blocks"].tolist(), "n_blocks": sp["n_blocks"],
                           "block_polygons": block_polygons(prep, float(cfg.get("block_km", 10)) * 1000, sp["block_ix"], sp["block_iy"], sp["blocks"], sp["folds"]),
                           "design": f"spatial block {k}-fold, {cfg.get('block_km', 10)} km blocks" + (f", {cfg.get('buffer_km')} km buffer" if float(cfg.get('buffer_km', 0)) > 0 else "")})
    sizes = np.bincount(sp["folds"], minlength=k)
    out["spatial"]["fold_sizes"] = sizes.tolist()
    out["spatial"]["fold_class_counts"] = [{c: int(((sp["folds"] == f) & (prep.y == c)).sum()) for c in prep.classes} for f in range(k)]
    return out


def sweep(df: pd.DataFrame, cfg: dict, blocks_km: list, progress=None) -> dict:
    """Spatial-block accuracy for several block sizes, with the same model, seed and folds count."""
    model_cfg = ModelConfig(**cfg.get("model", {}))
    prep = prepare(df, cfg["target"], cfg["x"], cfg["y"], cfg["features"], cfg["crs"])
    seed, k = int(cfg.get("seed", 42)), int(cfg.get("k", 5))
    rows = []
    for i, b in enumerate(blocks_km):
        try:
            sp = spatial_folds(prep.xy, b * 1000, k, seed)
            r = evaluate(prep, sp["folds"], model_cfg, seed, float(cfg.get("buffer_km", 0)) * 1000)
            rows.append({"block_km": b, "accuracy": r["pooled"]["accuracy"], "macro_f1": r["pooled"]["macro"]["f1"],
                         "kappa": r["pooled"]["kappa"], "fold_sd": r["fold_accuracy_sd"], "n_blocks": sp["n_blocks"],
                         "median_test_to_train_m": r["median_test_to_train_m"]})
        except ValueError as e:
            rows.append({"block_km": b, "error": str(e)})
        if progress: progress(f"Block size {b:g} km ({i + 1} of {len(blocks_km)})")
    return {"rows": rows}
