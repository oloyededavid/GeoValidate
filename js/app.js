/* GeoValidate page. All numbers come from the worker (py/geovalidate.py in Pyodide). */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v, d = 1) => v == null || !(v === v) ? '—' : `${(v * 100).toFixed(d)}%`;
const num = (v, d = 3) => v == null || !(v === v) ? '—' : v.toFixed(d);
const km = m => m == null || !(m === m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
const BLOCKS = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100];
const FOLD_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const CLASS_COLORS = ['#1b7837', '#a6d96a', '#e6c84b', '#c0392b', '#2c7fb8', '#7b3294', '#e08214', '#878787', '#35978f', '#f781bf'];
const MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------- worker
const worker = new Worker(new URL('./worker.js', import.meta.url));
let seq = 0; const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id); if (!p) return;
  if (data.type === 'progress') { p.onProgress && p.onProgress(data.msg); return; }
  pending.delete(data.id); data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data.out);
};
const ask = (cmd, payload = {}, onProgress) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ cmd, id, ...payload }); });
const log = $('log');
const line = (msg, cls = '') => { log.querySelectorAll('li.now').forEach(l => l.classList.remove('now')); const li = document.createElement('li'); li.textContent = msg; if (cls) li.className = cls; log.append(li); };

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [0, 15], zoom: 1.3, attributionControl: { compact: true }, preserveDrawingBuffer: true });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
const mapReady = new Promise(r => map.on('load', r));
mapReady.then(() => {
  map.addSource('blocks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('pts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'blocks-fill', type: 'fill', source: 'blocks', paint: { 'fill-color': ['to-color', ['get', 'color']], 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'blocks-line', type: 'line', source: 'blocks', paint: { 'line-color': ['to-color', ['get', 'color']], 'line-width': 0.8, 'line-opacity': 0.7 } });
  map.addLayer({ id: 'pts', type: 'circle', source: 'pts', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 3.5, 14, 6], 'circle-color': ['to-color', ['get', 'color']], 'circle-stroke-width': 0.4, 'circle-stroke-color': '#fff' } });
});

