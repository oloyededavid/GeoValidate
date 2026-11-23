// End-to-end check in headless Chromium: sample example, results, block-size preview, sweep, exports, upload validation, phone width.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const out = process.argv[2] || '.';
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const errors = [], bytes = { n: 0 };
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('response', async r => { try { if (r.url().includes('pyodide')) { const b = await r.body(); bytes.n += b.length; } } catch {} });
  await page.goto('http://127.0.0.1:8766/index.html', { waitUntil: 'load' });
  await page.screenshot({ path: `${out}/gv_landing.png` });
  const t0 = Date.now();
  await page.click('#demo');
  await page.waitForSelector('#results:not([hidden])', { timeout: 300000 });
  await page.waitForTimeout(1500);
  console.log('example seconds (engine start + run)', (Date.now() - t0) / 1000, '| pyodide MB downloaded', (bytes.n / 1e6).toFixed(1));
  console.log('log:', await page.$$eval('#log li', ls => ls.map(l => l.textContent).join(' | ')));
  console.log('gap:', await page.textContent('#gap'));
  console.log('kpis:', await page.$$eval('.method', ms => ms.map(m => [...m.querySelectorAll('.kpi')].map(k => k.textContent.replace(/\s+/g, ' ').trim()).join(' / ')).join(' || ')));
  await page.evaluate(() => document.getElementById('tool').scrollIntoView()); await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/gv_tool.png` });
  await page.evaluate(() => document.getElementById('results').scrollIntoView()); await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/gv_results.png` });
  // live block-size preview: 2 km blocks
  await page.evaluate(() => { const s = document.getElementById('block'); s.value = 2; s.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(4000);
  console.log('preview at', await page.textContent('#o-block'), ':', await page.textContent('#fold-info'));
  // sweep
  await page.click('#sweep');
  await page.waitForFunction(() => document.getElementById('sweep').textContent.includes('again'), null, { timeout: 400000 });
  await page.evaluate(() => document.getElementById('c-sweep').scrollIntoView()); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/gv_sweep.png` });
  for (const k of ['eval', 'folds', 'geojson', 'png', 'config']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(`[data-export="${k}"]`)]);
    const p = `${out}/${dl.suggestedFilename()}`; await dl.saveAs(p); console.log('export', k, fs.statSync(p).size, 'bytes', p);
  }
  // invalid upload is rejected
  const bad = `${out}/not-data.txt`; fs.writeFileSync(bad, 'hello');
  await page.setInputFiles('#file', bad); await page.waitForTimeout(800);
  console.log('invalid file message:', await page.textContent('#data-info'));
  const empty = `${out}/empty.csv`; fs.writeFileSync(empty, 'a,b\n');
  await page.setInputFiles('#file', empty); await page.waitForTimeout(3000);
  console.log('empty CSV message:', await page.textContent('#data-info'));
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(600);
  console.log('horizontal overflow at 390 px:', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${out}/gv_phone.png` });
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
