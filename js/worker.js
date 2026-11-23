/* GeoValidate worker: runs py/geovalidate.py in Pyodide 0.26.4 (scikit-learn 1.4.2). The page only displays what this returns. */
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
importScripts(PYODIDE + 'pyodide.js');
let py = null, ready = null;
const send = (type, data) => self.postMessage({ type, ...data });

async function init(id) {
  if (ready) return ready;
  ready = (async () => {
    send('progress', { id, msg: 'Loading Python (Pyodide 0.26.4)' });
    py = await loadPyodide({ indexURL: PYODIDE });
    send('progress', { id, msg: 'Loading NumPy, pandas, SciPy, scikit-learn and pyproj' });
    await py.loadPackage(['numpy', 'pandas', 'scipy', 'scikit-learn', 'pyproj']);
    const src = await (await fetch(new URL('../py/geovalidate.py', self.location.href))).text();
    py.FS.writeFile('/home/pyodide/geovalidate.py', src);
    await py.runPythonAsync(`import sys, json; sys.path.insert(0, '/home/pyodide'); import geovalidate as gv; DF = None`);
    const v = JSON.parse(await py.runPythonAsync(`json.dumps({'engine': gv.VERSION, 'sklearn': gv.SKLEARN_VERSION})`));
    send('progress', { id, msg: `Engine ready: GeoValidate ${v.engine}, scikit-learn ${v.sklearn}` });
    return v;
  })();
  return ready;
}

async function call(code, vars = {}) {
  for (const [k, v] of Object.entries(vars)) py.globals.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return JSON.parse(await py.runPythonAsync(code));
}

self.onmessage = async ({ data: m }) => {
  const id = m.id;
  try {
    await init(id);
    py.globals.set('report', (msg) => send('progress', { id, msg }));
    let out;
    if (m.cmd === 'init') out = await ready;
    else if (m.cmd === 'load') {
      out = await call(`
TEXTSHA = gv.fingerprint(TEXT)
DF = gv.read_table(TEXT, KIND)
json.dumps({'columns': list(DF.columns), 'rows': len(DF), 'guess': gv.guess_columns(DF), 'sha256': TEXTSHA,
            'head': json.loads(DF.head(5).to_json(orient='values', double_precision=6))})`, { TEXT: m.text, KIND: m.kind });
    } else if (m.cmd === 'inspect') {
      out = await call(`c = json.loads(CFG); json.dumps(gv.inspect(DF, c['target'], c['x'], c['y'], c['features'], c['crs']))`, { CFG: m.cfg });
    } else if (m.cmd === 'preview') {
      out = await call(`json.dumps(gv.fold_preview(DF, json.loads(CFG)))`, { CFG: m.cfg });
    } else if (m.cmd === 'run') {
      out = await call(`json.dumps(gv.run(DF, json.loads(CFG), progress=report))`, { CFG: m.cfg });
    } else if (m.cmd === 'sweep') {
      out = await call(`json.dumps(gv.sweep(DF, json.loads(CFG), json.loads(BLOCKS), progress=report))`, { CFG: m.cfg, BLOCKS: m.blocks });
    } else throw new Error('Unknown command');
    send('done', { id, out });
  } catch (e) {
    const msg = String(e && e.message || e), last = msg.trim().split('\n').filter(Boolean).pop();
    send('error', { id, message: last && last.includes('Error:') ? last.slice(last.indexOf('Error:') + 7) : msg });
  }
};