// ---------------------------------------------------------------- state
const S = { text: null, name: null, kind: null, meta: null, preview: null, result: null, view: 'folds', sweep: null };
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
$('drop').addEventListener('click', () => $('file').click());
$('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
$('file').addEventListener('change', () => $('file').files[0] && readFile($('file').files[0]));
$('sample').addEventListener('click', loadSample);

async function readFile(f) {
  const ext = f.name.toLowerCase().split('.').pop();
  const kind = ext === 'csv' ? 'csv' : ext === 'geojson' || ext === 'json' ? 'geojson' : null;
  if (!kind) return info(`“${f.name}” is not a CSV or GeoJSON file.`, true);
  if (f.size > MAX_BYTES) return info(`“${f.name}” is ${(f.size / 1048576).toFixed(1)} MB; the limit is 20 MB.`, true);
  await load(await f.text(), f.name, kind);
}
async function loadSample() {
  const r = await fetch(new URL('../data/sample_mau_forest.csv', import.meta.url));
  await load(await r.text(), 'sample_mau_forest.csv', 'csv');
}
function info(msg, bad) { $('data-info').innerHTML = bad ? `<span style="color:var(--bad)">${esc(msg)}</span>` : msg; }
async function load(text, name, kind) {
  info('Starting the Python engine…'); log.innerHTML = '';
  try {
    const meta = await ask('load', { text, kind }, m => { info(esc(m)); line(m, 'now'); });
    log.querySelectorAll('li.now').forEach(l => l.classList.remove('now'));
    Object.assign(S, { text, name, kind, meta, result: null, preview: null }); $('results').hidden = true;
    info(`<strong>${esc(name)}</strong> · ${meta.rows.toLocaleString('en-GB')} rows · ${meta.columns.length} columns · SHA-256 ${meta.sha256.slice(0, 12)}…`);
    await fillColumns(meta);
  } catch (e) { info(e.message, true); }
}
function fillColumns(meta) {
  const opts = (sel, pick) => { sel.innerHTML = meta.columns.map(c => `<option${c === pick ? ' selected' : ''}>${esc(c)}</option>`).join(''); };
  opts($('c-target'), meta.guess.target); opts($('c-x'), meta.guess.x); opts($('c-y'), meta.guess.y);
  renderFeats(); $('quality').innerHTML = '';
  return checkData();
}
function renderFeats(warnings = {}) {
  const used = new Set([$('c-target').value, $('c-x').value, $('c-y').value]);
  const prev = new Set([...document.querySelectorAll('#feats input')].filter(i => !i.checked).map(i => i.value));
  const skip = /^(id|fid|objectid|index|row|col|column|x|y|lon|lat|lng|longitude|latitude)$/i;
  $('feats').innerHTML = `<div class="meta" style="margin:.2rem 0">Predictors</div>` + S.meta.columns.filter(c => !used.has(c)).map(c =>
    `<label><input type="checkbox" value="${esc(c)}" ${prev.has(c) || skip.test(c) ? '' : 'checked'}> ${esc(c)} ${warnings[c] ? `<span class="w">${esc(warnings[c])}</span>` : ''}</label>`).join('');
}
['c-target', 'c-x', 'c-y'].forEach(id => $(id).addEventListener('change', () => { renderFeats(); checkData(); }));
$('c-crs').addEventListener('change', () => { $('epsg-box').hidden = $('c-crs').value === 'EPSG:4326'; checkData(); });
$('c-epsg').addEventListener('change', checkData);
$('feats').addEventListener('change', () => { $('run').disabled = true; checkData(); });
$('check').addEventListener('click', checkData);

async function checkData() {
  if (!S.meta) return;
  const c = cfg();
  if (c.crs === 'EPSG:' ) { $('quality').innerHTML = '<li>Enter the EPSG code of the projected coordinates.</li>'; return; }
  try {
    const q = await ask('inspect', { cfg: c });
    const w = {}; for (const f of q.features) if (f.warnings.length) w[f.name] = f.warnings[0];
    const checked = new Set(c.features); renderFeats(w);
    document.querySelectorAll('#feats input').forEach(i => { i.checked = checked.has(i.value); });
    const cls = Object.entries(q.classes).map(([k, v]) => `${esc(k)} ${v.toLocaleString('en-GB')}`).join(' · ');
    $('quality').innerHTML = `<li>${q.rows.toLocaleString('en-GB')} rows; classes: ${cls}</li>` +
      (q.problems.length ? q.problems.map(p => `<li class="warn">${esc(p)}</li>`).join('') : '<li class="ok">No problems found in rows, coordinates or target.</li>');
    await preview();
  } catch (e) { $('quality').innerHTML = `<li class="warn">${esc(e.message)}</li>`; $('run').disabled = true; }
}

// ---------------------------------------------------------------- design controls and live fold preview
const outs = () => {
  $('o-k').textContent = $('k').value; $('o-block').textContent = `${BLOCKS[+$('block').value]} km`;
  $('o-buffer').textContent = +$('buffer').value ? `${$('buffer').value} km` : 'none';
};
$('block').max = BLOCKS.length - 1; $('block').value = BLOCKS.indexOf(10); outs();
let pvTimer = null;
['k', 'block', 'buffer', 'seed'].forEach(id => $(id).addEventListener('input', () => { outs(); clearTimeout(pvTimer); pvTimer = setTimeout(preview, 150); }));
async function preview() {
  if (!S.meta) return;
  try {
    const p = await ask('preview', { cfg: cfg() });
    S.preview = p; $('run').disabled = false;
    const empty = p.fold_class_counts.map((c, f) => Object.entries(c).filter(([, n]) => n === 0).map(([k]) => k)).map((e, f) => e.length ? `fold ${f + 1} lacks ${e.join(', ')}` : '').filter(Boolean);
    $('fold-info').innerHTML = `${p.n_blocks} occupied blocks; fold sizes ${p.fold_sizes.join(', ')}.` + (empty.length ? ` <span class="warn">${esc(empty.join('; '))}.</span>` : '');
    drawMap(true);
  } catch (e) { $('fold-info').innerHTML = `<span class="warn">${esc(e.message)}</span>`; $('run').disabled = true; }
}

// ---------------------------------------------------------------- map drawing
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  S.view = b.dataset.view; document.querySelectorAll('[data-view]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); drawMap(false);
}));
let fitted = null;
async function drawMap(fit) {
  await mapReady;
  const P = S.result || S.preview; if (!P) return;
  const lonlat = P.lonlat, classes = (S.result ? S.result.classes : P.classes), y = P.y;
  const sp = S.result ? S.result.spatial : null, rnd = S.result ? S.result.random : null;
  const spFolds = sp ? sp.folds : P.folds, blocksFC = sp ? sp.block_polygons : P.blocks;
  const color = i => {
    if (S.view === 'folds') return FOLD_COLORS[spFolds[i] % 10];
    if (S.view === 'random') return rnd ? (rnd.folds[i] < 0 ? '#bdbdb8' : FOLD_COLORS[rnd.folds[i] % 10]) : '#bdbdb8';
    if (S.view === 'class') return CLASS_COLORS[classes.indexOf(y[i]) % 10];
    return sp.predictions[i] === y[i] ? '#c9c6bd' : '#b42318';
  };
  map.getSource('pts').setData({ type: 'FeatureCollection', features: lonlat.map((c, i) => ({ type: 'Feature', properties: { color: color(i) }, geometry: { type: 'Point', coordinates: c } })) });
  const showBlocks = S.view === 'folds' || S.view === 'errors';
  map.getSource('blocks').setData(showBlocks ? { ...blocksFC, features: blocksFC.features.map(f => ({ ...f, properties: { ...f.properties, color: S.view === 'folds' ? FOLD_COLORS[f.properties.fold % 10] : '#6a6963' } })) } : { type: 'FeatureCollection', features: [] });
  const key = S.name + lonlat.length;
  if (fit && fitted !== key) {
    const xs = lonlat.map(c => c[0]), ys = lonlat.map(c => c[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, duration: 700 }); fitted = key;
  }
  const L = $('legend'); L.hidden = false;
  const k = Math.max(...spFolds) + 1;
  L.innerHTML = S.view === 'class' ? classes.map((c, i) => `<div><i style="background:${CLASS_COLORS[i % 10]}"></i>${esc(c)}</div>`).join('')
    : S.view === 'errors' ? '<div><i style="background:#b42318"></i>wrong under spatial folds</div><div><i style="background:#c9c6bd"></i>right</div>'
    : S.view === 'random' && !rnd ? '<div>Run the comparison to see the random folds</div>'
    : Array.from({ length: S.view === 'random' && rnd.design.includes('hold-out') ? 1 : k }, (_, f) => `<div><i style="background:${FOLD_COLORS[f]}"></i>${S.view === 'random' && rnd.design.includes('hold-out') ? 'test (hold-out); grey: training' : `fold ${f + 1}`}</div>`).join('');
}

