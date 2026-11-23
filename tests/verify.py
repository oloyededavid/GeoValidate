"""Independent checks of a GeoValidate result (written by tests/pyodide_run.mjs, i.e. by the browser engine).

1. Metrics are recomputed from the per-row predictions with plain NumPy (no scikit-learn metric functions).
2. Fold assignments are checked: spatial blocks rebuilt with separate code, each block in exactly one fold; random folds stratified.
3. Leakage: the imputer inside a fold's pipeline learns from training rows only.
4. Reproducibility: the CPython engine with the same seed gives the same predictions as the Pyodide engine.
Usage: python3 tests/verify.py RESULT.json"""
import json, sys
import numpy as np, pandas as pd
sys.path.insert(0, "py")
import geovalidate as gv

fails = 0
def check(name, cond, info=""):
    global fails
    print(("PASS " if cond else "FAIL ") + name + (f"  {info}" if info else ""))
    fails += 0 if cond else 1

res = json.load(open(sys.argv[1]))
text = open("data/sample_mau_forest.csv").read()
df = gv.read_table(text, "csv")
y = df["land_cover"].astype(str).to_numpy()[res["kept_index"]]
labels = res["classes"]

def np_metrics(t, p):
    L = [l for l in labels if (t == l).any() or (p == l).any()]
    idx = {l: i for i, l in enumerate(L)}
    cm = np.zeros((len(L), len(L)), int)
    for a, b in zip(t, p): cm[idx[a], idx[b]] += 1
    tp = np.diag(cm).astype(float); col = cm.sum(0); row = cm.sum(1); n = cm.sum()
    prec = np.divide(tp, col, out=np.zeros_like(tp), where=col > 0)
    rec = np.divide(tp, row, out=np.zeros_like(tp), where=row > 0)
    f1 = np.divide(2 * prec * rec, prec + rec, out=np.zeros_like(tp), where=(prec + rec) > 0)
    po = tp.sum() / n; pe = (row * col).sum() / n ** 2
    return {"accuracy": po, "kappa": (po - pe) / (1 - pe), "macro_f1": f1.mean(), "macro_p": prec.mean(), "macro_r": rec.mean(),
            "weighted_f1": (f1 * row).sum() / n, "cm": cm}

for m in ["random", "spatial"]:
    r = res[m]; pred = np.array(r["predictions"], dtype=object); ok = np.array([p is not None for p in pred])
    t, p = y[ok], pred[ok].astype(str)
    mine = np_metrics(t, p)
    check(f"{m}: accuracy recomputed", abs(mine["accuracy"] - r["pooled"]["accuracy"]) < 1e-12, f"{mine['accuracy']:.6f}")
    check(f"{m}: kappa recomputed", abs(mine["kappa"] - r["pooled"]["kappa"]) < 1e-12, f"{mine['kappa']:.6f}")
    check(f"{m}: macro precision, recall, F1 recomputed", max(abs(mine["macro_p"] - r["pooled"]["macro"]["precision"]), abs(mine["macro_r"] - r["pooled"]["macro"]["recall"]), abs(mine["macro_f1"] - r["pooled"]["macro"]["f1"])) < 1e-12)
    check(f"{m}: weighted F1 recomputed", abs(mine["weighted_f1"] - r["pooled"]["weighted"]["f1"]) < 1e-12)
    check(f"{m}: confusion matrix recomputed", np.array_equal(mine["cm"], np.array(r["confusion_matrix"])))
    check(f"{m}: every row predicted once", ok.all())
    for fm in r["per_fold"]:
        sel = np.array(r["folds"]) == fm["fold"]
        acc = (y[sel] == pred[sel].astype(str)).mean()
        if abs(acc - fm["accuracy"]) > 1e-12: check(f"{m}: fold {fm['fold']} accuracy", False)
    check(f"{m}: per-fold accuracies recomputed", True)

# folds
sp = np.array(res["spatial"]["folds"]); blk = np.array(res["spatial"]["blocks"]); xy = np.array(res["xy"])
check("spatial: each block in exactly one fold", all(len(set(sp[blk == b])) == 1 for b in np.unique(blk)))
bkm = res["config"]["block_km"] * 1000
ix = np.floor((xy[:, 0] - xy[:, 0].min()) / bkm).astype(int); iy = np.floor((xy[:, 1] - xy[:, 1].min()) / bkm).astype(int)
pairs = {}
for b, key in zip(blk, zip(ix, iy)): pairs.setdefault(b, set()).add(key)
check("spatial: blocks rebuilt independently match", all(len(v) == 1 for v in pairs.values()) and len(set(map(lambda v: next(iter(v)), pairs.values()))) == len(pairs),
      f"{len(pairs)} blocks of {bkm / 1000:g} km")
sizes = np.bincount(sp)
check("spatial: folds balanced within the largest block", sizes.max() - sizes.min() <= np.bincount(blk).max(), f"sizes {sizes.tolist()}")
rf = np.array(res["random"]["folds"])
cnt = pd.crosstab(rf, y)
check("random: stratified (class counts per fold differ by at most 1)", int((cnt.max() - cnt.min()).max()) <= 1)
d_rand, d_sp = res["random"]["median_test_to_train_m"], res["spatial"]["median_test_to_train_m"]
check("spatial test rows are farther from training rows than random ones", d_sp > d_rand, f"{d_rand:.0f} m vs {d_sp:.0f} m")

# leakage: imputer median comes from training rows only
toy = pd.DataFrame({"a": [1.0, 2.0, np.nan, 100.0, 200.0, 300.0]})
pipe = gv.make_pipeline(["a"], [], gv.ModelConfig(n_estimators=5), 0)
pipe.fit(toy.iloc[:3], np.array(["u", "v", "u"]))
med = pipe.named_steps["pre"].named_transformers_["num"].statistics_[0]
check("leakage: imputer median learned from training rows only", med == 1.5, f"median {med} (all rows would give 100)")

# reproducibility in CPython with the same configuration
feats = res["config"]["features"]
again = gv.run(df, {k: v for k, v in res["config"].items()})
for m in ["random", "spatial"]:
    same = np.mean(np.array(again[m]["predictions"], dtype=object) == np.array(res[m]["predictions"], dtype=object))
    check(f"{m}: CPython rerun reproduces the Pyodide predictions", same == 1.0, f"{same:.4%} identical (scikit-learn {gv.SKLEARN_VERSION} vs {res['sklearn']})")
print(f"{fails} FAILED" if fails else "ALL PASSED")
sys.exit(1 if fails else 0)
