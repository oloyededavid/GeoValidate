"""Regression tests for the issues found in the independent review. Run: python3 tests/regression_test.py"""
import json, sys
import numpy as np, pandas as pd
sys.path.insert(0, "py")
import geovalidate as gv
fails = 0
def check(name, cond, info=""):
    global fails
    print(("PASS " if cond else "FAIL ") + name + (f"  {info}" if info else "")); fails += 0 if cond else 1

rng = np.random.default_rng(0)
n = 300
df = pd.DataFrame({"lon": 36 + rng.random(n) * 0.5, "lat": -0.5 + rng.random(n) * 0.5, "a": rng.random(n), "b": rng.random(n),
                   "soil": rng.choice(["clay", "sand", "loam"], n), "y": rng.choice(["u", "v", "w"], n)})
df.loc[[3, 17, 40], "soil"] = None
base = {"target": "y", "x": "lon", "y": "lat", "crs": "EPSG:4326", "k": 4, "seed": 1, "block_km": 10, "model": {"n_estimators": 20}}

# hold-out returns JSON the browser can parse (no bare NaN)
out = gv.to_json(gv.run(df, {**base, "features": ["a", "b"], "method": "holdout"}))
check("hold-out result is valid JSON without NaN", "NaN" not in out and json.loads(out)["random"]["design"] == "random hold-out")
# categorical predictor with missing values runs
try:
    r = gv.run(df, {**base, "features": ["a", "soil"]}); check("categorical predictor with missing values runs", r["random"]["pooled"]["n"] == n)
except Exception as e:
    check("categorical predictor with missing values runs", False, str(e))
# stratified label follows the splitter actually used
small = df.copy(); small.loc[:1, "y"] = "rare"
r = gv.run(small, {**base, "features": ["a"]})
check("design label says not stratified when a class is smaller than k", "not stratified" in r["random"]["design"], r["random"]["design"])
# leakage heuristic: a near-unique numeric column is not flagged; a categorical copy of the target is
q = gv.inspect(df.assign(c=df["y"].map({"u": "x1", "v": "x2", "w": "x3"})), "y", "lon", "lat", ["a", "c"], "EPSG:4326")
w = {f["name"]: f["warnings"] for f in q["features"]}
check("numeric near-unique column not flagged as leakage", not any("leakage" in x for x in w["a"]))
check("categorical copy of the target flagged as leakage", any("leakage" in x for x in w["c"]))
# non-numeric values in a numeric column are reported
q2 = gv.inspect(df.assign(a=df["a"].astype(object).where(df.index > 5, "n/a")), "y", "lon", "lat", ["a"], "EPSG:4326")
check("non-numeric values in a numeric column reported", any("non-numeric" in x for x in q2["features"][0]["warnings"]))
# global data: points on both sides of the 180 degree meridian stay together; very spread data get a warning
xy, proj = gv.project_aeqd(np.array([179.5, 179.8, -179.9, -179.6]), np.array([-17.5, -17.6, -17.7, -17.8]))
check("points across the 180 degree meridian project close together", np.ptp(xy[:, 0]) < 100e3, f"{np.ptp(xy[:, 0]) / 1e3:.1f} km; {proj}")
wide = df.assign(lon=np.linspace(-60, 60, len(df)))
check("data spread over continents get a block-size warning", any("stretches blocks" in p for p in gv.inspect(wide, "y", "lon", "lat", ["a"], "EPSG:4326")["problems"]))
check("compact data get no such warning", not any("stretches blocks" in p for p in gv.inspect(df, "y", "lon", "lat", ["a"], "EPSG:4326")["problems"]))
# block outlines across the 180 degree meridian keep continuous corners
rng = np.random.default_rng(1)
lon = np.concatenate([rng.uniform(179.0, 180, 100), rng.uniform(-180, -179.0, 100)])
fj = pd.DataFrame({"lon": ((lon + 180) % 360) - 180, "lat": rng.uniform(-18, -17, 200), "a": rng.normal(size=200), "y": rng.choice(["u", "v"], 200)})
pv = gv.fold_preview(fj, {"target": "y", "x": "lon", "y": "lat", "features": ["a"], "crs": "EPSG:4326", "k": 5, "seed": 42, "block_km": 10})
span = max(max(c[0] for c in f["geometry"]["coordinates"][0]) - min(c[0] for c in f["geometry"]["coordinates"][0]) for f in pv["blocks"]["features"])
check("block outlines across the 180 degree meridian stay compact", span < 1, f"widest block spans {span:.3f} degrees of longitude")
# unreadable or unsuitable files get plain-language messages
def msg(text, kind):
    try: gv.read_table(text, kind); return ""
    except ValueError as e: return str(e)
check("broken GeoJSON is reported as not valid JSON", "not valid GeoJSON" in msg("not json", "geojson"))
poly = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}, "properties": {"c": "a"}}]})
check("a GeoJSON with no point features asks for points", "needs point features" in msg(poly, "geojson"), msg(poly, "geojson"))
check("an empty CSV is reported as empty", "empty" in msg("", "csv"))
one = gv.inspect(df.assign(lon=df["lon"].where(df.index != 0)), "y", "lon", "lat", ["a"], "EPSG:4326")
check("one missing coordinate reads as one row, not one rows", any(p.startswith("1 row without") for p in one["problems"]), "; ".join(one["problems"])[:120])
bad = msg('a,b\n1,"open quote\n2,3\n', "csv")
check("a CSV with an unclosed quote gets a plain message, not parser text", "could not be read as CSV" in bad and "tokenizing" not in bad, bad)
print(f"{fails} FAILED" if fails else "ALL PASSED"); sys.exit(1 if fails else 0)