// ---------------------------------------------------------------- run
$('run').addEventListener('click', runNow);
async function runNow() {
  $('run').disabled = true; log.innerHTML = ''; line('Starting', 'now');
  const t0 = performance.now();
  try {
    const r = await ask('run', { cfg: cfg() }, m => line(m, 'now'));
    log.querySelectorAll('li.now').forEach(l => l.classList.remove('now'));
    line(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    S.result = r; S.sweep = null; S.runAt = new Date().toISOString();
    document.querySelector('[data-view="errors"]').disabled = false;
    render(r); drawMap(true);
    $('results').hidden = false; $('results').scrollIntoView({ behavior: 'smooth' });
  } catch (e) { line(e.message, 'err'); }
  finally { $('run').disabled = false; }
}

function render(r) {
  const a = r.random, b = r.spatial;
  $('r-sub').textContent = `${r.rows_used.toLocaleString('en-GB')} of ${r.rows_total.toLocaleString('en-GB')} rows · ${r.classes.length} classes · ${r.config.features.length} predictors · Random Forest, ${r.config.model.n_estimators} trees · seed ${r.config.seed} · scikit-learn ${r.sklearn}`;
  const drop = a.pooled.accuracy - b.pooled.accuracy;
  $('gap').innerHTML = `Accuracy is <strong>${pct(a.pooled.accuracy)}</strong> when test points are mixed in at random (median ${km(a.median_test_to_train_m)} from the nearest training point) and <strong>${pct(b.pooled.accuracy)}</strong> when whole ${r.config.block_km} km blocks are held out (median ${km(b.median_test_to_train_m)}): ${drop >= 0 ? `${(drop * 100).toFixed(1)} percentage points lower` : `${(-drop * 100).toFixed(1)} points higher`}.`;
  const card = (m, title, tag) => `<div class="method"><h3>${title} <span class="tag">${tag}</span></h3><p class="design">${esc(m.design)}</p>
    <div class="kpis">
      <div class="kpi"><span class="v">${pct(m.pooled.accuracy)}</span><span class="u">overall accuracy</span></div>
      <div class="kpi"><span class="v">${num(m.pooled.macro.f1, 3)}</span><span class="u">macro F1</span></div>
      <div class="kpi"><span class="v">${num(m.pooled.kappa, 3)}</span><span class="u">Cohen's kappa</span></div>
      <div class="kpi"><span class="v">${m.per_fold.length > 1 ? '±' + pct(m.fold_accuracy_sd) : '—'}</span><span class="u">fold spread (SD)</span></div>
      <div class="kpi"><span class="v">${km(m.median_test_to_train_m)}</span><span class="u">test to training (median)</span></div>
      <div class="kpi"><span class="v">${num(m.pooled.weighted.f1, 3)}</span><span class="u">weighted F1</span></div>
    </div>${cmTable(m.confusion_matrix, r.classes)}${perClass(m, r.classes)}
    ${m.warnings.length ? `<p class="warn">${m.warnings.map(esc).join('<br>')}</p>` : ''}</div>`;
  $('compare').innerHTML = card(a, 'Random', 'A') + card(b, 'Spatial blocks', 'B');
  drawFolds(r); drawSweep();
}
function cmTable(cm, labels) {
  const max = Math.max(...cm.flat(), 1), short = s => s.length > 14 ? s.slice(0, 13) + '…' : s;
  return `<table class="cm" aria-label="Confusion matrix, rows are the labels, columns the predictions"><tr><th></th><th colspan="${labels.length}" class="axis">predicted</th></tr>
    ${cm.map((row, i) => `<tr><th class="rowh" title="${esc(labels[i])}">${esc(short(labels[i]))}</th>${row.map((v, j) => {
      const t = v / max, bg = i === j ? `rgba(47,125,74,${0.12 + 0.75 * t})` : v ? `rgba(180,35,24,${0.1 + 0.7 * t})` : '#f4f4f2';
      return `<td style="background:${bg};color:${t > 0.55 ? '#fff' : '#141412'}" title="${esc(labels[i])} predicted as ${esc(labels[j])}: ${v}">${v}</td>`; }).join('')}</tr>`).join('')}
    <tr><th></th>${labels.map(l => `<th title="${esc(l)}">${esc(l.slice(0, 3))}</th>`).join('')}</tr></table>`;
}
function perClass(m, labels) {
  return `<table class="data-table" style="margin-top:.8rem;font-size:.8125rem"><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>n</th></tr></thead><tbody>${
    labels.filter(l => m.pooled.per_class[l]).map(l => { const c = m.pooled.per_class[l]; return `<tr><td>${esc(l)}</td><td>${num(c.precision)}</td><td>${num(c.recall)}</td><td>${num(c.f1)}</td><td>${c.support}</td></tr>`; }).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- charts
function axes(ctx, W, H, pad, lo, hi, xlabel) {
  ctx.clearRect(0, 0, W, H); ctx.font = '12px "Geist Mono", monospace'; ctx.fillStyle = '#6a6963'; ctx.strokeStyle = '#e4e4e0';
  const Y = v => H - pad.b - (v - lo) / (hi - lo) * (H - pad.t - pad.b);
  for (let v = Math.ceil(lo * 20) / 20; v <= hi + 1e-9; v += 0.05) { ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(`${Math.round(v * 100)}%`, pad.l - 6, Y(v) + 4); }
  ctx.textAlign = 'center'; ctx.fillText(xlabel, (W + pad.l) / 2, H - 6); return Y;
}
function drawFolds(r) {
  const c = $('c-folds'), ctx = c.getContext('2d'), W = c.width, H = c.height, pad = { l: 48, r: 16, t: 14, b: 40 };
  const all = [...r.random.per_fold, ...r.spatial.per_fold].map(f => f.accuracy).concat([r.random.pooled.accuracy, r.spatial.pooled.accuracy]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...all) + 0.01) * 20) / 20);
  const Y = axes(ctx, W, H, pad, lo, hi, '');
  [[r.random, 'Random', 0.3], [r.spatial, 'Spatial blocks', 0.7]].forEach(([m, name, fx]) => {
    const x = pad.l + fx * (W - pad.l - pad.r);
    ctx.strokeStyle = '#141412'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 50, Y(m.pooled.accuracy)); ctx.lineTo(x + 50, Y(m.pooled.accuracy)); ctx.stroke();
    m.per_fold.forEach((f, i) => { ctx.fillStyle = FOLD_COLORS[f.fold % 10]; ctx.beginPath(); ctx.arc(x - 30 + (i / Math.max(1, m.per_fold.length - 1)) * 60, Y(f.accuracy), 5, 0, 7); ctx.fill(); });
    ctx.fillStyle = '#141412'; ctx.font = '13px Satoshi, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(name, x, H - 18);
  });
}
function drawSweep() {
  const c = $('c-sweep'), ctx = c.getContext('2d'), W = c.width, H = c.height, pad = { l: 48, r: 16, t: 14, b: 40 };
  if (!S.sweep) { ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#6a6963'; ctx.font = '13px Satoshi, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Run the sweep to see how accuracy changes with block size', W / 2, H / 2); return; }
  const rows = S.sweep.rows.filter(r => r.accuracy != null), base = S.result.random.pooled.accuracy;
  const all = rows.map(r => r.accuracy).concat([base]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...all) + 0.01) * 20) / 20);
  const Y = axes(ctx, W, H, pad, lo, hi, 'block size (km, log scale)');
  const xs = S.sweep.rows.map(r => r.block_km), lx = Math.log(Math.min(...xs)), hx = Math.log(Math.max(...xs));
  const X = v => pad.l + (Math.log(v) - lx) / Math.max(1e-9, hx - lx) * (W - pad.l - pad.r - 20) + 10;
  ctx.setLineDash([5, 4]); ctx.strokeStyle = '#6a6963'; ctx.beginPath(); ctx.moveTo(pad.l, Y(base)); ctx.lineTo(W - pad.r, Y(base)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#6a6963'; ctx.textAlign = 'left'; ctx.fillText(`random ${pct(base)}`, pad.l + 4, Y(base) - 6);
  ctx.strokeStyle = '#b4530a'; ctx.lineWidth = 2; ctx.beginPath(); rows.forEach((r, i) => i ? ctx.lineTo(X(r.block_km), Y(r.accuracy)) : ctx.moveTo(X(r.block_km), Y(r.accuracy))); ctx.stroke();
  ctx.fillStyle = '#b4530a'; rows.forEach(r => { ctx.beginPath(); ctx.arc(X(r.block_km), Y(r.accuracy), 4, 0, 7); ctx.fill(); });
  ctx.fillStyle = '#141412'; ctx.textAlign = 'center'; S.sweep.rows.forEach(r => ctx.fillText(r.error ? `${r.block_km}*` : `${r.block_km}`, X(r.block_km), H - 24));
}
$('sweep').addEventListener('click', async () => {
  if (!S.result) return;
  const sizes = [1, 2, 5, 10, 20].filter(b => b !== S.result.config.block_km).concat([S.result.config.block_km]).sort((a, b) => a - b);
  $('sweep').disabled = true; $('sweep').textContent = 'Running…';
  try { S.sweep = await ask('sweep', { cfg: S.result.config, blocks: sizes }, m => { $('sweep').textContent = m; }); drawSweep();
    const bad = S.sweep.rows.filter(r => r.error); if (bad.length) $('sweep').insertAdjacentHTML('afterend', `<p class="warn">* ${bad.map(r => esc(r.error)).join('; ')}</p>`); }
  catch (e) { alert(e.message); }
  finally { $('sweep').disabled = false; $('sweep').textContent = 'Run the block-size sweep again'; }
});

// ---------------------------------------------------------------- exports
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = rows => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', async () => {
  const r = S.result; if (!r) return;
  const k = b.dataset.export, stem = `geovalidate_${(S.name || 'data').replace(/\.[^.]+$/, '')}`;
  if (k === 'eval') {
    const rows = [['design', 'scope', 'fold', 'n_train', 'n_test', 'accuracy', 'kappa', 'macro_precision', 'macro_recall', 'macro_f1', 'weighted_f1', 'median_test_to_train_m']];
    for (const [d, m] of [['random', r.random], ['spatial', r.spatial]]) {
      rows.push([m.design, 'all folds', '', '', m.pooled.n, m.pooled.accuracy, m.pooled.kappa, m.pooled.macro.precision, m.pooled.macro.recall, m.pooled.macro.f1, m.pooled.weighted.f1, m.median_test_to_train_m]);
      for (const f of m.per_fold) rows.push([m.design, 'fold', f.fold + 1, f.n_train, f.n_test, f.accuracy, f.kappa, f.macro.precision, f.macro.recall, f.macro.f1, f.weighted.f1, f.median_test_to_train_m]);
    }
    rows.push([]); rows.push(['design', 'class', 'precision', 'recall', 'f1', 'support']);
    for (const m of [r.random, r.spatial]) for (const [c, v] of Object.entries(m.pooled.per_class)) rows.push([m.design, c, v.precision, v.recall, v.f1, v.support]);
    save(new Blob([csv(rows)], { type: 'text/csv' }), `${stem}_evaluation.csv`);
  } else if (k === 'folds') {
    const rows = [['source_row', 'lon', 'lat', 'target', 'random_fold', 'random_prediction', 'spatial_fold', 'spatial_block', 'spatial_prediction']];
    r.kept_index.forEach((src, i) => rows.push([src + 1, r.lonlat[i][0], r.lonlat[i][1], r.y[i], r.random.folds[i] < 0 ? 'train' : r.random.folds[i] + 1, r.random.predictions[i], r.spatial.folds[i] + 1, r.spatial.blocks[i], r.spatial.predictions[i]]));
    save(new Blob([csv(rows)], { type: 'text/csv' }), `${stem}_folds.csv`);
  } else if (k === 'geojson') {
    const fc = { type: 'FeatureCollection', name: 'GeoValidate folds', features: r.kept_index.map((src, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: r.lonlat[i] },
      properties: { source_row: src + 1, target: r.y[i], random_fold: r.random.folds[i] < 0 ? null : r.random.folds[i] + 1, random_prediction: r.random.predictions[i], spatial_fold: r.spatial.folds[i] + 1, spatial_block: r.spatial.blocks[i], spatial_prediction: r.spatial.predictions[i] } }))
      .concat(r.spatial.block_polygons.features.map(f => ({ ...f, properties: { block: f.properties.block, spatial_fold: f.properties.fold + 1 } }))) };
    save(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `${stem}_folds.geojson`);
  } else if (k === 'png') {
    const a = $('c-folds'), s = $('c-sweep'), c = document.createElement('canvas'); c.width = a.width + s.width + 20; c.height = a.height + 40;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(a, 0, 30); ctx.drawImage(s, a.width + 20, 30);
    ctx.fillStyle = '#141412'; ctx.font = '14px Satoshi, sans-serif'; ctx.fillText(`GeoValidate · ${S.name} · accuracy per fold (left) and against block size (right)`, 6, 18);
    c.toBlob(bl => save(bl, `${stem}_charts.png`), 'image/png');
  } else if (k === 'config') {
    save(new Blob([JSON.stringify({ app: 'GeoValidate', engine_version: r.version, scikit_learn: r.sklearn, numpy: r.numpy, pandas: r.pandas, pyodide: '0.26.4',
      run_at: S.runAt, file: S.name, file_sha256: S.meta.sha256, rows_used: r.rows_used, rows_total: r.rows_total, projection: r.projection,
      config: r.config, numeric_predictors: r.numeric, categorical_predictors: r.categorical, classes: r.classes,
      results: { random: { design: r.random.design, accuracy: r.random.pooled.accuracy, macro_f1: r.random.pooled.macro.f1, kappa: r.random.pooled.kappa },
                 spatial: { design: r.spatial.design, accuracy: r.spatial.pooled.accuracy, macro_f1: r.spatial.pooled.macro.f1, kappa: r.spatial.pooled.kappa, n_blocks: r.spatial.n_blocks } },
      sweep: S.sweep }, null, 2)], { type: 'application/json' }), `${stem}_config.json`);
  } else if (k === 'pdf') {
    const img = map.getCanvas().toDataURL('image/png');
    $('report').innerHTML = `<h1>GeoValidate report</h1><p>${esc(S.name)} · ${r.rows_used} rows · run ${esc(S.runAt)} · SHA-256 ${esc(S.meta.sha256)}</p>
      <p>${$('gap').innerHTML}</p><img src="${img}" alt="Map of spatial folds"><h2>Results</h2>${$('compare').innerHTML}
      <h2>Configuration</h2><p class="src">${esc(JSON.stringify(r.config))}</p><p class="src">scikit-learn ${esc(r.sklearn)} in Pyodide 0.26.4 · GeoValidate ${esc(r.version)}</p>`;
    window.print();
  }
}));

// ---------------------------------------------------------------- example
$('demo').addEventListener('click', async () => {
  $('tool').scrollIntoView({ behavior: 'smooth' });
  await loadSample();
  if (S.meta && !$('run').disabled) runNow();
});
ask('init', {}, m => info(esc(m))).then(() => info('Python engine ready. Load the sample or a file.')).catch(e => info(`The Python engine could not start: ${e.message}`, true));
