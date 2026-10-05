{
    "name": "ODOOM — DOOM in Spreadsheets",
    "version": "19.0.1.0.0",
    "summary": "Type =ODOOM(120,75) in a spreadsheet cell to run DOOM on the grid with a live kill chart.",
    "description": """
ODOOM — DOOM inside Odoo 19 spreadsheets
=========================================

Type ``=ODOOM(120,75)`` in any Odoo spreadsheet cell and the 120x75 block of cells anchored at that
cell becomes a live, playable DOOM screen: one cell per pixel, about 20 redraws per second. Every
kill appends a row to a kill log next to the screen and grows a real o-spreadsheet bar chart (plus
a scorecard with the running total).

Design
------
* ``ODOOM`` is a regular spreadsheet function (functionRegistry). Its compute has no side effects on
  the model: it only parses/clamps its arguments, registers the block (sheet, anchor, size) in a
  module-level registry and starts the page-singleton wasm engine. It returns a short label.
* A feature UI plugin (featurePluginRegistry) polls that registry on a 50 ms timer. For each new
  block it grows the sheet, resizes the screen columns/rows to ``cell_px`` pixels, writes the
  kill-log header and finds-or-creates the charts (by a title marker, so reloads never duplicate
  them). Whenever the engine has a new frame it dispatches a local ``ODOOM_TICK`` command, which
  makes o-spreadsheet redraw the grid; the plugin's ``drawLayer("Chart")`` then paints the latest
  640x400 frame onto the grid canvas, one source pixel per cell, with cell grid lines on top.
* Kills are ordinary ``UPDATE_CELL`` writes plus an ``UPDATE_CHART`` that extends the chart ranges,
  so the chart is a genuine, saved, collaborative o-spreadsheet chart.
* Keyboard: while the active cell is inside a screen (and the composer is closed) window-level
  capture listeners forward keys to DOOM and stop the grid/hotkeys from seeing them. Click any cell
  outside the screen to get the keyboard back. F5 and F12 always reach the browser.

Provenance
----------
``static/lib/doom/doom.wasm`` is linuxdoom-1.10 (id Software, GPL-2 sources) built to WebAssembly
by the wasm-fizzbuzz project, with the shareware ``doom1.wad`` embedded. See
``static/lib/doom/NOTICE.md``. Local demo only: no sound, one game per browser tab; the kill log
and chart writes happen only in edit mode (the screen repaints in both modes).
""",
    "author": "Natura",
    "category": "Productivity/Documents",
    "license": "LGPL-3",
    "depends": ["spreadsheet_edition"],
    "assets": {
        "spreadsheet.o_spreadsheet": [
            "odoom/static/src/bundle/**/*.js",
        ],
    },
    "installable": True,
    "application": False,
}
