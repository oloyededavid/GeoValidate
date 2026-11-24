/* GeoValidate worker: runs py/geovalidate.py in Pyodide 0.26.4 (scikit-learn 1.4.2). The page only displays what this returns.
   The engine starts in four reported stages. If a stage fails the worker answers with an error flagged `engine: true` and a message
   that names the stage, and it forgets the failed attempt so the page's Try again button can start over. */
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const PACKAGES = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'pyproj'];
let py = null, ready = null;
const send = (type, data) => self.postMessage({ type, ...data });

class EngineError extends Error {}
const STAGES = 4;
const stage = (id, n, msg, frac) => send('progress', { id, msg, stage: n, stages: STAGES, frac });
const why = e => String((e && e.message) || e).split('\n')[0].slice(0, 160);

async function init(id) {
  if (ready) return ready;
  ready = (async () => {
    try {
      stage(id, 1, 'Downloading the Python runtime (Pyodide 0.26.4)', 0.03);
      try { importScripts(PYODIDE + 'pyodide.js'); }
      catch (e) { throw new EngineError(`The Python runtime could not be downloaded from cdn.jsdelivr.net (${why(e)}). Check your internet connection, or whether a network filter blocks that address, then try again.`); }
      try { py = await loadPyodide({ indexURL: PYODIDE }); }
      catch (e) { throw new EngineError(`The Python runtime was downloaded but did not start (${why(e)}). Try again.`); }

      // packages: the bulk of the download (about 36 MB in total). Pyodide reports "Loading a, b" then "Loaded a, b"; the bar follows the count of packages loaded
      let total = PACKAGES.length, loaded = 0;
      stage(id, 2, `Downloading Python packages: ${PACKAGES.join(', ')} (about 36 MB in total)`, 0.25);
      try {
        await py.loadPackage(PACKAGES, {
          messageCallback: m => {
            const g = /^Loading (.+)$/.exec(m), d = /^Loaded (.+)$/.exec(m);
            if (g) total = Math.max(total, g[1].split(',').length);
            if (d) { loaded += d[1].split(',').length; stage(id, 2, `Downloaded ${Math.min(loaded, total)} of ${total} packages (${d[1].trim()})`, 0.25 + 0.6 * Math.min(1, loaded / total)); }
          },
          errorCallback: () => {},
        });
      } catch (e) { throw new EngineError(`The Python packages (NumPy, pandas, SciPy, scikit-learn, pyproj) could not be downloaded (${why(e)}). Check your internet connection and try again.`); }

      stage(id, 3, 'Loading the GeoValidate engine', 0.9);
      try {
        const r = await fetch(new URL('../py/geovalidate.py', self.location.href));
        if (!r.ok) throw new Error(`py/geovalidate.py answered ${r.status}`);
        py.FS.writeFile('/home/pyodide/geovalidate.py', await r.text());
        await py.runPythonAsync(`import sys, json; sys.path.insert(0, '/home/pyodide'); import geovalidate as gv; DF = None`);
      } catch (e) { throw new EngineError(`The GeoValidate engine could not be loaded (${why(e)}). Reload the page and try again.`); }
      const v = JSON.parse(await py.runPythonAsync(`json.dumps({'engine': gv.VERSION, 'sklearn': gv.SKLEARN_VERSION})`));
      stage(id, 4, `Engine ready: GeoValidate ${v.engine}, scikit-learn ${v.sklearn}`, 1);
      return v;
    } catch (e) { ready = null; py = null; throw e; }   // forget the failed attempt so a retry starts clean
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
      out = await call(`c = json.loads(CFG); gv.to_json(gv.inspect(DF, c['target'], c['x'], c['y'], c['features'], c['crs']))`, { CFG: m.cfg });
    } else if (m.cmd === 'preview') {
      out = await call(`gv.to_json(gv.fold_preview(DF, json.loads(CFG)))`, { CFG: m.cfg });
    } else if (m.cmd === 'run') {
      out = await call(`gv.to_json(gv.run(DF, json.loads(CFG), progress=report))`, { CFG: m.cfg });
    } else if (m.cmd === 'sweep') {
      out = await call(`gv.to_json(gv.sweep(DF, json.loads(CFG), json.loads(BLOCKS), progress=report))`, { CFG: m.cfg, BLOCKS: m.blocks });
    } else throw new Error('Unknown command');
    send('done', { id, out });
  } catch (e) {
    const msg = String(e && e.message || e), last = msg.trim().split('\n').filter(Boolean).pop();
    send('error', { id, engine: e instanceof EngineError, message: e instanceof EngineError ? e.message : last && last.includes('Error:') ? last.slice(last.indexOf('Error:') + 7) : msg });
  }
};
