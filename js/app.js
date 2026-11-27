/* GeoValidate page: welcome, three steps (data, setup, result), export. All numbers come from the worker (py/geovalidate.py in Pyodide). */
import { VERSION } from './version.js';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v, d = 1) => v == null || !(v === v) ? '—' : `${(v * 100).toFixed(d)}%`;
const num = (v, d = 3) => v == null || !(v === v) ? '—' : v.toFixed(d);
const km = m => m == null || !(m === m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
const BLOCKS = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100];
// categorical colours chosen so neighbours stay apart under protan, deutan and tritan vision (project-notes/tools/colour_check.py)
const FOLD_COLORS = ['#0072b2', '#f0e442', '#d55e00', '#66ccee', '#882255', '#332288', '#cc79a7', '#e69f00', '#6a6963', '#009e73'];
const CLASS_COLORS = FOLD_COLORS;
const MAX_BYTES = 20 * 1024 * 1024;
const PHONE = matchMedia('(max-width: 860px)').matches;
document.querySelectorAll('[data-ver]').forEach(e => { e.textContent = VERSION; });

// ---------------------------------------------------------------- worker
const worker = new Worker(new URL('./worker.js', import.meta.url));
let seq = 0; const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id); if (!p) return;
  if (data.type === 'progress') { p.onProgress && p.onProgress(data.msg, data); return; }
  pending.delete(data.id);
  if (data.type === 'error') { const err = new Error(data.message); err.engine = !!data.engine; p.reject(err); } else p.resolve(data.out);
};
worker.onerror = e => {
  const err = new Error(`The analysis engine stopped (${e.message || 'script error'}). Reload the page and try again.`); err.engine = true;
  for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
};
const ask = (cmd, payload = {}, onProgress) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ cmd, id, ...payload }); });

// ---------------------------------------------------------------- state and views
const S = { text: null, name: null, kind: null, meta: null, preview: null, previewOk: false, result: null, view: 'data', mapView: 'folds', sweep: null, running: false, stale: false, log: [] };
const STEP_OF = { data: 'data', setup: 'setup', running: 'setup', error: 'setup', result: 'result' };
const ORDER = ['data', 'setup', 'result'];
function show(v) {
  S.view = v;
  document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== v; });
  syncStepper();
  $('app').querySelector('.panel').scrollTop = 0;
  const h = document.querySelector(`[data-view="${v}"] h2`); if (h && $('welcome').hidden) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  if (v === 'result' && S.result) requestAnimationFrame(() => { drawFolds(S.result); drawSweep(); });
}
function syncStepper() {
  const cur = ORDER.indexOf(STEP_OF[S.view]);
  const can = { data: !S.running, setup: !S.running && !!S.meta, result: !S.running && !!S.result };
  document.querySelectorAll('#stepper li').forEach(li => {
    const k = ORDER.indexOf(li.dataset.s), b = li.querySelector('button');
    li.classList.toggle('on', k === cur); li.classList.toggle('done', k < cur);
    b.disabled = !can[li.dataset.s]; b.setAttribute('aria-current', k === cur ? 'step' : 'false');
  });
  $('to-setup').disabled = !S.meta;
  $('run').disabled = S.running || !S.previewOk || cfg().crs === 'EPSG:';
}
document.querySelectorAll('#stepper button').forEach(b => b.addEventListener('click', () => show(b.parentElement.dataset.s)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => show(b.dataset.goto)));
$('to-setup').addEventListener('click', () => show('setup'));

// welcome and onboarding
function closeWelcome() { $('welcome').hidden = true; $('app').inert = false; $('home').hidden = false; document.body.classList.remove('welcoming'); map.resize(); }
document.body.classList.add('welcoming'); $('app').inert = true;
$('home').addEventListener('click', () => { if (!S.running) show('data'); });
$('how-open').addEventListener('click', () => openTour(0));
const TOUR = [
  { h: 'Add your points', t: 'A CSV or GeoJSON of labelled points with coordinates and predictors. The file is read in your browser and never uploaded.',
    art: '<div class="mk"><div class="mk-field" style="justify-content:center;border-style:dashed">Drop a CSV or GeoJSON file</div><div class="mk-chips"><span>class</span><span>lon</span><span>lat</span><span>B2</span><span>B3</span><span>NDVI</span><span>slope</span></div></div>' },
  { h: 'Check and set the blocks', t: 'GeoValidate guesses the columns and checks the data. Pick the block size: whole blocks of that size are held out for testing.',
    art: '<div class="mk"><div class="mk-row"><div class="mk-field sel">class<span>▾</span></div><div class="mk-field sel">lon<span>▾</span></div><div class="mk-field sel">lat<span>▾</span></div></div><div class="mk-field">Block size: 10 km</div></div>' },
  { h: 'Compare and export', t: 'See random against spatial accuracy, fold by fold and class by class, then export the evaluation, folds and settings.',
    art: '<div class="mk"><div class="mk-verdict">Spatial blocks score 4.4 points lower</div><div class="mk-chips"><span>Report</span><span>Evaluation CSV</span><span>Fold map</span><span>Config</span></div></div>' },
];
let tourAt = 0;
function renderTour() {
  const T = TOUR[tourAt];
  $('tour-art').innerHTML = T.art; $('tour-n').textContent = `Step ${tourAt + 1} of ${TOUR.length}`; $('tour-h').textContent = T.h; $('tour-t').textContent = T.t;
  document.querySelectorAll('#tour-dots i').forEach((d, i) => d.classList.toggle('on', i === tourAt));
  $('tour-next').textContent = tourAt === TOUR.length - 1 ? 'Start' : 'Next'; $('tour-skip').hidden = tourAt === TOUR.length - 1;
}
function openTour(k) { tourAt = k; renderTour(); if (!$('tour').open) $('tour').showModal(); $('tour-next').focus(); }
const remember = () => { try { localStorage.setItem('geovalidate.tour', '1'); } catch { /* storage may be blocked */ } };
function closeTour() { $('tour').close(); remember(); }
function firstTour() { let seen = false; try { seen = localStorage.getItem('geovalidate.tour') === '1'; } catch { /* treat as not seen */ } if (!seen) openTour(0); }
$('tour-next').addEventListener('click', () => { if (tourAt < TOUR.length - 1) { tourAt++; renderTour(); } else closeTour(); });
$('tour-skip').addEventListener('click', closeTour);
$('tour').addEventListener('cancel', remember);

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [10, 15], zoom: 1.6, attributionControl: false, preserveDrawingBuffer: true });
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ecef' } }] };
let styleFallback = false;
map.on('error', e => { if (styleFallback || map.isStyleLoaded() || (e && e.sourceId)) return; styleFallback = true; $('mapnote').hidden = false; map.setStyle(FALLBACK_STYLE); });
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
if (!PHONE) map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
if (PHONE) map.once('load', () => document.querySelectorAll('.maplibregl-ctrl-attrib').forEach(e => { e.classList.remove('maplibregl-compact-show'); e.removeAttribute('open'); }));
const mapReady = new Promise(r => map.on('load', r));
mapReady.then(() => {
  map.addSource('blocks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('pts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'blocks-fill', type: 'fill', source: 'blocks', paint: { 'fill-color': ['to-color', ['get', 'color']], 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'blocks-line', type: 'line', source: 'blocks', paint: { 'line-color': ['to-color', ['get', 'color']], 'line-width': 0.8, 'line-opacity': 0.7 } });
  map.addLayer({ id: 'pts', type: 'circle', source: 'pts', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 3.5, 14, 6], 'circle-color': ['to-color', ['get', 'color']], 'circle-stroke-width': 0.4, 'circle-stroke-color': '#fff' } });
});

