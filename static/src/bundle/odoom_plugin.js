/** @odoo-module **/
// @ts-check

/**
 * ODOOM — the o-spreadsheet feature (UI) plugin.
 *
 * One instance per spreadsheet model. It
 *   - polls the module-level `doomBlocks` registry (filled by the ODOOM formula) on a 50 ms timer,
 *   - lays every block out ONCE (sheet growth, px-sized columns/rows, kill-log header, one bar chart
 *     plus one scorecard found-or-created by marker so a reload never duplicates them),
 *   - forces a grid redraw with a local `ODOOM_TICK` command whenever the engine produced a new
 *     frame (readonly fallback: a no-op SET_VIEWPORT_OFFSET, whose rejection also triggers "update"),
 *   - paints the latest 640x400 frame onto the grid canvas in `drawLayer("Chart")` — one source
 *     pixel per cell — with cell grid lines over it,
 *   - appends a kill-log row + grows the chart ranges on every engine "kill" event,
 *   - grabs the keyboard (window capture listeners, page singleton) while the active cell is inside
 *     a screen and the composer is closed (the idle grid composer keeps focus; that is fine),
 *   - judges its own liveness from drawLayer alone: o-spreadsheet never tears a UI plugin down, so
 *     once the grid stops answering redraw requests the instance releases the keyboard, skips kill
 *     writes and finally stops ticking (see checkLiveness / isGridResponsive).
 *
 * All model writes happen from timer / engine callbacks (model idle), never from drawLayer.
 */

import * as spreadsheet from "@odoo/o-spreadsheet";
import { OdooUIPlugin } from "@spreadsheet/plugins";
import { doomEngine } from "@odoom/bundle/doom_engine";
import { doomBlocks, ODOOM_FORMULA_RE } from "@odoom/bundle/odoom_function";

const { toXC, isInside, UuidGenerator } = spreadsheet.helpers;
const { featurePluginRegistry } = spreadsheet.registries;

// ---- tunables -----------------------------------------------------------------------------------
const TICK_MS = 50;
const FPS_LOG_MS = 5000;
const NO_DOM_GRACE_MS = 5000;
/** A redraw request the grid did not answer within this long: the grid is probably not on screen. */
const NO_DRAW_SUSPEND_MS = 8000;
/** ... and after this long we give up: the model was discarded (o-spreadsheet never tears UI plugins down). */
const NO_DRAW_STOP_MS = 30000;
/** Unanswered for this long: stop grabbing the keyboard / logging kills (another grid owns the page). */
const KEY_RELEASE_MS = 1000;
/** Retry an unanswered redraw request (e.g. refused while an undo/redo ack is pending) after this long. */
const REDRAW_RETRY_MS = 250;
const SUSPENDED_RETRY_MS = 2000;
/** Back-off between attempts to lay out a block whose setup dispatches keep being refused. */
const SETUP_RETRY_MS = 500;
const MAX_CONSECUTIVE_ERRORS = 20;

const EXTRA_COLS = 8;
const EXTRA_ROWS = 300;
const ROWS_CHUNK = 100;

const CHART_WIDTH = 460;
const CHART_OFFSET_X = 8;
const CHART_MIN_HEIGHT = 220;
const CHART_BOTTOM_GAP = 8;
const SCORECARD_HEIGHT = 110;
const SCORECARD_GAP = 8;
const BAR_MIN_HEIGHT = 140;

const DEFAULT_COL_SIZE = 96;
const DEFAULT_ROW_SIZE = 23;

const KILL_COLOR = "#E53935";
const HEADER_STYLE = { bold: true, fillColor: "#B71C1C", textColor: "#FFFFFF" };
const LABEL_STYLE = { bold: true };
const HEADERS = ["Kill #", "Time (s)", "Health", "Bullets"];

const FRAME_W = 640;
const FRAME_H = 400;

const CAPTION_PLAYING =
    "● PLAYING — click a cell outside the screen to release the keyboard · kills: ";
const CAPTION_IDLE =
    "ODOOM · click the screen to grab the keyboard · Enter = menu/New Game · ↑↓←→ move · Ctrl fire · Space open · Alt+←→ strafe · Shift run";

/**
 * @typedef {{ left: number, right: number, top: number, bottom: number }} Zone
 * @typedef {{
 *   id: string, sheetId: string, col: number, row: number, w: number, h: number, px: number,
 *   zone: Zone, ready: boolean, nextSetupAt: number, setupFailureLogged: boolean, relayout: boolean,
 *   table: { col: number, row: number, nextRow: number, count: number } | null,
 *   chart: { figureId: string, chartId: string } | null,
 *   scorecard: { figureId: string, chartId: string } | null,
 * }} DoomBlock
 */

// ---- page-level singletons ----------------------------------------------------------------------

/** Every plugin instance whose tick is running; the key listeners ask each one `isPlaying()`. */
const livePlugins = new Set();
let keyListenersInstalled = false;
/** Keys we forwarded as "down" and have not seen released yet: code -> {key, code, keyCode}. */
const heldKeys = new Map();

/**
 * True when `el` (normally `document.activeElement`) is a text editor the user is typing into.
 *
 * o-spreadsheet's default focus target for an idle grid IS the grid composer's `.o-composer` div,
 * which carries `contenteditable="plaintext-only"` at all times in edit mode (only its `active`
 * class follows the edition mode), so `isContentEditable` alone would veto playing forever.
 * @param {Element | null} el
 */
function isEditingElement(el) {
    if (!el) {
        return false;
    }
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
    }
    if (el.classList && el.classList.contains("o-composer")) {
        // Grid / topbar composer: editing only while it is active (composer edition started).
        return el.classList.contains("active");
    }
    return !!(/** @type {HTMLElement} */ (el).isContentEditable);
}

