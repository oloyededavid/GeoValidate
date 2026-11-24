// The page version lives in js/version.js; the Python engine (py/geovalidate.py) must carry the same number.
import { readFileSync } from 'node:fs';
import { VERSION } from '../js/version.js';
const py = readFileSync(new URL('../py/geovalidate.py', import.meta.url), 'utf8');
const m = /^VERSION = "([^"]+)"/m.exec(py);
if (!m || m[1] !== VERSION) { console.error(`py/geovalidate.py ${m ? m[1] : 'no VERSION'} differs from js/version.js ${VERSION}`); process.exit(1); }
console.log(`version ${VERSION}: js/version.js and py/geovalidate.py agree`);