// ---------------------------------------------------------------- settings
const cfg = () => {
  const crs = $('c-crs').value === 'EPSG:4326' ? 'EPSG:4326' : `EPSG:${$('c-epsg').value}`;
  return { target: $('c-target').value, x: $('c-x').value, y: $('c-y').value, crs,
    features: [...document.querySelectorAll('#feats input:checked')].map(i => i.value),
    k: +$('k').value, seed: +$('seed').value, block_km: BLOCKS[+$('block').value], buffer_km: +$('buffer').value,
    method: $('holdout').checked ? 'holdout' : 'compare', holdout_share: 0.25,
    model: { n_estimators: Math.max(10, Math.min(500, +$('trees').value || 100)), min_samples_leaf: Math.max(1, +$('leaf').value || 1), class_weight: $('cw').value || null },
    text_sha256: S.meta && S.meta.sha256, file: S.name };
};

// ---------------------------------------------------------------- loading
for (const d of ['drop', 'w-drop']) {
  const el = $(d);
  el.addEventListener('click', () => $('file').click());
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
}
$('file').addEventListener('change', () => { if ($('file').files[0]) readFile($('file').files[0]); $('file').value = ''; });
$('sample').addEventListener('click', () => loadSample());
$('w-example').addEventListener('click', async () => { closeWelcome(); show('data'); if (await loadSample()) runNow(); });

function info(msg, bad) { $('data-info').innerHTML = bad ? `<span class="warn">${esc(msg)}</span>` : msg; }
async function readFile(f) {
  if (!$('welcome').hidden) { closeWelcome(); firstTour(); }
  show('data');
  const ext = f.name.toLowerCase().split('.').pop();
  const kind = ext === 'csv' ? 'csv' : ext === 'geojson' || ext === 'json' ? 'geojson' : null;
  if (!kind) return info(`“${f.name}” is not a CSV or GeoJSON file.`, true);
  if (f.size > MAX_BYTES) return info(`“${f.name}” is ${(f.size / 1048576).toFixed(1)} MB; the limit is 20 MB.`, true);
  const text = await f.text();
  // trivial problems are reported at once, without starting the 36 MB engine
  if (!text.trim()) return info(`“${f.name}” is empty.`, true);
  if (kind === 'csv' && text.trim().split(/\r?\n/).length < 2) return info(`“${f.name}” has a header row but no data rows.`, true);
  if (await load(text, f.name, kind)) show('setup');
}
async function loadSample() {
  try {
    const r = await fetch(new URL('../data/sample_mau_forest.csv', import.meta.url));
    if (!r.ok) throw new Error(`the example file could not be read (${r.status})`);
    const ok = await load(await r.text(), 'sample_mau_forest.csv', 'csv');
    if (!ok && S.meta) show('setup');   // loaded, but the check or fold preview needs attention: show it
    return ok;
  } catch (e) { info(`The example could not be loaded: ${e.message}`, true); return false; }
}
let loadSeq = 0;
async function load(text, name, kind) {
  const myLoad = ++loadSeq; info('Starting the Python engine…'); $('eng-bar-wrap').hidden = false; $('eng-bar').style.width = '2%';
  try {
    const meta = await ask('load', { text, kind }, (m, d) => { info(esc(m)); if (d && typeof d.frac === 'number') $('eng-bar').style.width = `${Math.round(100 * d.frac)}%`; });
    $('eng-bar').style.width = '100%';
    Object.assign(S, { text, name, kind, meta, result: null, preview: null, previewOk: false, sweep: null, stale: false, mapView: 'folds' });
    $('view').value = 'folds'; clearResult();
    info(`<b>${esc(name)}</b> · ${meta.rows.toLocaleString('en-GB')} rows · ${meta.columns.length} columns`);
    $('setup-file').textContent = `${name} · ${meta.rows.toLocaleString('en-GB')} rows`;
    await fillColumns(meta);
    syncStepper(); return S.previewOk;
  } catch (e) {
    info(e.message, true);
    if (e.engine) {   // the engine did not start: offer to try again with the same file, without asking for it again
      $('data-info').insertAdjacentHTML('beforeend', ' <button class="btn ghost sm" type="button" id="retry">Try again</button>');
      $('retry').addEventListener('click', async () => { if (await load(text, name, kind)) show('setup'); }, { once: true });
    }
    syncStepper(); return false;
  } finally { setTimeout(() => { if (myLoad === loadSeq) $('eng-bar-wrap').hidden = true; }, 600); }
}
function fillColumns(meta) {
  const opts = (sel, pick) => { sel.innerHTML = meta.columns.map(c => `<option${c === pick ? ' selected' : ''}>${esc(c)}</option>`).join(''); };
  opts($('c-target'), meta.guess.target); opts($('c-x'), meta.guess.x); opts($('c-y'), meta.guess.y);
  $('feats').innerHTML = ''; renderFeats(); $('quality').innerHTML = '';
  return checkData();
}
function renderFeats(warnings = {}) {
  const used = new Set([$('c-target').value, $('c-x').value, $('c-y').value]);
  const prev = new Set([...document.querySelectorAll('#feats input')].filter(i => !i.checked).map(i => i.value));
  const skip = /^(id|fid|objectid|index|row|col|column|x|y|lon|lat|lng|longitude|latitude)$/i;
  $('feats').innerHTML = S.meta.columns.filter(c => !used.has(c)).map(c =>
    `<label><input type="checkbox" value="${esc(c)}" ${prev.has(c) || skip.test(c) ? '' : 'checked'}> ${esc(c)} ${warnings[c] ? `<span class="w">${esc(warnings[c])}</span>` : ''}</label>`).join('');
  featsSummary();
}
function featsSummary() { const all = document.querySelectorAll('#feats input').length, on = document.querySelectorAll('#feats input:checked').length; $('feats-sum').textContent = `Predictors: ${on} of ${all} columns`; }
['c-target', 'c-x', 'c-y'].forEach(id => $(id).addEventListener('change', () => { renderFeats(); checkData(); }));
$('c-crs').addEventListener('change', () => { $('epsg-box').hidden = $('c-crs').value === 'EPSG:4326'; checkData(); });
$('c-epsg').addEventListener('change', checkData);
$('feats').addEventListener('change', () => { featsSummary(); S.previewOk = false; syncStepper(); checkData(); });