function anyPluginPlaying() {
    for (const plugin of livePlugins) {
        if (plugin.isPlaying()) {
            return true;
        }
    }
    return false;
}

/**
 * @param {KeyboardEvent} ev
 * @param {boolean} isDown
 */
function forwardKey(ev, isDown) {
    try {
        return doomEngine.handleKeyboardEvent(ev, isDown);
    } catch (err) {
        console.debug("[ODOOM] key forward failed:", err);
        return false;
    }
}

/** Release every key DOOM still believes is held (focus loss, keyboard released mid-press). */
function releaseHeldKeys() {
    for (const held of heldKeys.values()) {
        try {
            const ev = new KeyboardEvent("keyup", {
                key: held.key,
                code: held.code,
                keyCode: held.keyCode,
                which: held.keyCode,
            });
            forwardKey(ev, false);
        } catch {
            // KeyboardEvent construction can fail in exotic environments; nothing to release then.
        }
    }
    heldKeys.clear();
}

function installKeyListeners() {
    if (keyListenersInstalled || typeof window === "undefined") {
        return;
    }
    keyListenersInstalled = true;

    /** @param {KeyboardEvent} ev */
    const onKeyDown = (ev) => {
        if (ev.key === "F5" || ev.key === "F12") {
            return;
        }
        if (!anyPluginPlaying()) {
            return;
        }
        if (forwardKey(ev, true)) {
            heldKeys.set(ev.code || ev.key, { key: ev.key, code: ev.code, keyCode: ev.keyCode });
            ev.preventDefault();
            ev.stopImmediatePropagation();
        }
    };

    /** @param {KeyboardEvent} ev */
    const onKeyUp = (ev) => {
        if (ev.key === "F5" || ev.key === "F12") {
            return;
        }
        const id = ev.code || ev.key;
        const wasHeld = heldKeys.has(id);
        const playing = anyPluginPlaying();
        if (!playing && !wasHeld) {
            return;
        }
        // Always release a key we pressed, even after the keyboard was handed back to the grid.
        const mapped = forwardKey(ev, false);
        heldKeys.delete(id);
        if (mapped && playing) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
        }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", releaseHeldKeys);
}

// ---- helpers ------------------------------------------------------------------------------------

/**
 * @param {string} text
 */
function normalizeXc(text) {
    return String(text || "")
        .replace(/^.*!/, "")
        .replace(/\$/g, "")
        .trim()
        .toUpperCase();
}

/**
 * @param {number} col
 * @param {number} row
 */
function cellZone(col, row) {
    return { left: col, right: col, top: row, bottom: row };
}

/**
 * @param {any} result
 */
function dispatchFailed(result) {
    return !!result && result.isSuccessful === false;
}

// ---- the plugin ---------------------------------------------------------------------------------

export class OdoomPlugin extends OdooUIPlugin {
    static layers = ["Chart"];
    static getters = /** @type {const} */ ([]);

    constructor(config) {
        super(config);
        /** @type {Map<string, DoomBlock>} */
        this.blocks = new Map();
        /** @type {Map<string, HTMLCanvasElement & { odoomFrame?: number }>} */
        this.smallCanvases = new Map();
        /** @type {ReturnType<typeof setInterval> | null} */
        this.intervalId = null;
        /** @type {(() => void) | null} */
        this.unsubscribeKill = null;
        this.uuid = new UuidGenerator();

        // -1 on purpose: the first tick with a block requests one redraw before any frame exists,
        // which paints the LOADING placeholder even when no setup dispatch re-renders the grid.
        this.lastFrameCount = -1;
        this.lastPaintedFrame = -1;
        this.paintedFrames = 0;
        this.lastFpsLog = 0;
        this.consecutiveErrors = 0;
        /** @type {number | null} */
        this.noDomSince = null;
        this.lastDrawAt = 0;
        this.lastRedrawRequestAt = 0;
        /**
         * When the oldest redraw request the grid has not answered yet was made (null: none
         * pending). drawLayer is the only liveness signal we have: o-spreadsheet never tears a UI
         * plugin down, so a discarded model's plugin keeps ticking with working getters.
         * @type {number | null}
         */
        this.unansweredSince = null;
        this.suspended = false;
        /** The grid canvas we last painted on; gone from the document once the spreadsheet closes. */
        /** @type {HTMLCanvasElement | null} */
        this.gridCanvas = null;
        /** @type {number | null} */
        this.canvasGoneSince = null;
    }

    // ---- command handling ----------------------------------------------------------------------

    handle(cmd) {
        switch (cmd.type) {
            case "START":
                this.startTicking();
                break;
            case "ODOOM_TICK":
                // Local, non-core command whose only purpose is the "update" event that follows it.
                break;
        }
    }

    // ---- lifecycle -----------------------------------------------------------------------------

    startTicking() {
        if (this.intervalId !== null || typeof setInterval !== "function") {
            return;
        }
        const now = Date.now();
        this.lastDrawAt = now;
        this.lastFpsLog = now;
        this.noDomSince = null;
        this.unansweredSince = null;
        this.suspended = false;
        this.canvasGoneSince = null;
        this.consecutiveErrors = 0;
        livePlugins.add(this);
        installKeyListeners();
        try {
            this.unsubscribeKill = doomEngine.on("kill", (payload) => this.onKill(payload));
        } catch (err) {
            console.debug("[ODOOM] could not subscribe to kills:", err);
            this.unsubscribeKill = null;
        }
        this.intervalId = setInterval(() => this.tick(), TICK_MS);
    }

