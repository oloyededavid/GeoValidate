// End-to-end journey in headless Chromium: landing, Mau Forest example, map views, block-size sweep, every export, method,
// and the phone flow (file upload, tour, setup, run). Needs the page at 127.0.0.1:8767 (npx http-server . -p 8767).
// Usage: node tests/browser_e2e.cjs [screenshot folder]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const OUT = process.argv[2] || require('os').tmpdir() + '/geovalidate_e2e';
fs.mkdirSync(OUT, { recursive: true });
const URL0 = 'http://127.0.0.1:8767/';
const SAMPLE = path.join(__dirname, '..', 'data', 'sample_mau_forest.csv');
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const errors = [];
  const watch = p => { p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); p.on('pageerror', e => errors.push('pageerror ' + e.message)); };
  const overflow = p => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const endView = p => p.waitForSelector('[data-view="result"]:not([hidden]), [data-view="error"]:not([hidden])', { timeout: 900000 });
  const text = async (p, s) => (await p.textContent(s)).replace(/\s+/g, ' ').trim();

  // ---- desktop
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto(URL0); await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/d1_welcome.png` });
  const t0 = Date.now();
  await page.click('#w-example');
  await page.waitForSelector('[data-view="running"]:not([hidden])', { timeout: 600000 }); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/d2_running.png` });
  await endView(page);
  if (await page.isVisible('[data-view="error"]')) { log('ERROR VIEW:', await text(page, '#err-msg')); process.exit(1); }
  log('example (engine start and run) s', ((Date.now() - t0) / 1000).toFixed(0));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/d3_result.png` });
  await page.locator('#map').screenshot({ path: `${OUT}/map.png` });
  log('verdict:', await text(page, '#r-verdict'));
  log('where:', await text(page, '#r-where'));
  log('reading:', await text(page, '#r-reading'));
  log('stats:', await text(page, '#r-stats'));
  log('caution:', await page.isVisible('#r-caution') ? await text(page, '#r-caution') : '(none)');
  log('classes:', await text(page, '#r-classes'));
  for (const v of ['random', 'class', 'errors', 'folds']) { await page.selectOption('#view', v); await page.waitForTimeout(400); }
  log('legend (folds):', await text(page, '#legend'));
  await page.click('#sweep');
  await page.waitForSelector('#c-sweep:not([hidden])', { timeout: 600000 }); await page.waitForTimeout(500);
  log('sweep:', await text(page, '#sweep-reading'));
  await page.screenshot({ path: `${OUT}/d4_sweep.png` });
  await page.click('#export-open'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/d5_export.png` });
  for (const k of ['eval', 'folds', 'geojson', 'config', 'png']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(`[data-export="${k}"]`)]);
    const f = `${OUT}/${dl.suggestedFilename()}`; await dl.saveAs(f); log('download', k, dl.suggestedFilename(), fs.statSync(f).size, 'bytes');
  }
  await page.click('#export [data-close]');
  await page.click('#about-open'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/d6_method.png` });
  await page.click('#about [data-close]');
  await page.click('#stepper [data-s="setup"] button'); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/d7_setup.png` });
  // a setting change clears the result
  await page.fill('#block', '8'); await page.dispatchEvent('#block', 'input'); await page.waitForTimeout(2500);
  log('after block change: result step enabled', !(await page.isDisabled('#stepper [data-s="result"] button')), '| fold info', await text(page, '#fold-info'));
  await ctx.close();

  // ---- phone: upload the sample file, tour, setup, run
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pp = await ph.newPage(); watch(pp);
  await pp.goto(URL0); await pp.waitForTimeout(2500);
  log('phone welcome overflow', await overflow(pp));
  await pp.screenshot({ path: `${OUT}/p1_welcome.png`, fullPage: true });
  await pp.setInputFiles('#file', SAMPLE);
  await pp.waitForSelector('#tour[open]', { timeout: 10000 }); log('tour shown on first entry');
  await pp.screenshot({ path: `${OUT}/p2_tour.png` }); await pp.click('#tour-skip');
  await pp.waitForSelector('[data-view="setup"]:not([hidden])', { timeout: 600000 });
  await pp.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 120000 });
  log('phone setup:', await text(pp, '#quality'), '|', await text(pp, '#fold-info'), '| overflow', await overflow(pp));
  await pp.screenshot({ path: `${OUT}/p3_setup.png`, fullPage: true });
  await pp.click('#run'); await endView(pp); await pp.waitForTimeout(2000);
  log('phone result:', await pp.isVisible('[data-view="result"]') ? `${await text(pp, '#r-verdict')} | ${await text(pp, '#r-stats')}` : `error: ${await text(pp, '#err-msg')}`);
  log('phone result overflow', await overflow(pp));
  await pp.screenshot({ path: `${OUT}/p4_result.png` });
  await ph.close(); await browser.close();
  log('errors:', errors.length ? errors : 'none');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