let checkSeq = 0, previewSeq = 0;
async function checkData() {
  if (!S.meta) return;
  const mine = ++checkSeq, c = cfg();
  if (c.crs === 'EPSG:') { $('quality').innerHTML = '<li class="warn">Enter the EPSG code of the projected coordinates.</li>'; S.previewOk = false; syncStepper(); return; }
  try {
    const q = await ask('inspect', { cfg: c });
    if (mine !== checkSeq) return;
    const w = {}; for (const f of q.features) if (f.warnings.length) w[f.name] = f.warnings[0];
    const checked = new Set(c.features); renderFeats(w);
    document.querySelectorAll('#feats input').forEach(i => { i.checked = checked.has(i.value); }); featsSummary();
    const cls = Object.entries(q.classes).map(([k, v]) => `${esc(k)} ${v.toLocaleString('en-GB')}`).join(' · ');
    const problems = q.problems.slice();
    $('quality').innerHTML = `<li>${q.rows.toLocaleString('en-GB')} rows · ${Object.keys(q.classes).length} classes: ${cls}</li>` +
      (problems.length ? problems.map(p => `<li class="warn">${esc(p)}</li>`).join('') : '<li class="ok">No problems found in rows, coordinates or classes.</li>');
    await preview();
  } catch (e) { $('quality').innerHTML = `<li class="warn">${esc(e.message)}</li>`; S.previewOk = false; syncStepper(); }
}

// ---------------------------------------------------------------- design controls and live fold preview
const outs = () => {
  $('o-k').textContent = $('k').value; $('o-block').textContent = `${BLOCKS[+$('block').value]} km`;
  $('o-buffer').textContent = +$('buffer').value ? `${$('buffer').value} km` : 'none';
};
$('block').max = BLOCKS.length - 1; $('block').value = BLOCKS.indexOf(10); outs();
let pvTimer = null;
const settingChanged = () => { clearTimeout(pvTimer); pvTimer = setTimeout(preview, 150); };
['trees', 'leaf', 'cw', 'holdout'].forEach(id => $(id).addEventListener('change', settingChanged));
['k', 'block', 'buffer', 'seed'].forEach(id => $(id).addEventListener('input', () => { outs(); settingChanged(); }));
const keyOf = c => JSON.stringify([c.target, c.x, c.y, c.crs, [...c.features].sort(), +c.k, +c.seed, +c.block_km, +c.buffer_km, c.method, +c.model.n_estimators, +c.model.min_samples_leaf, c.model.class_weight || null]);   // the fields this page sets; the engine adds others to config.model
async function preview() {
  if (!S.meta) return;
  const mine = ++previewSeq;
  try {
    const p = await ask('preview', { cfg: cfg() });
    if (mine !== previewSeq) return;
    S.preview = p; S.previewOk = true;
    // settings changed after a result: the result is cleared, and the map shows the new folds
    if (S.result && !S.running && keyOf(S.result.config) !== keyOf(cfg())) clearResult();
    const empty = p.fold_class_counts.map(c => Object.entries(c).filter(([, n]) => n === 0).map(([k]) => k)).map((e, f) => e.length ? `fold ${f + 1} lacks ${e.join(', ')}` : '').filter(Boolean);
    const minFold = Math.min(...p.fold_sizes);
    $('fold-info').innerHTML = `${p.n_blocks} blocks hold points; fold sizes ${p.fold_sizes.join(', ')}.` + (empty.length ? ` <span class="warn">${esc(empty.join('; '))}.</span>` : '')
      + (minFold < 30 ? ` <span class="warn">The smallest fold has ${minFold} test points; a gap of a few points can arise by chance at this size.</span>` : '');
    syncStepper(); drawMap(true);
  } catch (e) { if (mine !== previewSeq) return; S.previewOk = false; if (S.result && !S.running) clearResult(); $('fold-info').innerHTML = `<span class="warn">${esc(e.message)}</span>`; syncStepper(); }
}

