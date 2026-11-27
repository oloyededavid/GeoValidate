# GeoValidate: interface notes

## Version 1.2.0: interface rebuilt as a guided product (27 November 2026)

Rebuilt to the same pattern as AgroSignal and FloodScope 1.2.0. The Python engine (`py/geovalidate.py`) is unchanged apart from its version number.

| Before | Now |
|---|---|
| Accordion steps, an intro block, four figure boxes, a Reading section and three tabs | An opening screen (headline, a file drop zone, the Mau Forest example, a card showing a real result), a three-screen tour on first use, and a stepper: Data, Setup, Result |
| Columns, block size and model settings across two steps | One Setup step: class and coordinate columns, the predictor list folded with a count, the data check, and the block size with one line on how to choose it; folds, buffer, trees, seed and class weights under Advanced settings |
| A progress log | Stages and a bar while comparing; the engine's download progress shows under the drop zone |
| Result spread over figures, Reading and tabs | The gap as the headline, one sentence, three figures, the small-sample or fold-spread caution when it applies, the fold chart, the block-size sweep on demand, the classes most affected, then all metrics, limits and run details folded away |
| Map view radio chips | One "Map shows" select with the legend in a map card |
| A result kept but marked out of date when settings changed | The result is cleared when the settings change, so a shown result always matches the settings |

The landing card is built from a real run's Configuration export and a screenshot of the page's map after that run (`tools/make_preview.py`), so no figure on it is typed by hand.

## Version 1.1.0

Version 1.1.0, November 2026. What changed in the interface, why, and what is still open. The analysis engine (`py/geovalidate.py`) is unchanged apart from its version number; the sample still gives random 0.9324 and spatial 0.8884 (`tests/check_expected.py`).

| Change | Why (audit finding) |
|---|---|
| Opening screen: what the tool answers, what it returns, "Run the Mau Forest example" and "Use my own file", and the 36 MB first-run download stated before it starts | The first view was four empty figure boxes (GV-1) |
| On phones the title and purpose come before the steps | The form came first (GV-2) |
| A Reading under the figures: the gap with its distances, the classes whose recall and precision fall most under spatial blocks, and what the comparison does not show | Results were labelled but not read; per-class losses were left to the reader (GV-3) |
| Sweep: a computed sentence, a values table, and progress in the same status line as the comparison | The sweep had no reading and reported progress elsewhere (GV-4, GV-5) |
| Fold and class colours replaced by an order that stays apart for protan, deutan and tritan vision | Folds 3 and 5 were identical for deuteranopes; two class colours collided for everyone (VZ-2, VZ-3) |
| Values tables behind both charts | Chart values were not reachable without sight (GV-6) |
| Empty files and header-only CSVs are reported at once, before the engine downloads | Trivial errors waited about 10 s (GV-8) |
| A hint under each disabled button says what is missing | Disabled buttons gave no reason (GV-10) |
| Exports: limits in the configuration JSON and the GeoJSON; run metadata in the GeoJSON; rounded CSV values; fold key on the chart image | Files lost their context once separated (EX-3, EX-4, EX-6) |
| Tools menu linking the four tools; "Back to portfolio" opens the tools | No movement between tools (PI-1, PI-2) |

Still open: shareable links are not offered because the data never leave the browser and a link without the data would not reproduce the run; confusion-matrix labels are still shortened on screen (full names are in the per-class table and in tooltips).
