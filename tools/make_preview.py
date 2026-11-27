"""Build the landing-page preview card from a real run's exports.

Usage: python3 tools/make_preview.py CONFIG.json MAP.png
CONFIG.json is the Configuration export of one run (the Mau Forest example); MAP.png is a screenshot of the page's map
after that run (tests/browser_e2e.cjs saves one as map.png).
Writes assets/preview.json (figures shown on the card) and assets/preview-map.webp.
"""
import json, sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
c = json.loads(Path(sys.argv[1]).read_text())
out = {"label": "Mau Forest, Kenya (" + c["file"] + ")", "version": c["engine_version"], "rows": c["rows_used"],
       "random": round(c["results"]["random"]["accuracy"], 4), "spatial": round(c["results"]["spatial"]["accuracy"], 4),
       "block_km": c["config"]["block_km"], "k": c["config"]["k"], "seed": c["config"]["seed"]}
(root / "assets/preview.json").write_text(json.dumps(out, indent=1) + "\n")
im = Image.open(sys.argv[2]).convert("RGB")
w, h = im.size
crop = im.crop((int(w * 0.08), int(h * 0.12), int(w * 0.72), int(h * 0.86)))
crop.resize((600, round(600 * crop.height / crop.width)), Image.LANCZOS).save(root / "assets/preview-map.webp", quality=82)
print(json.dumps(out))