// ---------------------------------------------------------------- map drawing
$('view').addEventListener('change', () => { S.mapView = $('view').value; drawMap(false); });
let fitted = null;
async function drawMap(fit) {
  await mapReady;
  const P = S.result || S.preview; if (!P) return;
  const lonlat = P.lonlat, classes = P.classes, y = P.y;
  const sp = S.result ? S.result.spatial : null, rnd = S.result ? S.result.random : null;
  [...$('view').options].forEach(o => { o.disabled = !S.result && (o.value === 'random' || o.value === 'errors'); });
  if (!S.result && (S.mapView === 'errors' || S.mapView === 'random')) { S.mapView = 'folds'; $('view').value = 'folds'; }
  const spFolds = sp ? sp.folds : P.folds, blocksFC = sp ? sp.block_polygons : P.blocks, v = S.mapView;
  const color = i => {
    if (v === 'folds') return FOLD_COLORS[spFolds[i] % 10];
    if (v === 'random') return rnd.folds[i] < 0 ? '#bdbdb8' : FOLD_COLORS[rnd.folds[i] % 10];
    if (v === 'class') return CLASS_COLORS[classes.indexOf(y[i]) % 10];
    return sp.predictions[i] === y[i] ? '#c9c6bd' : '#b42318';
  };
  map.getSource('pts').setData({ type: 'FeatureCollection', features: lonlat.map((c, i) => ({ type: 'Feature', properties: { color: color(i) }, geometry: { type: 'Point', coordinates: c } })) });
  const showBlocks = v === 'folds' || v === 'errors';
  map.getSource('blocks').setData(showBlocks ? { ...blocksFC, features: blocksFC.features.map(f => ({ ...f, properties: { ...f.properties, color: v === 'folds' ? FOLD_COLORS[f.properties.fold % 10] : '#6a6963' } })) } : { type: 'FeatureCollection', features: [] });
  const key = (S.meta && S.meta.sha256) + lonlat.length;
  if (fit && fitted !== key) {
    const sn = lonlat.reduce((q, c) => q + Math.sin(c[0] * Math.PI / 180), 0), cs = lonlat.reduce((q, c) => q + Math.cos(c[0] * Math.PI / 180), 0);
    const lon0 = Math.atan2(sn, cs) * 180 / Math.PI;   // circular mean, as the projection uses
    const xs = lonlat.map(c => lon0 + ((c[0] - lon0 + 540) % 360) - 180), ys = lonlat.map(c => c[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: PHONE ? 30 : { top: 60, bottom: 40, left: 40, right: 300 }, duration: 700 }); fitted = key;
  }
  const k = Math.max(...spFolds) + 1, hold = rnd && rnd.design.includes('hold-out');
  const sw = (c, t) => `<div class="sw"><i style="background:${c}"></i>${t}</div>`;
  $('legend').innerHTML = v === 'class' ? classes.map((c, i) => sw(CLASS_COLORS[i % 10], esc(c))).join('')
    : v === 'errors' ? sw('#b42318', 'wrong under spatial folds') + sw('#c9c6bd', 'right')
    : v === 'random' && hold ? sw(FOLD_COLORS[0], 'test (hold-out)') + sw('#bdbdb8', 'training')
    : Array.from({ length: k }, (_, f) => sw(FOLD_COLORS[f], `fold ${f + 1}`)).join('');
  $('layer-card').hidden = false;
}

// ---------------------------------------------------------------- run
$('run').addEventListener('click', runNow);
const STAGES = ['random', 'spatial', 'sum'];
function stage(k) { const i = STAGES.indexOf(k); document.querySelectorAll('#stages li').forEach(li => { const j = STAGES.indexOf(li.dataset.k); li.className = j < i ? 'ok' : j === i ? 'on' : ''; }); }
async function runNow() {
  if (S.running || !S.previewOk) return;
  const c = cfg();
  clearTimeout(pvTimer); previewSeq++;   // a preview still waiting must not touch the new result
  S.running = true; S.sweep = null; if (S.result) clearResult(); show('running'); stage('random'); $('bar').style.width = '3%'; $('run-step').textContent = ''; S.log = [];
  $('run-what').textContent = `${S.name} · ${c.features.length} predictors · ${c.block_km} km blocks`;
  if (PHONE) $('app').querySelector('.panel').scrollIntoView({ behavior: 'smooth' });
  const t0 = performance.now();
  try {
    const r = await ask('run', { cfg: c }, m => {
      S.log.push(m); $('run-step').textContent = m;
      const f = /fold (\d+) of (\d+)/.exec(m), spatial = /spatial|block/i.test(m);
      if (spatial) stage('spatial');
      if (f) $('bar').style.width = `${Math.round((spatial ? 50 : 3) + 45 * (+f[1] / +f[2]))}%`;
    });
    stage('sum');
    S.result = r; S.running = false; S.runAt = new Date().toISOString(); S.runSeconds = (performance.now() - t0) / 1000;
    $('bar').style.width = '100%';
    render(r); show('result'); drawMap(true);
    if (PHONE) window.scrollTo({ top: $('r-verdict').getBoundingClientRect().top + window.scrollY - 180, behavior: 'smooth' });
  } catch (e) { S.running = false; $('err-msg').textContent = e.message; show('error'); }
}

