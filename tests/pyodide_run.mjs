// Runs py/geovalidate.py inside Pyodide 0.26.4 (the browser engine) under Node and writes the result JSON.
// Usage: node tests/pyodide_run.mjs OUT.json [block_km]
import { loadPyodide } from 'pyodide';
import { readFileSync, writeFileSync } from 'node:fs';
const out = process.argv[2], block = +(process.argv[3] || 10);
const py = await loadPyodide({ packageBaseUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
await py.loadPackage(['numpy', 'pandas', 'scipy', 'scikit-learn', 'pyproj']);
py.FS.writeFile('/home/pyodide/geovalidate.py', readFileSync(new URL('../py/geovalidate.py', import.meta.url), 'utf8'));
py.globals.set('TEXT', readFileSync(new URL('../data/sample_mau_forest.csv', import.meta.url), 'utf8'));
py.globals.set('BLOCK', block);
const t0 = Date.now();
const res = await py.runPythonAsync(`
import sys, json; sys.path.insert(0, '/home/pyodide')
import geovalidate as gv
df = gv.read_table(TEXT, 'csv')
feats = [c for c in df.columns if c not in ('id', 'lon', 'lat', 'land_cover')]
out = gv.run(df, {'target': 'land_cover', 'x': 'lon', 'y': 'lat', 'features': feats, 'crs': 'EPSG:4326', 'k': 5, 'seed': 42, 'block_km': BLOCK})
json.dumps(out)`);
writeFileSync(out, res);
const r = JSON.parse(res);
console.log('pyodide sklearn', r.sklearn, 'seconds', (Date.now() - t0) / 1000);
for (const m of ['random', 'spatial']) console.log(m, r[m].design, r[m].pooled.accuracy.toFixed(4), r[m].pooled.macro.f1.toFixed(4));
