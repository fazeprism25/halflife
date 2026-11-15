# Presentation assets

Supporting files for `HALFLIFE_Project_Presentation.pptx` (repository root).

| Path | Contents |
|---|---|
| `screenshots/` | Unchanged copies of the product screenshots the deck uses, from `docs/assets/screenshots/` (provenance in that folder's README). The uncropped real chatgpt.com screenshots (`real-chatgpt-*.png`, supplied by the maintainer 2026-11-15) are kept local only (gitignored: they show the account avatar and time zone); their crops are committed. |
| `crops/` | Crops of those screenshots. Cropping only removes area; nothing inside a crop is altered. The `real-*` crops leave out the account avatar and the report timestamp. |
| `brand/halflife-mark-dark.png` | The console's half-filled-circle mark (`engine/console/favicon.svg`), drawn for a dark background. |
| `previews/` | PNG renders of every slide (1920 x 1080), exported by PowerPoint, used for visual QA. |
| `build/prepare_assets.js` | Copies the screenshots, writes the crops and the mark (needs `sharp`). |
| `build/build_deck.js` | Generates the deck with `pptxgenjs`. All diagrams, charts, tables and labels are native, editable shapes. |
| `build/render_slides.ps1` | Exports slides to PNG through PowerPoint (Windows, PowerPoint installed). |

## Rebuilding

```powershell
# in a folder of your choice
npm install pptxgenjs@3.12.0 sharp@0.33.5
$env:NODE_PATH = "<that folder>\node_modules"
node presentation_assets\build\prepare_assets.js
node presentation_assets\build\build_deck.js
powershell -File presentation_assets\build\render_slides.ps1 -Deck "$PWD\HALFLIFE_Project_Presentation.pptx" -OutDir "$PWD\presentation_assets\previews"
```

The decay curves (slides 1 and 18) and the class-lifetime chart (slide 5) are computed from the class priors copied from `engine/src/classes.ts` into `build_deck.js`. If the priors change, update the `CLASSES` table there.

## Fonts

Segoe UI and Segoe UI Semibold (text), Consolas (code and labels), Cambria (quoted answers). They ship with Windows and Microsoft Office. On a machine without Segoe UI, PowerPoint substitutes a similar sans-serif and line breaks may shift slightly.