// ---------------------------------------------------------------- result
function render(r) {
  const a = r.random, b = r.spatial, drop = (a.pooled.accuracy - b.pooled.accuracy) * 100;
  const spread = Math.max(a.per_fold.length > 1 ? a.fold_accuracy_sd : 0, b.per_fold.length > 1 ? b.fold_accuracy_sd : 0) * 100;
  const perFold = Math.round(b.pooled.n / Math.max(1, b.per_fold.length)), small = perFold < 30, noisy = spread > Math.abs(drop);
  $('r-where').textContent = `${S.name} · ${r.rows_used.toLocaleString('en-GB')} points · ${r.config.block_km} km blocks`;
  $('r-verdict').textContent = Math.abs(drop) < 1 ? 'The two designs agree within one point'
    : drop > 0 ? `Spatial blocks score ${drop.toFixed(1)} points lower` : `Spatial blocks score ${(-drop).toFixed(1)} points higher`;
  $('r-reading').textContent = Math.abs(drop) < 1 ? 'On these data, how close test points sit to training points changes the score little.'
    : drop > 0 ? `Random test points sit a median ${km(a.median_test_to_train_m)} from the nearest training point, against ${km(b.median_test_to_train_m)} with blocks; part of the random score may come from that nearness, and part from the different class mix per fold.`
    : 'Held-out blocks scored higher. With one seed and a different class mix per fold, a gap in this direction can arise by chance.';
  const stat = (l, v, d) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('r-stats').innerHTML = stat(a.design.includes('hold-out') ? 'Random hold-out' : 'Random folds', pct(a.pooled.accuracy), `kappa ${num(a.pooled.kappa, 2)}`)
    + stat('Spatial blocks', pct(b.pooled.accuracy), `kappa ${num(b.pooled.kappa, 2)}`)
    + stat('Gap', `${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(1)}<small>pts</small>`, 'spatial against random');
  const caution = small ? `About ${perFold} test points per fold: too few to tell a small gap from chance.`
    : noisy ? `The fold-to-fold spread (±${spread.toFixed(1)} points) is larger than the gap, so the difference is within fold-to-fold variation.` : '';
  $('r-caution').hidden = !caution; $('r-caution').textContent = caution;
  // classes that lose most under spatial blocks
  const cls = r.classes.filter(c => a.pooled.per_class[c] && b.pooled.per_class[c]).map(c => ({ c, dr: a.pooled.per_class[c].recall - b.pooled.per_class[c].recall, dp: a.pooled.per_class[c].precision - b.pooled.per_class[c].precision, ra: a.pooled.per_class[c].recall, rb: b.pooled.per_class[c].recall, pa: a.pooled.per_class[c].precision, pb: b.pooled.per_class[c].precision }));
  const wr = cls.slice().sort((x, y) => y.dr - x.dr)[0], wp = cls.slice().sort((x, y) => y.dp - x.dp)[0], bits = [];
  if (wr && wr.dr >= 0.02) bits.push(`${esc(wr.c)} is missed more often (recall ${num(wr.ra, 2)} → ${num(wr.rb, 2)})`);
  if (wp && wp.dp >= 0.02) bits.push(`more other points are labelled ${esc(wp.c)} (precision ${num(wp.pa, 2)} → ${num(wp.pb, 2)})`);
  $('r-classes').innerHTML = bits.length ? `Under spatial blocks, ${bits.join('; ')}. One seed and one split; rerun with another seed before reading it as a property of the class.` : 'No class loses two points or more of precision or recall under spatial blocks.';
  const card = (m, title) => `<div class="method"><h3>${title}</h3><p class="design">${esc(m.design)}</p>
    <div class="mkg">
      <div class="mki"><span class="v">${pct(m.pooled.accuracy)}</span><span class="u">overall accuracy${m.pooled.n < r.rows_used ? ` (${m.pooled.n} of ${r.rows_used} rows)` : ''}</span></div>
      <div class="mki"><span class="v">${num(m.pooled.macro.f1, 3)}</span><span class="u">macro F1</span></div>
      <div class="mki"><span class="v">${num(m.pooled.kappa, 3)}</span><span class="u">Cohen's kappa</span></div>
      <div class="mki"><span class="v">${m.per_fold.length > 1 ? '±' + pct(m.fold_accuracy_sd) : '—'}</span><span class="u">fold spread (SD)</span></div>
      <div class="mki"><span class="v">${km(m.median_test_to_train_m)}</span><span class="u">test to training (median)</span></div>
      <div class="mki"><span class="v">${num(m.pooled.weighted.f1, 3)}</span><span class="u">weighted F1</span></div>
    </div><div class="cmwrap">${cmTable(m.confusion_matrix, r.classes)}</div>${perClass(m, r.classes)}
    ${m.warnings.length ? `<p class="warn">${m.warnings.map(esc).join('<br>')}</p>` : ''}</div>`;
  $('compare').innerHTML = card(a, 'Random') + card(b, 'Spatial blocks');
  const rows = [
    ['File', `${esc(S.name)}, SHA-256 ${esc(S.meta.sha256.slice(0, 16))}…`],
    ['Rows', `${r.rows_used.toLocaleString('en-GB')} used of ${r.rows_total.toLocaleString('en-GB')}; ${r.classes.length} classes`],
    ['Predictors', `${r.config.features.length}: ${r.config.features.map(esc).join(', ')}`],
    ['Design', `${r.config.method === 'holdout' ? 'random 25% hold-out' : `${r.config.k} random folds`} against ${r.config.k} spatial folds of ${r.config.block_km} km blocks${r.config.buffer_km ? `, ${r.config.buffer_km} km buffer` : ''}; ${b.n_blocks} blocks`],
    ['Model', `Random Forest, ${r.config.model.n_estimators} trees, min. ${r.config.model.min_samples_leaf} per leaf, class weights ${r.config.model.class_weight || 'none'}, seed ${r.config.seed}`],
    ['Projection', esc(r.projection || '')],
    ['Software', `GeoValidate ${esc(r.version)}, scikit-learn ${esc(r.sklearn)} in Pyodide 0.26.4; run in ${S.runSeconds.toFixed(1)} s`],
  ];
  $('r-run').innerHTML = `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  $('c-sweep').hidden = true; $('sweep-reading').textContent = 'Rerun the spatial design with 1 to 20 km blocks to see how the score changes.'; $('sweep').textContent = 'Run the block-size sweep'; $('sweep').disabled = false;
}
function cmTable(cm, labels) {
  const max = Math.max(...cm.flat(), 1), short = s => s.length > 14 ? s.slice(0, 13) + '…' : s;
  return `<table class="cm" aria-label="Confusion matrix, rows are the labels, columns the predictions"><tr><th></th><th colspan="${labels.length}" class="axis">predicted</th></tr>
    ${cm.map((row, i) => `<tr><th class="rowh" title="${esc(labels[i])}">${esc(short(labels[i]))}</th>${row.map((v, j) => {
      const t = v / max, bg = i === j ? `rgba(43,85,199,${0.1 + 0.75 * t})` : v ? `rgba(180,35,24,${0.1 + 0.7 * t})` : '#f4f5f7';
      return `<td style="background:${bg};color:${t > 0.55 ? '#fff' : '#15171c'}" title="${esc(labels[i])} predicted as ${esc(labels[j])}: ${v}">${v}</td>`; }).join('')}</tr>`).join('')}
    <tr><th></th>${labels.map(l => `<th title="${esc(l)}">${esc(l.slice(0, 3))}</th>`).join('')}</tr></table>`;
}
function perClass(m, labels) {
  return `<table class="data-table"><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>n</th></tr></thead><tbody>${
    labels.filter(l => m.pooled.per_class[l]).map(l => { const c = m.pooled.per_class[l]; return `<tr><td>${esc(l)}</td><td>${num(c.precision)}</td><td>${num(c.recall)}</td><td>${num(c.f1)}</td><td>${c.support}</td></tr>`; }).join('')}</tbody></table>`;
}
function clearResult() {
  S.result = null; S.sweep = null;
  if (S.preview) drawMap(false);
  syncStepper();
}
$('new-run').addEventListener('click', () => show('data'));

// ---------------------------------------------------------------- charts
function fitCanvas(c, h) {
  const W = c.clientWidth || c.parentElement.clientWidth || 360, dpr = window.devicePixelRatio || 1;
  c.width = Math.round(W * dpr); c.height = Math.round(h * dpr); c.style.height = `${h}px`;
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, W, H: h };
}
function axes(ctx, W, H, pad, lo, hi, xlabel) {
  ctx.clearRect(0, 0, W, H); ctx.font = '12px Satoshi, system-ui, sans-serif'; ctx.fillStyle = '#5f6675'; ctx.strokeStyle = '#e7e9ee'; ctx.lineWidth = 1;
  const Y = v => H - pad.b - (v - lo) / (hi - lo) * (H - pad.t - pad.b);
  for (let v = Math.ceil(lo * 20) / 20; v <= hi + 1e-9; v += 0.05) { ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(`${Math.round(v * 100)}%`, pad.l - 6, Y(v) + 4); }
  ctx.textAlign = 'center'; if (xlabel) ctx.fillText(xlabel, (W + pad.l) / 2, H - 4); return Y;
}
function drawFolds(r) {
  const c = $('c-folds'); if (c.closest('[hidden]')) return;
  const { ctx, W, H } = fitCanvas(c, 200), pad = { l: 40, r: 8, t: 12, b: 30 };
  const all = [...r.random.per_fold, ...r.spatial.per_fold].map(f => f.accuracy).concat([r.random.pooled.accuracy, r.spatial.pooled.accuracy]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...all) + 0.01) * 20) / 20);
  const Y = axes(ctx, W, H, pad, lo, hi, '');
  [[r.random, 'Random', 0.3], [r.spatial, 'Spatial blocks', 0.72]].forEach(([m, name, fx]) => {
    const x = pad.l + fx * (W - pad.l - pad.r), half = Math.min(50, (W - pad.l - pad.r) * 0.2);
    ctx.strokeStyle = '#15171c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - half, Y(m.pooled.accuracy)); ctx.lineTo(x + half, Y(m.pooled.accuracy)); ctx.stroke();
    m.per_fold.forEach((f, i) => { ctx.fillStyle = FOLD_COLORS[f.fold % 10]; ctx.beginPath(); ctx.arc(x - half * 0.6 + (i / Math.max(1, m.per_fold.length - 1)) * half * 1.2, Y(f.accuracy), 4.5, 0, 7); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke(); });
    ctx.fillStyle = '#15171c'; ctx.font = '500 13px Satoshi, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${name} ${pct(m.pooled.accuracy)}`, x, H - 8);
  });
}
function drawSweep() {
  const c = $('c-sweep'); if (!S.sweep || !S.result || c.hidden || c.closest('[hidden]')) return;
  const { ctx, W, H } = fitCanvas(c, 200), pad = { l: 40, r: 8, t: 12, b: 40 };
  const rows = S.sweep.rows.filter(r => r.accuracy != null), base = S.result.random.pooled.accuracy, all = rows.map(r => r.accuracy).concat([base]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...all) + 0.01) * 20) / 20);
  const Y = axes(ctx, W, H, pad, lo, hi, 'block size (km, log scale)');
  const xs = S.sweep.rows.map(r => r.block_km), lx = Math.log(Math.min(...xs)), hx = Math.log(Math.max(...xs));
  const X = v => pad.l + (Math.log(v) - lx) / Math.max(1e-9, hx - lx) * (W - pad.l - pad.r - 20) + 10;
  ctx.setLineDash([5, 4]); ctx.strokeStyle = '#7b8190'; ctx.beginPath(); ctx.moveTo(pad.l, Y(base)); ctx.lineTo(W - pad.r, Y(base)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#5f6675'; ctx.textAlign = 'left'; ctx.fillText(`random ${pct(base)}`, pad.l + 4, Y(base) - 6);
  ctx.strokeStyle = '#2b55c7'; ctx.lineWidth = 2; ctx.beginPath(); rows.forEach((r, i) => i ? ctx.lineTo(X(r.block_km), Y(r.accuracy)) : ctx.moveTo(X(r.block_km), Y(r.accuracy))); ctx.stroke();
  ctx.fillStyle = '#2b55c7'; rows.forEach(r => { ctx.beginPath(); ctx.arc(X(r.block_km), Y(r.accuracy), 4, 0, 7); ctx.fill(); });
  ctx.fillStyle = '#15171c'; ctx.textAlign = 'center'; S.sweep.rows.forEach(r => ctx.fillText(r.error ? `${r.block_km}*` : `${r.block_km}`, X(r.block_km), H - 20));
}
$('sweep').addEventListener('click', async () => {
  if (!S.result) return;
  const result = S.result, sizes = [1, 2, 5, 10, 20].filter(b => b !== result.config.block_km).concat([result.config.block_km]).sort((a, b) => a - b);
  $('sweep').disabled = true; $('sweep').textContent = 'Running the sweep…';
  try {
    const sw = await ask('sweep', { cfg: result.config, blocks: sizes }, m => { $('sweep').textContent = m; });
    if (S.result !== result) return;
    S.sweep = sw; $('c-sweep').hidden = false; drawSweep();
    const rows = sw.rows.filter(x => x.accuracy != null), bad = sw.rows.filter(r => r.error);
    if (rows.length) { const f = rows[0], l = rows[rows.length - 1];
      $('sweep-reading').innerHTML = `Spatial accuracy is <b>${pct(f.accuracy)}</b> with ${f.block_km} km blocks and <b>${pct(l.accuracy)}</b> with ${l.block_km} km blocks, against ${pct(result.random.pooled.accuracy)} for random folds. Larger blocks put test points further from training points; there is no single correct size.`
        + (bad.length ? ` <span class="warn">* ${bad.map(r => esc(r.error)).join('; ')}</span>` : ''); }
  } catch (e) { if (S.result === result) $('sweep-reading').textContent = e.message; }
  finally { if (S.result === result) { $('sweep').disabled = false; $('sweep').textContent = 'Run the sweep again'; } }
});
let rz = null;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.result) { drawFolds(S.result); drawSweep(); } }, 150); });

