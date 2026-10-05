# ODOOM — DOOM in Odoo 19 spreadsheets

Type `=ODOOM(120,75)` in any Odoo spreadsheet cell. The 120×75 block of cells anchored at that cell
becomes a live, playable DOOM screen (one cell = one pixel, ~20 redraws/s). Every kill appends a row
to a kill log beside the screen and grows a real o-spreadsheet bar chart; a scorecard shows the
running total.

Local demo only. No git operations are part of this module's workflow; the owner handles git.

## Install

1. Make sure `odoom/static/lib/doom/doom.wasm` is present (about 6.8 MB).
2. Add the module to your addons path and install **ODOOM — DOOM in Spreadsheets**
   (it depends on `spreadsheet_edition`).
3. Open or create a spreadsheet (Documents → Spreadsheet, or any dashboard in edit mode).

## Usage

```
=ODOOM()              → 120×75 screen, 8 px cells
=ODOOM(160, 100)      → 160×100 screen, 8 px cells
=ODOOM(120, 75, 6)    → 120×75 screen, 6 px cells
```

| Argument  | Default | Range   | Meaning                          |
|-----------|---------|---------|----------------------------------|
| `width`   | 120     | 16–320  | screen width in cells            |
| `height`  | 75      | 10–200  | screen height in cells           |
| `cell_px` | 8       | 4–24    | size of each screen cell (pixels) |

Within a second the plugin:

- grows the sheet so the screen, the kill log and 300 log rows fit,
- resizes the screen columns and rows to `cell_px` pixels,
- writes the kill-log header (`Kill #`, `Time (s)`, `Health`, `Bullets`, `Total kills`) at
  `(col + width + 1, row + height + 1)`,
- creates a scorecard titled `ODOOM <anchor> kills` and a bar chart titled `ODOOM <anchor>` (e.g. `ODOOM A1`) to the right of the
  screen. Both are found again by that marker on reload, so nothing is ever duplicated.

The screen shows `LOADING DOOM…` until the wasm has loaded its first frame (a few seconds on the
first load).

## Controls

Click any cell inside the screen to grab the keyboard (the idle grid keeps its focus on the
formula composer, which is fine; only an open composer or another text field keeps the keys). The
caption under the screen switches to `● PLAYING`. Click any cell outside the screen to hand the
keyboard back to the grid.

| Key            | Action                          |
|----------------|---------------------------------|
| Enter          | menu / New Game / confirm        |
| ↑ ↓ ← →        | move / turn                      |
| Ctrl           | fire                             |
| Space          | open doors / use                 |
| Alt + ← →      | strafe                           |
| Shift          | run                              |
| 1–7            | weapons                          |
| Tab            | automap                          |
| Escape         | menu                             |
| y / n          | answer menu prompts              |
| F5 / F12       | always left to the browser       |

To start a game from the title screen: **Enter → Enter (New Game) → Enter (Episode 1) → Enter
(skill)** and you are in E1M1.

## What is written to the sheet

Every kill adds one row under the header: cumulative kill number, seconds since the first frame,
health and bullets at that moment, and updates the `Total kills` cell. The bar chart plots the
`Kill #` column against the `Time (s)` column, so it forms a staircase that fills out as you play.
These are ordinary cells and an ordinary chart: they are saved with the spreadsheet, undoable, and
sent to collaborators like any other edit.

## Limitations

- **Kill log and chart writes only in edit mode; the screen repaints in both modes.** In
  read-only / dashboard mode the plugin cannot dispatch its redraw command and falls back to a
  harmless viewport command, which repaints but writes nothing (no resizing, no kill log, no
  chart), so a screen laid out in edit mode plays there too.
- **One game per browser tab.** The wasm engine is a page singleton; several `=ODOOM()` cells (even
  in several spreadsheets) all show the same game and all log the same kills.
- **No sound.**
- The frame is downsampled from 640×400 to the block size; small blocks are blurry by nature.
- The kill counter is read from the player struct in wasm memory; a level change resets it (the
  engine re-baselines, no bogus rows are written).
- The formula's value is a plain label; it never changes, so it does not trigger recalculations.
- Keyboard grabbing relies on window-level capture listeners; while playing, spreadsheet shortcuts
  are unavailable until you click outside the screen.

## Files

```
odoom/
├── __init__.py, __manifest__.py, README.md
└── static/
    ├── lib/doom/doom.wasm          linuxdoom-1.10 + shareware doom1.wad (see NOTICE.md)
    ├── lib/doom/NOTICE.md          provenance and licences
    ├── src/bundle/doom_engine.js   page-singleton wasm engine (no Odoo imports, Node-testable)
    ├── src/bundle/odoom_function.js the ODOOM formula + shared block registry
    ├── src/bundle/odoom_plugin.js  the UI plugin: layout, redraw, drawLayer, kill log, keyboard
    └── tests/node/engine_probe.mjs headless Node probe for the engine
```

## Licence notes

The module code is LGPL-3. `doom.wasm` is built from id Software's GPL-2 DOOM sources
(linuxdoom-1.10) by the wasm-fizzbuzz project and embeds the shareware `doom1.wad`; see
`static/lib/doom/NOTICE.md`.