    stopTicking(reason) {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        livePlugins.delete(this);
        if (this.unsubscribeKill) {
            try {
                this.unsubscribeKill();
            } catch {
                // ignore
            }
            this.unsubscribeKill = null;
        }
        if (livePlugins.size === 0) {
            releaseHeldKeys();
        }
        if (reason) {
            console.debug("[ODOOM] tick stopped:", reason);
        }
    }

    /** The getters throw once the model behind them is gone (defensive: a plain state read normally never does). */
    isModelUsable() {
        try {
            this.getters.getActiveSheetId();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * False while this model's grid is not answering our redraw requests: it is not the grid on
     * screen (the spreadsheet was left, or another model's grid replaced it). Gates the keyboard
     * grab and the kill-log writes so a stale instance never acts on behalf of the live one.
     */
    isGridResponsive() {
        if (this.suspended) {
            return false;
        }
        return this.unansweredSince === null || Date.now() - this.unansweredSince < KEY_RELEASE_MS;
    }

    /**
     * Liveness of this plugin's grid, judged from drawLayer only. Returns false once the tick was
     * stopped. Hidden tabs freeze requestAnimationFrame (and so the grid's rendering), which must
     * not count as "the grid never draws".
     * @param {number} now
     */
    checkLiveness(now) {
        if (typeof document === "undefined") {
            return true;
        }
        if (document.hidden) {
            this.unansweredSince = null;
            this.suspended = false;
            this.canvasGoneSince = null;
            this.noDomSince = null;
            return true;
        }
        if (!document.querySelector(".o-spreadsheet")) {
            if (this.noDomSince === null) {
                this.noDomSince = now;
            } else if (now - this.noDomSince > NO_DOM_GRACE_MS) {
                this.stopTicking("no .o-spreadsheet in the page");
                return false;
            }
        } else {
            this.noDomSince = null;
        }
        // The canvas we painted on left the document: our spreadsheet closed (another one may be
        // open, so the page-wide check above cannot see it). A remount repaints within a frame.
        if (this.gridCanvas && this.gridCanvas.isConnected === false) {
            if (this.canvasGoneSince === null) {
                this.canvasGoneSince = now;
            } else if (now - this.canvasGoneSince > NO_DOM_GRACE_MS) {
                this.stopTicking("grid canvas left the page");
                return false;
            }
        } else {
            this.canvasGoneSince = null;
        }
        if (this.unansweredSince !== null && now - this.unansweredSince > NO_DRAW_STOP_MS) {
            this.stopTicking("grid never draws");
            return false;
        }
        return true;
    }

    // ---- the 50 ms tick ------------------------------------------------------------------------

    tick() {
        if (!this.isModelUsable()) {
            this.stopTicking("model unusable");
            return;
        }
        const now = Date.now();
        if (!this.checkLiveness(now)) {
            return;
        }
        try {
            this.syncBlocks();
            if (this.blocks.size && !this.getters.isReadonly()) {
                for (const block of this.blocks.values()) {
                    if (!block.ready && now >= block.nextSetupAt) {
                        this.setupBlock(block, now);
                    }
                }
            }
            this.maybeRedraw();
            this.maybeLogFps();
            this.consecutiveErrors = 0;
        } catch (err) {
            this.consecutiveErrors++;
            console.debug("[ODOOM] tick error", this.consecutiveErrors, err);
            if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                this.stopTicking(`${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
            }
        }
    }

    /**
     * Mirror the module registry into this model's block map: adopt new blocks whose sheet exists
     * here, rebuild blocks whose dimensions changed, and drop blocks whose anchor cell no longer
     * holds the formula (or whose sheet was deleted).
     */
    syncBlocks() {
        for (const [sheetId, sheetBlocks] of doomBlocks) {
            if (!this.getters.tryGetSheet(sheetId)) {
                // Belongs to another model in this page (or a deleted sheet we never adopted): leave it.
                continue;
            }
            for (const [key, def] of sheetBlocks) {
                const id = `${sheetId}|${key}`;
                const existing = this.blocks.get(id);
                if (!existing) {
                    this.blocks.set(id, this.makeBlock(id, sheetId, def));
                } else if (
                    existing.w !== def.w ||
                    existing.h !== def.h ||
                    existing.px !== def.px
                ) {
                    // Resized: the table and the figures move with it (relayout).
                    this.blocks.set(id, this.makeBlock(id, sheetId, def, true));
                    this.smallCanvases.delete(id);
                }
            }
        }
        for (const [id, block] of this.blocks) {
            if (this.isBlockAlive(block)) {
                continue;
            }
            this.blocks.delete(id);
            this.smallCanvases.delete(id);
            const sheetBlocks = doomBlocks.get(block.sheetId);
            if (sheetBlocks) {
                sheetBlocks.delete(`${block.col},${block.row}`);
                if (sheetBlocks.size === 0) {
                    doomBlocks.delete(block.sheetId);
                }
            }
        }
    }

    /**
     * @param {string} id
     * @param {string} sheetId
     * @param {{ col: number, row: number, w: number, h: number, px: number }} def
     * @param {boolean} [relayout] re-anchor existing figures to the new layout (block resized)
     * @returns {DoomBlock}
     */
    makeBlock(id, sheetId, def, relayout = false) {
        const { col, row, w, h, px } = def;
        return {
            id,
            sheetId,
            col,
            row,
            w,
            h,
            px,
            zone: { left: col, right: col + w - 1, top: row, bottom: row + h - 1 },
            ready: false,
            nextSetupAt: 0,
            setupFailureLogged: false,
            relayout,
            table: null,
            chart: null,
            scorecard: null,
        };
    }

    /**
     * @param {DoomBlock} block
     */
    isBlockAlive(block) {
        if (!this.getters.tryGetSheet(block.sheetId)) {
            return false;
        }
        const cell = this.getters.getCell({ sheetId: block.sheetId, col: block.col, row: block.row });
        return !!cell && typeof cell.content === "string" && ODOOM_FORMULA_RE.test(cell.content);
    }

    // ---- one-time layout per block --------------------------------------------------------------

    /**
     * Idempotent: every step checks the sheet first and only dispatches what is missing.
     * @param {DoomBlock} block
     * @param {number} now
     */
    setupBlock(block, now) {
        const { sheetId, col, row, w, h, px } = block;
        let ok = true;

        // (1) Sheet growth — BEFORE resizing, so the appended headers copy a default-sized base.
        ok = this.ensureSheetSize(sheetId, col + w + EXTRA_COLS, row + h + EXTRA_ROWS, block) && ok;

        // (2) px-sized columns and rows for the screen.
        const cols = [];
        for (let c = col; c < col + w; c++) {
            if (this.getters.getColSize(sheetId, c) !== px) {
                cols.push(c);
            }
        }
        if (cols.length) {
            const r = this.dispatch("RESIZE_COLUMNS_ROWS", {
                sheetId,
                dimension: "COL",
                elements: cols,
                size: px,
            });
            ok = !dispatchFailed(r) && ok;
        }
        const rows = [];
        for (let r = row; r < row + h; r++) {
            if (this.getters.getRowSize(sheetId, r) !== px) {
                rows.push(r);
            }
        }
        if (rows.length) {
            const r = this.dispatch("RESIZE_COLUMNS_ROWS", {
                sheetId,
                dimension: "ROW",
                elements: rows,
                size: px,
            });
            ok = !dispatchFailed(r) && ok;
        }

        // (3) Kill-log header (only when the header cell is still empty).
        const tcol = col + w + 1;
        const trow = row + h + 1;
        const headerCell = this.getters.getCell({ sheetId, col: tcol, row: trow });
        if (!headerCell || !headerCell.content) {
            HEADERS.forEach((text, i) => {
                const r = this.dispatch("UPDATE_CELL", {
                    sheetId,
                    col: tcol + i,
                    row: trow,
                    content: text,
                    style: HEADER_STYLE,
                });
                ok = !dispatchFailed(r) && ok;
            });
            this.dispatch("UPDATE_CELL", {
                sheetId,
                col: tcol + 4,
                row: trow,
                content: "Total kills",
                style: LABEL_STYLE,
            });
            const totalCell = this.getters.getCell({ sheetId, col: tcol + 5, row: trow });
            if (!totalCell || !totalCell.content) {
                this.dispatch("UPDATE_CELL", {
                    sheetId,
                    col: tcol + 5,
                    row: trow,
                    content: "0",
                    style: LABEL_STYLE,
                });
            }
        }

        // (4) nextRow = first empty row of the Kill # column under the header; count = last Kill #.
        const numberRows = this.getters.getNumberRows(sheetId);
        let nextRow = trow + 1;
        let count = 0;
        while (nextRow < numberRows) {
            const cell = this.getters.getCell({ sheetId, col: tcol, row: nextRow });
            if (!cell || cell.content === undefined || cell.content === "") {
                break;
            }
            const n = Number(cell.content);
            if (Number.isFinite(n)) {
                count = n;
            }
            nextRow++;
        }
        block.table = { col: tcol, row: trow, nextRow, count };

        // (5) Charts: find by marker, else create.
        ok = this.ensureCharts(block) && ok;

        block.ready = ok;
        if (ok) {
            block.setupFailureLogged = false;
        } else {
            // Back off and log once per block: a refusal can repeat on every tick.
            block.nextSetupAt = now + SETUP_RETRY_MS;
            if (!block.setupFailureLogged) {
                block.setupFailureLogged = true;
                console.debug("[ODOOM] block setup incomplete, will retry", toXC(col, row));
            }
        }
    }

    /**
     * @param {string} sheetId
     * @param {number} needCols
     * @param {number} needRows
     * @param {DoomBlock} block
     */
    ensureSheetSize(sheetId, needCols, needRows, block) {
        let ok = true;
        const nCols = this.getters.getNumberCols(sheetId);
        if (nCols < needCols) {
            const base = nCols - 1;
            const baseIsScreenPx =
                isInside(base, block.row, block.zone) &&
                this.getters.getColSize(sheetId, base) === block.px;
            const r = this.dispatch("ADD_COLUMNS_ROWS", {
                sheetId,
                dimension: "COL",
                base,
                position: "after",
                quantity: needCols - nCols,
            });
            ok = !dispatchFailed(r) && ok;
            // Appended headers copy the base's size; if the base is an already px-sized screen
            // column (re-setup after a size change), give the new columns the default width back.
            if (!dispatchFailed(r) && baseIsScreenPx) {
                const added = [];
                for (let c = nCols; c < needCols; c++) {
                    added.push(c);
                }
                this.dispatch("RESIZE_COLUMNS_ROWS", {
                    sheetId,
                    dimension: "COL",
                    elements: added,
                    size: DEFAULT_COL_SIZE,
                });
            }
        }
        const nRows = this.getters.getNumberRows(sheetId);
        if (nRows < needRows) {
            const base = nRows - 1;
            const baseIsScreenPx =
                isInside(block.col, base, block.zone) &&
                this.getters.getRowSize(sheetId, base) === block.px;
            const r = this.dispatch("ADD_COLUMNS_ROWS", {
                sheetId,
                dimension: "ROW",
                base,
                position: "after",
                quantity: needRows - nRows,
            });
            ok = !dispatchFailed(r) && ok;
            if (!dispatchFailed(r) && baseIsScreenPx) {
                const added = [];
                for (let rr = nRows; rr < needRows; rr++) {
                    added.push(rr);
                }
                this.dispatch("RESIZE_COLUMNS_ROWS", {
                    sheetId,
                    dimension: "ROW",
                    elements: added,
                    size: DEFAULT_ROW_SIZE,
                });
            }
        }
        return ok;
    }

    /**
     * @param {string} sheetId
     * @param {Zone} zone
     */
    rangeString(sheetId, zone) {
        return this.getters.getRangeString(this.getters.getRangeFromZone(sheetId, zone), sheetId);
    }

    /**
     * @param {DoomBlock} block
     */
    chartMarker(block) {
        return `ODOOM ${toXC(block.col, block.row)}`;
    }

    /**
     * Data rows of the kill log: trow+1 .. max(trow+1, nextRow-1).
     * @param {DoomBlock} block
     */
    chartZones(block) {
        const t = /** @type {NonNullable<DoomBlock["table"]>} */ (block.table);
        const top = t.row + 1;
        const bottom = Math.max(top, t.nextRow - 1);
        return {
            data: { left: t.col, right: t.col, top, bottom },
            labels: { left: t.col + 1, right: t.col + 1, top, bottom },
        };
    }

    /**
     * @param {DoomBlock} block
     * @param {any} [base] existing definition to extend
     */
    barDefinition(block, base) {
        const { data, labels } = this.chartZones(block);
        const sheetId = block.sheetId;
        const dataSets = [
            {
                ...(base && base.dataSets && base.dataSets[0] ? base.dataSets[0] : {}),
                dataRange: this.rangeString(sheetId, data),
                label: "Kills",
                backgroundColor: KILL_COLOR,
            },
        ];
        return {
            type: "bar",
            dataSetsHaveTitle: false,
            legendPosition: "none",
            background: "#FFFFFF",
            stacked: false,
            aggregated: false,
            showValues: true,
            horizontal: false,
            ...(base || {}),
            title: { ...((base && base.title) || {}), text: this.chartMarker(block) },
            dataSets,
            labelRange: this.rangeString(sheetId, labels),
        };
    }

    /**
     * @param {DoomBlock} block
     */
    totalCellXc(block) {
        const t = /** @type {NonNullable<DoomBlock["table"]>} */ (block.table);
        return this.rangeString(block.sheetId, cellZone(t.col + 5, t.row));
    }

    /**
     * @param {DoomBlock} block
     */
    scorecardMarker(block) {
        return `${this.chartMarker(block)} kills`;
    }

    /**
     * @param {DoomBlock} block
     * @param {any} [base] existing definition to extend
     */
    scorecardDefinition(block, base) {
        return {
            type: "scorecard",
            baselineMode: "difference",
            background: "#FFFFFF",
            ...(base || {}),
            keyValue: this.totalCellXc(block),
            title: { ...((base && base.title) || {}), text: this.scorecardMarker(block) },
        };
    }

    /**
     * Where this block's figures go: scorecard on top, bar chart under it (or alone), both right
     * of the screen.
     * @param {DoomBlock} block
     */
    figureLayout(block) {
        const { row, h, px } = block;
        const col = /** @type {NonNullable<DoomBlock["table"]>} */ (block.table).col;
        const totalHeight = Math.max(CHART_MIN_HEIGHT, h * px - CHART_BOTTOM_GAP);
        const barY = SCORECARD_HEIGHT + SCORECARD_GAP;
        return {
            scorecard: { col, row, offset: { x: CHART_OFFSET_X, y: 0 }, width: CHART_WIDTH, height: SCORECARD_HEIGHT },
            barWithScorecard: {
                col,
                row,
                offset: { x: CHART_OFFSET_X, y: barY },
                width: CHART_WIDTH,
                height: Math.max(BAR_MIN_HEIGHT, totalHeight - barY),
            },
            barAlone: { col, row, offset: { x: CHART_OFFSET_X, y: 0 }, width: CHART_WIDTH, height: totalHeight },
        };
    }

    /**
     * Move/resize an existing figure to `layout` when it drifted from it (the block was resized,
     * so the table — and the figure anchor with it — moved).
     * @param {string} sheetId
     * @param {string} figureId
     * @param {{ col: number, row: number, offset: { x: number, y: number }, width: number, height: number }} layout
     */
    ensureFigureLayout(sheetId, figureId, layout) {
        const fig = this.getters.getFigure(sheetId, figureId);
        if (!fig) {
            return;
        }
        const offset = fig.offset || { x: 0, y: 0 };
        if (
            fig.col === layout.col &&
            fig.row === layout.row &&
            offset.x === layout.offset.x &&
            offset.y === layout.offset.y &&
            fig.width === layout.width &&
            fig.height === layout.height
        ) {
            return;
        }
        this.dispatch("UPDATE_FIGURE", {
            sheetId,
            figureId,
            col: layout.col,
            row: layout.row,
            offset: layout.offset,
            width: layout.width,
            height: layout.height,
        });
    }

    /**
     * UPDATE_CHART an existing chart whose definition no longer points at this block's cells.
     * @param {{ figureId: string, chartId: string }} ref
     * @param {string} sheetId
     * @param {(base: any) => any} build
     * @param {(def: any) => boolean} upToDate
     */
    refreshChart(ref, sheetId, build, upToDate) {
        let def;
        try {
            def = this.getters.getChartDefinition(ref.chartId);
        } catch {
            return;
        }
        if (!def || upToDate(def)) {
            return;
        }
        this.dispatch("UPDATE_CHART", {
            sheetId,
            figureId: ref.figureId,
            chartId: ref.chartId,
            definition: build(def),
        });
    }

    /**
     * Find this block's charts by their title markers (`ODOOM A1` / `ODOOM A1 kills`; a scorecard
     * from before the marker existed is still found by keyValue = total cell), point them at the
     * current table cells, re-anchor them after a block resize, and create whichever is missing.
     * Never duplicates.
     * @param {DoomBlock} block
     */
    ensureCharts(block) {
        const { sheetId } = block;
        const marker = this.chartMarker(block);
        const scoreMarker = this.scorecardMarker(block);
        const totalXc = normalizeXc(this.totalCellXc(block));
        const zones = this.chartZones(block);
        const dataXc = normalizeXc(this.rangeString(sheetId, zones.data));
        const labelsXc = normalizeXc(this.rangeString(sheetId, zones.labels));

        block.chart = null;
        block.scorecard = null;
        for (const chartId of this.getters.getChartIds(sheetId)) {
            let def;
            try {
                def = this.getters.getChartDefinition(chartId);
            } catch {
                continue;
            }
            if (!def) {
                continue;
            }
            const title = def.title ? def.title.text : undefined;
            if (!block.chart && def.type === "bar" && title === marker) {
                block.chart = { figureId: this.getters.getFigureIdFromChartId(chartId), chartId };
            } else if (
                !block.scorecard &&
                def.type === "scorecard" &&
                (title === scoreMarker || normalizeXc(def.keyValue) === totalXc)
            ) {
                block.scorecard = {
                    figureId: this.getters.getFigureIdFromChartId(chartId),
                    chartId,
                };
            }
        }

        const layout = this.figureLayout(block);
        let ok = true;

        if (block.scorecard) {
            this.refreshChart(
                block.scorecard,
                sheetId,
                (base) => this.scorecardDefinition(block, base),
                (def) =>
                    normalizeXc(def.keyValue) === totalXc &&
                    !!def.title &&
                    def.title.text === scoreMarker
            );
            if (block.relayout) {
                this.ensureFigureLayout(sheetId, block.scorecard.figureId, layout.scorecard);
            }
        } else {
            const figureId = this.uuid.smallUuid();
            const chartId = this.uuid.smallUuid();
            const { col, row, offset, width, height } = layout.scorecard;
            const r = this.dispatch("CREATE_CHART", {
                sheetId,
                figureId,
                chartId,
                col,
                row,
                offset,
                size: { width, height },
                definition: this.scorecardDefinition(block),
            });
            if (dispatchFailed(r)) {
                // The scorecard is a nice-to-have: log (once per block) and carry on without it.
                if (!block.setupFailureLogged) {
                    console.debug("[ODOOM] scorecard creation refused:", r.reasons);
                }
            } else {
                block.scorecard = { figureId, chartId };
            }
        }

        const barLayout = block.scorecard ? layout.barWithScorecard : layout.barAlone;
        if (block.chart) {
            this.refreshChart(
                block.chart,
                sheetId,
                (base) => this.barDefinition(block, base),
                (def) =>
                    !!def.dataSets &&
                    !!def.dataSets[0] &&
                    normalizeXc(def.dataSets[0].dataRange) === dataXc &&
                    normalizeXc(def.labelRange) === labelsXc
            );
            if (block.relayout) {
                this.ensureFigureLayout(sheetId, block.chart.figureId, barLayout);
            }
        } else {
            const figureId = this.uuid.smallUuid();
            const chartId = this.uuid.smallUuid();
            const { col, row, offset, width, height } = barLayout;
            const r = this.dispatch("CREATE_CHART", {
                sheetId,
                figureId,
                chartId,
                col,
                row,
                offset,
                size: { width, height },
                definition: this.barDefinition(block),
            });
            if (dispatchFailed(r)) {
                if (!block.setupFailureLogged) {
                    console.debug("[ODOOM] bar chart creation refused:", r.reasons);
                }
                ok = false;
            } else {
                block.chart = { figureId, chartId };
            }
        }
        if (ok) {
            block.relayout = false;
        }
        return ok;
    }

    // ---- kills -> kill log + chart --------------------------------------------------------------

    /**
     * Engine "kill" event (fires from the RAF loop, model idle).
     * @param {{ total: number, delta: number, health: number, bullets: number, seconds: number }} payload
     */
    onKill(payload) {
        if (!this.isModelUsable() || !this.isGridResponsive()) {
            // Not the grid on screen (stale instance of a closed spreadsheet): never write there.
            return;
        }
        try {
            if (this.getters.isReadonly()) {
                return;
            }
            for (const block of this.blocks.values()) {
                if (block.ready && block.table && this.getters.tryGetSheet(block.sheetId)) {
                    this.appendKill(block, payload);
                }
            }
        } catch (err) {
            console.debug("[ODOOM] kill handler failed:", err);
        }
    }

    /**
     * @param {DoomBlock} block
     * @param {{ total: number, delta: number, health: number, bullets: number, seconds: number }} payload
     */
    appendKill(block, payload) {
        const { sheetId } = block;
        const t = /** @type {NonNullable<DoomBlock["table"]>} */ (block.table);
        const r = t.nextRow;

        const numberRows = this.getters.getNumberRows(sheetId);
        if (r >= numberRows) {
            const grow = this.dispatch("ADD_COLUMNS_ROWS", {
                sheetId,
                dimension: "ROW",
                base: numberRows - 1,
                position: "after",
                quantity: Math.max(ROWS_CHUNK, r - numberRows + 1),
            });
            if (dispatchFailed(grow)) {
                return;
            }
        }

        t.count += 1;
        const seconds = Number.isFinite(payload.seconds)
            ? payload.seconds
            : doomEngine.secondsSinceStart();
        const values = [
            String(t.count),
            seconds.toFixed(1),
            String(Math.round(payload.health)),
            String(Math.round(payload.bullets)),
        ];
        values.forEach((content, i) => {
            this.dispatch("UPDATE_CELL", { sheetId, col: t.col + i, row: r, content });
        });
        this.dispatch("UPDATE_CELL", {
            sheetId,
            col: t.col + 5,
            row: t.row,
            content: String(t.count),
            style: LABEL_STYLE,
        });
        t.nextRow = r + 1;

        // Grow the bar chart ranges to trow+1 .. r.
        if (block.chart) {
            const { chartId, figureId } = block.chart;
            if (this.getters.getChartIds(sheetId).includes(chartId)) {
                let base;
                try {
                    base = this.getters.getChartDefinition(chartId);
                } catch {
                    base = undefined;
                }
                this.dispatch("UPDATE_CHART", {
                    sheetId,
                    figureId,
                    chartId,
                    definition: this.barDefinition(block, base),
                });
            } else {
                // Someone deleted the chart: the next tick recreates it.
                block.chart = null;
                block.ready = false;
            }
        }
        if (block.scorecard && !this.getters.getChartIds(sheetId).includes(block.scorecard.chartId)) {
            block.scorecard = null;
            block.ready = false;
        }
    }

    // ---- redraw driving ------------------------------------------------------------------------

    hasBlockOnActiveSheet() {
        const active = this.getters.getActiveSheetId();
        for (const block of this.blocks.values()) {
            if (block.sheetId === active) {
                return true;
            }
        }
        return false;
    }

    maybeRedraw() {
        if (!this.blocks.size) {
            return;
        }
        const now = Date.now();
        // A grid that never draws although we keep asking is not on screen: back off.
        if (this.unansweredSince !== null && now - this.unansweredSince > NO_DRAW_SUSPEND_MS) {
            this.suspended = true;
        }
        const frameCount = doomEngine.frameCount;
        if (frameCount === this.lastFrameCount || !this.hasBlockOnActiveSheet()) {
            return;
        }
        // Backpressure: one request in flight at a time (every ODOOM_TICK is a full Owl re-render
        // plus a grid repaint). Retry an unanswered request after a short while — a dispatch is
        // refused without an "update" while an undo/redo ack is pending — and only every
        // SUSPENDED_RETRY_MS once we believe the grid is gone.
        if (this.unansweredSince !== null) {
            const wait = this.suspended ? SUSPENDED_RETRY_MS : REDRAW_RETRY_MS;
            if (now - this.lastRedrawRequestAt < wait) {
                return;
            }
        }
        this.lastFrameCount = frameCount;
        this.lastRedrawRequestAt = now;
        if (this.unansweredSince === null) {
            this.unansweredSince = now;
        }
        if (!this.getters.isReadonly()) {
            this.dispatch("ODOOM_TICK");
        } else {
            // Custom commands are refused in readonly before anything happens; a viewport command
            // that changes nothing is allowed there and its rejection still triggers "update".
            const { scrollX, scrollY } = this.getters.getActiveSheetScrollInfo();
            this.dispatch("SET_VIEWPORT_OFFSET", { offsetX: scrollX, offsetY: scrollY });
        }
    }

    maybeLogFps() {
        const now = Date.now();
        const elapsed = now - this.lastFpsLog;
        if (elapsed < FPS_LOG_MS) {
            return;
        }
        if (this.blocks.size) {
            const fps = Math.round((this.paintedFrames * 1000) / elapsed);
            console.debug("[ODOOM] fps", fps);
        }
        this.paintedFrames = 0;
        this.lastFpsLog = now;
    }

    // ---- keyboard ownership -------------------------------------------------------------------

    /**
     * True when the active cell is inside one of this model's screens on the active sheet and no
     * text input / composer owns the focus.
     */
    isPlaying() {
        if (!this.blocks.size || this.intervalId === null || !this.isGridResponsive()) {
            return false;
        }
        try {
            const active = this.getters.getActiveSheetId();
            const pos = this.getters.getActivePosition();
            if (pos.sheetId !== active) {
                return false;
            }
            let inside = false;
            for (const block of this.blocks.values()) {
                if (block.sheetId === active && isInside(pos.col, pos.row, block.zone)) {
                    inside = true;
                    break;
                }
            }
            if (!inside) {
                return false;
            }
            if (typeof document !== "undefined" && isEditingElement(document.activeElement)) {
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @param {DoomBlock} block
     */
    isPlayingBlock(block) {
        if (!this.isGridResponsive()) {
            return false;
        }
        try {
            const pos = this.getters.getActivePosition();
            if (pos.sheetId !== block.sheetId || !isInside(pos.col, pos.row, block.zone)) {
                return false;
            }
            return !(typeof document !== "undefined" && isEditingElement(document.activeElement));
        } catch {
            return false;
        }
    }

    // ---- drawing -------------------------------------------------------------------------------

    /**
     * @param {DoomBlock} block
     */
    getSmallCanvas(block) {
        let canvas = this.smallCanvases.get(block.id);
        if (!canvas || canvas.width !== block.w || canvas.height !== block.h) {
            canvas = /** @type {HTMLCanvasElement & { odoomFrame?: number }} */ (
                document.createElement("canvas")
            );
            canvas.width = block.w;
            canvas.height = block.h;
            canvas.odoomFrame = -1;
            this.smallCanvases.set(block.id, canvas);
        }
        return canvas;
    }

    /**
     * Clip a zone to the sheet. For a zone running past the last column/row (sheet never grown in
     * edit mode, ADD_COLUMNS_ROWS refused) getRect() yields NaN sizes — the header positions only
     * exist up to the sheet size — and NaN canvas calls paint nothing at all; clipped, the screen
     * (or the LOADING placeholder) still shows.
     * @param {string} sheetId
     * @param {Zone} zone
     * @returns {Zone | null} null when no cell of the zone is inside the sheet
     */
    clampZone(sheetId, zone) {
        const right = Math.min(zone.right, this.getters.getNumberCols(sheetId) - 1);
        const bottom = Math.min(zone.bottom, this.getters.getNumberRows(sheetId) - 1);
        if (right < zone.left || bottom < zone.top) {
            return null;
        }
        if (right === zone.right && bottom === zone.bottom) {
            return zone;
        }
        return { left: zone.left, top: zone.top, right, bottom };
    }

    /**
     * @param {{ ctx: CanvasRenderingContext2D, dpr: number, thinLineWidth: number }} renderingContext
     * @param {string} layer
     */
    drawLayer(renderingContext, layer) {
        if (layer !== "Chart") {
            return;
        }
        // Liveness bookkeeping first, blocks or not: a drawLayer call is the only proof that this
        // model's grid is the one on screen.
        this.lastDrawAt = Date.now();
        this.unansweredSince = null;
        this.suspended = false;
        const { ctx } = renderingContext;
        if (ctx && ctx.canvas) {
            this.gridCanvas = ctx.canvas;
        }
        if (!this.blocks.size) {
            return;
        }
        const activeSheet = this.getters.getActiveSheetId();
        const frameCount = doomEngine.frameCount;
        let painted = false;

        for (const block of this.blocks.values()) {
            if (block.sheetId !== activeSheet) {
                continue;
            }
            const zone = this.clampZone(activeSheet, block.zone);
            if (!zone) {
                continue;
            }
            const visible = this.getters.getVisibleRect(zone);
            if (visible.width > 0 && visible.height > 0) {
                const full = this.getters.getRect(zone);
                ctx.save();
                ctx.beginPath();
                ctx.rect(visible.x, visible.y, visible.width, visible.height);
                ctx.clip();
                if (frameCount > 0 && doomEngine.frameCanvas) {
                    this.paintFrame(ctx, block, zone, full, frameCount);
                    painted = true;
                } else {
                    this.paintPlaceholder(ctx, full);
                }
                ctx.restore();
            }
            this.paintCaption(ctx, block, zone);
        }

        if (painted && frameCount !== this.lastPaintedFrame) {
            this.lastPaintedFrame = frameCount;
            this.paintedFrames++;
        }
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {DoomBlock} block
     * @param {Zone} zone the block zone clipped to the sheet
     * @param {{ x: number, y: number, width: number, height: number }} full rect of `zone`
     * @param {number} frameCount
     */
    paintFrame(ctx, block, zone, full, frameCount) {
        const small = this.getSmallCanvas(block);
        if (small.odoomFrame !== frameCount) {
            const sctx = small.getContext("2d");
            if (sctx) {
                sctx.imageSmoothingEnabled = true;
                sctx.imageSmoothingQuality = "high";
                sctx.drawImage(
                    /** @type {HTMLCanvasElement} */ (doomEngine.frameCanvas),
                    0,
                    0,
                    FRAME_W,
                    FRAME_H,
                    0,
                    0,
                    block.w,
                    block.h
                );
                small.odoomFrame = frameCount;
            }
        }
        // Only the part of the screen that fits in the sheet, one source pixel per cell.
        const cols = zone.right - zone.left + 1;
        const rows = zone.bottom - zone.top + 1;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, cols, rows, full.x, full.y, full.width, full.height);

        // Cell grid lines over the picture so it still reads as spreadsheet cells.
        const cw = full.width / cols;
        const rh = full.height / rows;
        ctx.strokeStyle = "rgba(0,0,0,0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = 0; c <= cols; c++) {
            const x = Math.round(full.x + c * cw);
            ctx.moveTo(x, full.y);
            ctx.lineTo(x, full.y + full.height);
        }
        for (let r = 0; r <= rows; r++) {
            const y = Math.round(full.y + r * rh);
            ctx.moveTo(full.x, y);
            ctx.lineTo(full.x + full.width, y);
        }
        ctx.stroke();
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{ x: number, y: number, width: number, height: number }} full
     */
    paintPlaceholder(ctx, full) {
        ctx.fillStyle = "#101010";
        ctx.fillRect(full.x, full.y, full.width, full.height);
        const text =
            doomEngine.state === "error"
                ? `DOOM FAILED: ${doomEngine.error || "unknown error"}`
                : "LOADING DOOM…";
        ctx.fillStyle = doomEngine.state === "error" ? "#FF8A80" : "#EEEEEE";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, full.x + full.width / 2, full.y + full.height / 2, full.width - 8);
    }

    /**
     * Caption in the gap row (row+h), clipped to the screen width plus the gap column.
     * @param {CanvasRenderingContext2D} ctx
     * @param {DoomBlock} block
     * @param {Zone} zone the block zone clipped to the sheet
     */
    paintCaption(ctx, block, zone) {
        const gapZone = this.clampZone(block.sheetId, {
            left: block.col,
            right: block.col + block.w,
            top: block.row + block.h,
            bottom: block.row + block.h,
        });
        if (!gapZone) {
            return; // the gap row is outside the (un-grown) sheet
        }
        const visible = this.getters.getVisibleRect(gapZone);
        if (!(visible.width > 0 && visible.height > 0)) {
            return;
        }
        const full = this.getters.getRect(zone);
        const kills = block.table ? block.table.count : doomEngine.stats.totalKills;
        const text = this.isPlayingBlock(block) ? `${CAPTION_PLAYING}${kills}` : CAPTION_IDLE;
        ctx.save();
        ctx.beginPath();
        ctx.rect(visible.x, visible.y, visible.width, visible.height);
        ctx.clip();
        ctx.fillStyle = "#555555";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(text, full.x, full.y + full.height + 15);
        ctx.restore();
    }
}

featurePluginRegistry.add("odoom", OdoomPlugin);