// ---------------------------------------------------------------- export
const LIMITS = ['Neither design estimates map accuracy; that needs a probability sample of reference data (Wadoux et al., 2021).',
  'Spatial blocks answer a different question from random folds; they are not automatically better.',
  'One seed; the designs also differ in class mix per fold, so the gap is an indication, not a precise estimate.',
  'Classification only, Random Forest only.'];
const round6 = v => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
// text that starts with = + - @ is prefixed with ' so spreadsheets do not run it as a formula
const csvCell = v => { let s = v == null ? '' : String(v); if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = rows => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
$('export-open').addEventListener('click', () => { $('x-note').textContent = ''; $('export').showModal(); });
document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', async () => {
  const r = S.result; if (!r) return;
  const k = b.dataset.export, stem = `geovalidate_${(S.name || 'data').replace(/\.[^.]+$/, '')}`, note = $('x-note');
  if (k === 'eval') {
    const rows = [['design', 'scope', 'fold', 'n_train', 'n_test', 'accuracy', 'kappa', 'macro_precision', 'macro_recall', 'macro_f1', 'weighted_f1', 'median_test_to_train_m']];
    for (const m of [r.random, r.spatial]) {
      rows.push([m.design, 'all folds', '', '', m.pooled.n, m.pooled.accuracy, m.pooled.kappa, m.pooled.macro.precision, m.pooled.macro.recall, m.pooled.macro.f1, m.pooled.weighted.f1, m.median_test_to_train_m].map(round6));
      for (const f of m.per_fold) rows.push([m.design, 'fold', f.fold + 1, f.n_train, f.n_test, f.accuracy, f.kappa, f.macro.precision, f.macro.recall, f.macro.f1, f.weighted.f1, f.median_test_to_train_m].map(round6));
    }
    rows.push([]); rows.push(['design', 'class', 'precision', 'recall', 'f1', 'support']);
    for (const m of [r.random, r.spatial]) for (const [c, v] of Object.entries(m.pooled.per_class)) rows.push([m.design, c, v.precision, v.recall, v.f1, v.support].map(round6));
    save(new Blob([csv(rows)], { type: 'text/csv' }), `${stem}_evaluation.csv`);
  } else if (k === 'folds') {
    const rows = [['source_row', 'lon', 'lat', 'target', 'random_fold', 'random_prediction', 'spatial_fold', 'spatial_block', 'spatial_prediction']];
    r.kept_index.forEach((src, i) => rows.push([src + 1, r.lonlat[i][0], r.lonlat[i][1], r.y[i], r.random.folds[i] < 0 ? 'train' : r.random.folds[i] + 1, r.random.predictions[i], r.spatial.folds[i] + 1, r.spatial.blocks[i], r.spatial.predictions[i]]));
    save(new Blob([csv(rows)], { type: 'text/csv' }), `${stem}_folds.csv`);
  } else if (k === 'geojson') {
    const fc = { type: 'FeatureCollection', name: 'GeoValidate folds', geovalidate: { app: 'GeoValidate', version: r.version, run_at: S.runAt, file: S.name, file_sha256: S.meta.sha256, config: r.config, accuracy: { random: r.random.pooled.accuracy, spatial: r.spatial.pooled.accuracy }, limits: LIMITS }, features: r.kept_index.map((src, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: r.lonlat[i] },
      properties: { source_row: src + 1, target: r.y[i], random_fold: r.random.folds[i] < 0 ? null : r.random.folds[i] + 1, random_prediction: r.random.predictions[i], spatial_fold: r.spatial.folds[i] + 1, spatial_block: r.spatial.blocks[i], spatial_prediction: r.spatial.predictions[i] } }))
      .concat(r.spatial.block_polygons.features.map(f => ({ ...f, properties: { block: f.properties.block, spatial_fold: f.properties.fold + 1 } }))) };
    save(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `${stem}_folds.geojson`);
  } else if (k === 'png') {
    const a = $('c-folds'), s = $('c-sweep'), both = !!S.sweep && !s.hidden, c = document.createElement('canvas'), dpr = window.devicePixelRatio || 1;
    c.width = a.width + (both ? s.width + 20 : 0); c.height = a.height + 30 * dpr + 30 * dpr;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(a, 0, 30 * dpr); if (both) ctx.drawImage(s, a.width + 20, 30 * dpr);
    ctx.fillStyle = '#15171c'; ctx.font = `${14 * dpr}px Satoshi, sans-serif`; ctx.fillText(both ? `GeoValidate · ${S.name} · accuracy per fold (left) and against block size (right)` : `GeoValidate · ${S.name} · accuracy per fold`, 6, 20 * dpr);
    let lx = 6; ctx.font = `${12 * dpr}px Satoshi, sans-serif`;
    r.spatial.per_fold.forEach(f => { ctx.fillStyle = FOLD_COLORS[f.fold % 10]; ctx.beginPath(); ctx.arc(lx + 5 * dpr, c.height - 12 * dpr, 4 * dpr, 0, 7); ctx.fill(); ctx.fillStyle = '#15171c'; ctx.fillText(`fold ${f.fold + 1}`, lx + 12 * dpr, c.height - 8 * dpr); lx += 62 * dpr; });
    c.toBlob(bl => save(bl, `${stem}_charts.png`), 'image/png');
  } else if (k === 'config') {
    save(new Blob([JSON.stringify({ app: 'GeoValidate', engine_version: r.version, scikit_learn: r.sklearn, numpy: r.numpy, pandas: r.pandas, pyodide: '0.26.4',
      run_at: S.runAt, file: S.name, file_sha256: S.meta.sha256, rows_used: r.rows_used, rows_total: r.rows_total, projection: r.projection,
      config: r.config, numeric_predictors: r.numeric, categorical_predictors: r.categorical, classes: r.classes,
      results: { random: { design: r.random.design, accuracy: r.random.pooled.accuracy, macro_f1: r.random.pooled.macro.f1, kappa: r.random.pooled.kappa },
                 spatial: { design: r.spatial.design, accuracy: r.spatial.pooled.accuracy, macro_f1: r.spatial.pooled.macro.f1, kappa: r.spatial.pooled.kappa, n_blocks: r.spatial.n_blocks } },
      sweep: S.sweep, limits: LIMITS }, null, 2)], { type: 'application/json' }), `${stem}_config.json`);
  } else if (k === 'pdf') {
    $('export').close();
    const img = map.getCanvas().toDataURL('image/png');
    $('report').innerHTML = `<h1>${esc($('r-verdict').textContent)}</h1><p>${esc(S.name)} · ${r.rows_used} rows · run ${esc(S.runAt)} · SHA-256 ${esc(S.meta.sha256)}</p>
      <p>${esc($('r-reading').textContent)}</p><p>${$('r-classes').innerHTML}</p><h2>Map: ${esc($('view').selectedOptions[0].textContent)}</h2><img src="${img}" alt="Map: ${esc($('view').selectedOptions[0].textContent)}"><p>${[...$('legend').querySelectorAll('.sw')].map(e => esc(e.textContent)).join(' · ')}</p><h2>Results</h2>${$('compare').innerHTML}
      <h2>Configuration</h2><p>${esc(JSON.stringify(r.config))}</p><p>scikit-learn ${esc(r.sklearn)} in Pyodide 0.26.4 · GeoValidate ${esc(r.version)}</p><p>Basemap © OpenStreetMap contributors, OpenFreeMap.</p>
      <p>${LIMITS.map(esc).join(' ')}</p>`;
    await new Promise(res => { const im = $('report').querySelector('img'); im.complete ? res() : (im.onload = res); });
    window.print(); return;
  }
  note.textContent = `${b.querySelector('b').textContent} saved.`;
}));

