"""Regression gate on fixed inputs: the browser engine's result for the bundled sample must keep its published figures.
Run after tests/pyodide_run.mjs:  python3 tests/check_expected.py RESULT.json
The sample, the seed (42), 5 folds, 10 km blocks and the pinned package versions make these values exact."""
import json, sys

EXPECTED = {"random_accuracy": 0.9324, "random_kappa": 0.9155, "spatial_accuracy": 0.8884, "spatial_kappa": 0.8605,
            "rows_used": 5000, "spatial_blocks": 81}

r = json.load(open(sys.argv[1]))
got = {"random_accuracy": r["random"]["pooled"]["accuracy"], "random_kappa": r["random"]["pooled"]["kappa"],
       "spatial_accuracy": r["spatial"]["pooled"]["accuracy"], "spatial_kappa": r["spatial"]["pooled"]["kappa"],
       "rows_used": r["rows_used"], "spatial_blocks": r["spatial"]["n_blocks"]}
bad = [k for k in EXPECTED if abs(got[k] - EXPECTED[k]) > 1e-9]
for k in EXPECTED:
    print(f"{'PASS' if k not in bad else 'FAIL'} {k}: expected {EXPECTED[k]}, got {got[k]}")
sys.exit(1 if bad else 0)
