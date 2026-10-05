/** @odoo-module **/
// @ts-check

/**
 * ODOOM — the spreadsheet formula.
 *
 * `=ODOOM(width, height, cell_px)` registers the block anchored at the formula's own cell in the
 * module-level `doomBlocks` registry and kicks the (page-singleton) DOOM engine. It has NO side
 * effects on the spreadsheet model: the feature plugin (odoom_plugin.js) polls `doomBlocks` from a
 * timer and does every dispatch (sheet growth, cell sizes, kill log, chart) from there, because a
 * formula's compute runs inside the evaluation plugin where dispatching is not allowed.
 *
 * The registry is shared with the plugin through a plain ES import, so both files must live in the
 * same asset bundle (spreadsheet.o_spreadsheet).
 */

import { _t } from "@web/core/l10n/translation";
import * as spreadsheet from "@odoo/o-spreadsheet";
import { doomEngine } from "@odoom/bundle/doom_engine";

const { arg, toNumber } = spreadsheet.helpers;
const { functionRegistry } = spreadsheet.registries;

/** Matches the raw content of an anchor cell that still holds the formula. */
export const ODOOM_FORMULA_RE = /^=\s*ODOOM\s*\(/i;

export const DEFAULT_WIDTH = 120;
export const DEFAULT_HEIGHT = 75;
export const DEFAULT_CELL_PX = 8;

export const LIMITS = Object.freeze({
    width: [16, 320],
    height: [10, 200],
    cellPx: [4, 24],
});

/**
 * @typedef {{ col: number, row: number, w: number, h: number, px: number, updatedAt: number }} DoomBlockDef
 */

/**
 * sheetId -> ("col,row" -> block definition). Module-level so the plugin can read it.
 * @type {Map<string, Map<string, DoomBlockDef>>}
 */
export const doomBlocks = new Map();

/**
 * @param {number} value
 * @param {[number, number]} range
 */
function clampInt(value, range) {
    const [lo, hi] = range;
    if (!Number.isFinite(value)) {
        return lo;
    }
    return Math.min(hi, Math.max(lo, Math.round(value)));
}

/**
 * Formula arguments arrive as FPayload objects `{ value, format }` (or `undefined` when omitted).
 * An omitted or blank argument falls back to the default; anything else is coerced with toNumber
 * and clamped.
 *
 * @param {any} payload
 * @param {number} fallback
 * @param {[number, number]} range
 * @param {any} locale
 */
function readArg(payload, fallback, range, locale) {
    if (payload === undefined || payload === null) {
        return fallback;
    }
    const raw = typeof payload === "object" && "value" in payload ? payload.value : payload;
    if (raw === undefined || raw === null || raw === "") {
        return fallback;
    }
    let n;
    try {
        n = toNumber(payload, locale);
    } catch {
        return fallback;
    }
    return clampInt(n, range);
}

/**
 * Upsert a block into the registry. Returns true when the definition changed.
 * @param {string} sheetId
 * @param {DoomBlockDef} def
 */
export function registerDoomBlock(sheetId, def) {
    let sheetBlocks = doomBlocks.get(sheetId);
    if (!sheetBlocks) {
        sheetBlocks = new Map();
        doomBlocks.set(sheetId, sheetBlocks);
    }
    const key = `${def.col},${def.row}`;
    const prev = sheetBlocks.get(key);
    if (prev && prev.w === def.w && prev.h === def.h && prev.px === def.px) {
        return false;
    }
    sheetBlocks.set(key, def);
    return true;
}

let startErrorLogged = false;

/** Fire-and-forget engine start; the formula must never throw because of the engine. */
function kickEngine() {
    try {
        const p = doomEngine.start();
        if (p && typeof p.catch === "function") {
            p.catch((err) => {
                if (!startErrorLogged) {
                    startErrorLogged = true;
                    console.debug("[ODOOM] engine start failed:", err);
                }
            });
        }
    } catch (err) {
        if (!startErrorLogged) {
            startErrorLogged = true;
            console.debug("[ODOOM] engine start threw:", err);
        }
    }
}

const ODOOM = {
    description: _t(
        "Turn the block of cells anchored at this cell into a live, playable DOOM screen (one cell per pixel)."
    ),
    args: [
        arg(
            `width (number, default=${DEFAULT_WIDTH})`,
            _t("Screen width in cells (16-320).")
        ),
        arg(
            `height (number, default=${DEFAULT_HEIGHT})`,
            _t("Screen height in cells (10-200).")
        ),
        arg(
            `cell_px (number, default=${DEFAULT_CELL_PX})`,
            _t("Size of every screen cell in pixels (4-24).")
        ),
    ],
    category: "Odoo",
    /**
     * @param {any} width
     * @param {any} height
     * @param {any} cellPx
     */
    compute: function (width, height, cellPx) {
        const w = readArg(width, DEFAULT_WIDTH, LIMITS.width, this.locale);
        const h = readArg(height, DEFAULT_HEIGHT, LIMITS.height, this.locale);
        const px = readArg(cellPx, DEFAULT_CELL_PX, LIMITS.cellPx, this.locale);

        const origin = this.__originCellPosition;
        const sheetId = (origin && origin.sheetId) || this.__originSheetId;
        if (sheetId && origin && Number.isInteger(origin.col) && Number.isInteger(origin.row)) {
            registerDoomBlock(sheetId, {
                col: origin.col,
                row: origin.row,
                w,
                h,
                px,
                updatedAt: Date.now(),
            });
        }
        kickEngine();
        return `ODOOM ${w}×${h} · click the screen to play`;
    },
};

functionRegistry.add("ODOOM", ODOOM);