// ---------------------------------------------------------------- dialogs, landing preview, start
$('about-open').addEventListener('click', () => $('about').showModal());
document.querySelectorAll('dialog').forEach(d => {
  const x = d.querySelector('[data-close]'); if (x) x.addEventListener('click', () => d.close());
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
});
document.addEventListener('click', e => { const mm = document.querySelector('.menu'); if (mm.open && !mm.contains(e.target)) mm.open = false; });
// landing preview: figures from a real run (assets/preview.json, written by tools/make_preview.py)
fetch('assets/preview.json').then(r => r.json()).then(p => {
  const gap = (p.random - p.spatial) * 100;
  $('pv-place').textContent = p.label;
  $('pv-verdict').textContent = `Spatial blocks score ${gap.toFixed(1)} points lower`;
  $('pv-stats').innerHTML = `<div><b>${pct(p.random)}</b>random folds</div><div><b>${pct(p.spatial)}</b>spatial blocks</div><div><b>${p.block_km} km</b>blocks</div>`;
  $('pv-cap').textContent = `A real result: ${p.rows.toLocaleString('en-GB')} points, ${p.k} folds, seed ${p.seed}, GeoValidate ${p.version}. Map © OpenStreetMap contributors, OpenFreeMap.`;
}).catch(() => { document.querySelector('.preview').hidden = true; });
show('data');
$('w-drop').focus();
