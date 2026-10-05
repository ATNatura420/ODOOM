/** @odoo-module **/
/* eslint-disable no-console */
/**
 * ODOOM — page-singleton wrapper around the wasm-fizzbuzz linuxdoom-1.10 build (doom.wasm).
 *
 * Plain ESM with NO imports: Odoo bundles this file (spreadsheet.o_spreadsheet), and the Node probe
 * in static/tests/node/engine_probe.mjs imports it directly through a file:// URL. Every DOM usage is
 * guarded so the same code runs headless.
 *
 * Public API (see ODOOM_SPEC.md §1):
 *   WASM_URL
 *   doomEngine.state            "idle" | "loading" | "running" | "error"
 *   doomEngine.error            null | string
 *   doomEngine.frameCanvas      HTMLCanvasElement 640x400 (browser only, created lazily) | null
 *   doomEngine.latestFrame      Uint8ClampedArray(1,024,000) copy of the latest RGBA frame | null
 *   doomEngine.frameCount       number of js_draw_screen calls so far
 *   doomEngine.stats            { found, health, armor, bullets, killcount, totalKills, levelChanges }
 *   doomEngine.start(opts?)     idempotent; opts = { wasmBytes?, now?, autoLoop? }
 *   doomEngine.step()           one doom_loop_step + stats poll
 *   doomEngine.keyDown(code) / keyUp(code)
 *   doomEngine.handleKeyboardEvent(ev, isDown) -> boolean (false when unmapped, incl. F5 / F12)
 *   doomEngine.on(event, cb) -> unsubscribe        event: "frame" | "kill" | "state" | "levelchange"
 *   doomEngine.secondsSinceStart()                 seconds since the first drawn frame
 *
 * Event payloads:
 *   "frame"        { frameCount }
 *   "state"        { state, error }
 *   "levelchange"  { killcount, previous, levelChanges, seconds }
 *   "kill"         { total, delta, health, bullets, seconds, killcount }
 *                  One event per kill. When killcount jumps by n in a single poll, n events fire with
 *                  consecutive `total` values and the same `delta` (= n, the size of the jump).
 *
 * Facts this file relies on (all verified against the binary / sources, see the spec):
 *   - wasm imports: js.{js_milliseconds_since_start, js_console_log, js_stdout, js_stderr, js_draw_screen},
 *     env.memory (WebAssembly.Memory({ initial: 108 }), grows to ~146 pages).
 *   - exports: main() (D_DoomMain init, returns), doom_loop_step(), add_browser_event(type, code) with
 *     type 0 = KeyDown, 1 = KeyUp.
 *   - js_draw_screen(ptr): 640x400 RGBA framebuffer at ptr inside memory.buffer.
 *   - Doom busy-waits inside doom_loop_step until the ms clock advances (TryRunTics), so the clock passed
 *     as `now` MUST move between reads (performance.now() in a browser; an incrementing fake clock in Node).
 *   - players[0].maxammo sits at byte offset 6429292 and reads [200, 50, 300, 50] once a game has started;
 *     killcount is at +32 bytes, health at -140, armorpoints at -136, ammo[0] (bullets) at -16.
 */

export const WASM_URL = "/odoom/static/lib/doom/doom.wasm";

const FRAME_W = 640;
const FRAME_H = 400;
const FRAME_BYTES = FRAME_W * FRAME_H * 4; // 1,024,000

const WASM_INITIAL_PAGES = 108;

// players[0].maxammo in THIS binary (verified by the scratchpad probe.mjs signature scan).
const MAXAMMO_BYTE_OFFSET = 6429292;
const MAXAMMO_I32_INDEX = MAXAMMO_BYTE_OFFSET / 4; // 1607323
const MAXAMMO_SIGNATURE = [200, 50, 300, 50];
// Int32 deltas relative to the maxammo index (byte deltas / 4).
const OFF_HEALTH = -35; // -140 bytes
const OFF_ARMOR = -34; // -136 bytes
const OFF_WEAPONOWNED = -13; // -52 bytes
const OFF_AMMO = -4; // -16 bytes, ammo[0] = bullets
const OFF_KILLCOUNT = 8; // +32 bytes

const SCAN_INTERVAL_MS = 1000;
const MAX_SCAN_ATTEMPTS = 600; // stop scanning after ~10 minutes without a game start

const EVENT_TYPE_KEYDOWN = 0;
const EVENT_TYPE_KEYUP = 1;

const STDERR_SPAM = [
    "Demo is from a different game version!",
    "S_StartSoundAtVolume: 16bit and not pre-cached - wtf?",
];

const EVENT_NAMES = ["frame", "kill", "state", "levelchange"];

/** DOOM key codes (doomdef.h + the original main.js glue). */
export const DOOM_KEYS = Object.freeze({
    LEFT: 0xac,
    UP: 0xad,
    RIGHT: 0xae,
    DOWN: 0xaf,
    ESCAPE: 27,
    ENTER: 13,
    TAB: 9,
    BACKSPACE: 127,
    PAUSE: 0xff,
    SPACE: 32,
    RSHIFT: 0x80 + 0x36, // 0xb6 run
    RCTRL: 0x80 + 0x1d, // 0x9d fire
    RALT: 0x80 + 0x38, // 0xb8 strafe
    F1: 0x80 + 0x3b, // 187 (= browser keyCode 112 + 75)
    F2: 0x80 + 0x3c,
    F3: 0x80 + 0x3d,
    F4: 0x80 + 0x3e,
    F5: 0x80 + 0x3f,
    F6: 0x80 + 0x40,
    F7: 0x80 + 0x41,
    F8: 0x80 + 0x42,
    F9: 0x80 + 0x43,
    F10: 0x80 + 0x44,
    F11: 0x80 + 0x57, // doomdef.h KEY_F11 (NOT keyCode + 75)
    F12: 0x80 + 0x58,
});

// Keys the browser keeps: reload and devtools.
const BROWSER_RESERVED_KEYS = new Set(["F5", "F12"]);

const NAMED_KEYS = {
    ArrowLeft: DOOM_KEYS.LEFT,
    ArrowUp: DOOM_KEYS.UP,
    ArrowRight: DOOM_KEYS.RIGHT,
    ArrowDown: DOOM_KEYS.DOWN,
    // Legacy names (old Edge / IE)
    Left: DOOM_KEYS.LEFT,
    Up: DOOM_KEYS.UP,
    Right: DOOM_KEYS.RIGHT,
    Down: DOOM_KEYS.DOWN,
    Control: DOOM_KEYS.RCTRL,
    Alt: DOOM_KEYS.RALT,
    AltGraph: DOOM_KEYS.RALT,
    Shift: DOOM_KEYS.RSHIFT,
    Enter: DOOM_KEYS.ENTER,
    Escape: DOOM_KEYS.ESCAPE,
    Esc: DOOM_KEYS.ESCAPE,
    Backspace: DOOM_KEYS.BACKSPACE,
    Tab: DOOM_KEYS.TAB,
    Pause: DOOM_KEYS.PAUSE,
    " ": DOOM_KEYS.SPACE,
    Spacebar: DOOM_KEYS.SPACE,
    F1: DOOM_KEYS.F1,
    F2: DOOM_KEYS.F2,
    F3: DOOM_KEYS.F3,
    F4: DOOM_KEYS.F4,
    F6: DOOM_KEYS.F6,
    F7: DOOM_KEYS.F7,
    F8: DOOM_KEYS.F8,
    F9: DOOM_KEYS.F9,
    F10: DOOM_KEYS.F10,
    F11: DOOM_KEYS.F11,
};

const CODE_KEYS = {
    ArrowLeft: DOOM_KEYS.LEFT,
    ArrowUp: DOOM_KEYS.UP,
    ArrowRight: DOOM_KEYS.RIGHT,
    ArrowDown: DOOM_KEYS.DOWN,
    ControlLeft: DOOM_KEYS.RCTRL,
    ControlRight: DOOM_KEYS.RCTRL,
    AltLeft: DOOM_KEYS.RALT,
    AltRight: DOOM_KEYS.RALT,
    ShiftLeft: DOOM_KEYS.RSHIFT,
    ShiftRight: DOOM_KEYS.RSHIFT,
    Enter: DOOM_KEYS.ENTER,
    NumpadEnter: DOOM_KEYS.ENTER,
    Escape: DOOM_KEYS.ESCAPE,
    Backspace: DOOM_KEYS.BACKSPACE,
    Tab: DOOM_KEYS.TAB,
    Space: DOOM_KEYS.SPACE,
    Pause: DOOM_KEYS.PAUSE,
};

/**
 * Map a KeyboardEvent (or any {key, code} object) to a DOOM key code.
 * Returns null when the key is unmapped or reserved for the browser (F5, F12).
 */
export function mapKeyboardEvent(ev) {
    if (!ev) {
        return null;
    }
    const key = typeof ev.key === "string" ? ev.key : "";
    const code = typeof ev.code === "string" ? ev.code : "";
    if (BROWSER_RESERVED_KEYS.has(key) || BROWSER_RESERVED_KEYS.has(code)) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, key)) {
        return NAMED_KEYS[key];
    }
    if (key.length === 1) {
        // Physical digit row / numpad first: DOOM selects weapons with the exact ASCII digits
        // (g_game.c: `gamekeydown['1'+i]`), which ev.key does not deliver while Shift (= run) is
        // held ('!'..'&') nor on layouts whose unshifted digit row is punctuation (AZERTY). Using
        // the code for both keydown and keyup also keeps a shifted press from getting stuck.
        const d = /^(?:Digit|Numpad)(\d)$/.exec(code);
        if (d) {
            return d[1].charCodeAt(0);
        }
        const ch = key.charCodeAt(0);
        if (ch >= 65 && ch <= 90) {
            return ch + 32; // A-Z -> a-z (menus use y/n, cheats are lowercase)
        }
        if (ch >= 32 && ch <= 126) {
            return ch; // digits (weapons), punctuation ('-' '=' screen size, ',' '.' strafe) ...
        }
        // Non-ASCII character (é, ü, ...): fall through to the physical code below.
    }
    // ev.key was not usable ("Dead", "Unidentified", "Process", non-ASCII): fall back to the physical code.
    if (Object.prototype.hasOwnProperty.call(CODE_KEYS, code)) {
        return CODE_KEYS[code];
    }
    let m = /^Key([A-Z])$/.exec(code);
    if (m) {
        return m[1].charCodeAt(0) + 32;
    }
    m = /^(?:Digit|Numpad)(\d)$/.exec(code);
    if (m) {
        return m[1].charCodeAt(0);
    }
    m = /^F(\d{1,2})$/.exec(code);
    if (m) {
        const fk = DOOM_KEYS["F" + m[1]];
        return fk === undefined ? null : fk;
    }
    return null;
}

function hasDocument() {
    return typeof document !== "undefined" && document !== null && typeof document.createElement === "function";
}

function defaultNow() {
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
        return () => performance.now();
    }
    return () => Date.now();
}

function errorText(err) {
    if (err === null || err === undefined) {
        return "unknown error";
    }
    if (typeof err === "string") {
        return err;
    }
    if (err.message) {
        return `${err.name || "Error"}: ${err.message}`;
    }
    return String(err);
}

function createDoomEngine() {
    // ---- private state --------------------------------------------------------------------------
    let startPromise = null;
    let memory = null;
    let exports_ = null;
    let now = defaultNow();
    let clockBase = null;
    let firstFrameAt = null;
    let rafId = null;
    let inStep = false;
    let ctx2d = null;
    let imageData = null;
    let canvasFailed = false;

    // stats detection
    let maxammoIndex = -1; // Int32 index once found
    let lastKillcount = 0;
    let lastScanAt = -Infinity;
    let scanAttempts = 0;

    // listeners
    const listeners = new Map(EVENT_NAMES.map((name) => [name, new Set()]));

    // console throttling (wall clock, independent of the game clock)
    const LOG_BUDGET_PER_SECOND = 20;
    let logWindowStart = 0;
    let logCountInWindow = 0;
    let logSuppressed = 0;
    const lineBuffers = { out: "", log: "", err: "" };

    let textDecoder = null;
    function decodeString(ptr, len) {
        if (!memory) {
            return "";
        }
        // Fresh view every time: memory.buffer changes identity when the memory grows.
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        if (typeof TextDecoder !== "undefined") {
            textDecoder = textDecoder || new TextDecoder("utf-8");
            return textDecoder.decode(bytes);
        }
        let s = "";
        for (let i = 0; i < bytes.length; i++) {
            s += String.fromCharCode(bytes[i]);
        }
        return s;
    }

    function throttledLog(level, ...args) {
        const t = Date.now();
        if (t - logWindowStart >= 1000) {
            if (logSuppressed > 0) {
                console.debug(`[ODOOM] (${logSuppressed} console lines suppressed)`);
            }
            logWindowStart = t;
            logCountInWindow = 0;
            logSuppressed = 0;
        }
        if (logCountInWindow >= LOG_BUDGET_PER_SECOND) {
            logSuppressed++;
            return;
        }
        logCountInWindow++;
        const fn = console[level] || console.log;
        fn.call(console, "[ODOOM]", ...args);
    }

    function emitLine(stream, line) {
        if (!line) {
            return;
        }
        if (stream === "err") {
            for (const spam of STDERR_SPAM) {
                if (line.indexOf(spam) !== -1) {
                    return;
                }
            }
            throttledLog("warn", "stderr:", line);
            return;
        }
        throttledLog("debug", line);
    }

    function appendOutput(stream, text) {
        const buffered = lineBuffers[stream] + text;
        const parts = buffered.split("\n");
        lineBuffers[stream] = parts.pop();
        for (const line of parts) {
            emitLine(stream, line.replace(/\r$/, ""));
        }
        if (lineBuffers[stream].length > 2048) {
            emitLine(stream, lineBuffers[stream]);
            lineBuffers[stream] = "";
        }
    }

    function flushOutput() {
        for (const stream of Object.keys(lineBuffers)) {
            if (lineBuffers[stream]) {
                emitLine(stream, lineBuffers[stream]);
                lineBuffers[stream] = "";
            }
        }
    }

    function emit(event, payload) {
        const set = listeners.get(event);
        if (!set || set.size === 0) {
            return;
        }
        for (const cb of Array.from(set)) {
            try {
                cb(payload);
            } catch (err) {
                // Never let a listener error unwind through the wasm call stack.
                throttledLog("error", `listener for "${event}" threw:`, err);
            }
        }
    }

    function setState(state, error) {
        engine.state = state;
        engine.error = error === undefined ? null : error;
        emit("state", { state: engine.state, error: engine.error });
    }

    function stopLoop() {
        if (rafId !== null) {
            if (typeof cancelAnimationFrame === "function") {
                try {
                    cancelAnimationFrame(rafId);
                } catch (_err) {
                    // ignore
                }
            }
            rafId = null;
        }
    }

    function fail(err, where) {
        stopLoop();
        const msg = `${where}: ${errorText(err)}`;
        setState("error", msg);
        console.error("[ODOOM]", msg, err);
    }

    // ---- wasm imports ---------------------------------------------------------------------------
    function jsMillisecondsSinceStart() {
        const t = now();
        if (clockBase === null) {
            clockBase = t;
        }
        // +1 so the first value is never 0 (I_GetTime treats a 0 BASETIME as "not initialised").
        return (Math.floor(t - clockBase) + 1) | 0;
    }

    function ensureCanvas() {
        if (engine.frameCanvas || canvasFailed || !hasDocument()) {
            return;
        }
        try {
            const canvas = document.createElement("canvas");
            canvas.width = FRAME_W;
            canvas.height = FRAME_H;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                throw new Error("2d context unavailable");
            }
            let img = null;
            if (typeof ImageData === "function") {
                try {
                    // Share the buffer with latestFrame: one copy per frame feeds both.
                    img = new ImageData(engine.latestFrame, FRAME_W, FRAME_H);
                } catch (_err) {
                    img = null;
                }
            }
            if (!img) {
                img = ctx.createImageData(FRAME_W, FRAME_H);
            }
            ctx2d = ctx;
            imageData = img;
            engine.frameCanvas = canvas;
        } catch (err) {
            canvasFailed = true;
            throttledLog("warn", "frame canvas unavailable:", errorText(err));
        }
    }

    function jsDrawScreen(ptr) {
        try {
            if (!memory || ptr < 0 || ptr + FRAME_BYTES > memory.buffer.byteLength) {
                return;
            }
            const view = new Uint8ClampedArray(memory.buffer, ptr, FRAME_BYTES);
            if (!engine.latestFrame || engine.latestFrame.length !== FRAME_BYTES) {
                engine.latestFrame = new Uint8ClampedArray(FRAME_BYTES);
            }
            engine.latestFrame.set(view);
            engine.frameCount++;
            if (firstFrameAt === null) {
                firstFrameAt = now();
            }
            ensureCanvas();
            if (ctx2d && imageData) {
                if (imageData.data !== engine.latestFrame) {
                    imageData.data.set(engine.latestFrame);
                }
                ctx2d.putImageData(imageData, 0, 0);
            }
            emit("frame", { frameCount: engine.frameCount });
        } catch (err) {
            throttledLog("error", "js_draw_screen failed:", errorText(err));
        }
    }

    function buildImports(mem) {
        return {
            js: {
                js_milliseconds_since_start: jsMillisecondsSinceStart,
                js_console_log: (ptr, len) => appendOutput("log", decodeString(ptr, len)),
                js_stdout: (ptr, len) => appendOutput("out", decodeString(ptr, len)),
                js_stderr: (ptr, len) => appendOutput("err", decodeString(ptr, len)),
                js_draw_screen: jsDrawScreen,
            },
            env: { memory: mem },
        };
    }

    // ---- player stats ---------------------------------------------------------------------------
    function signatureAt(a, i) {
        return (
            a[i] === MAXAMMO_SIGNATURE[0] &&
            a[i + 1] === MAXAMMO_SIGNATURE[1] &&
            a[i + 2] === MAXAMMO_SIGNATURE[2] &&
            a[i + 3] === MAXAMMO_SIGNATURE[3]
        );
    }

    function strictSignatureAt(a, i) {
        // maxammo [200,50,300,50], ammo [50,0,0,0], weaponowned [1,1,0,...,0] (fresh player, G_PlayerReborn)
        return (
            signatureAt(a, i) &&
            a[i + OFF_AMMO] === 50 &&
            a[i + OFF_AMMO + 1] === 0 &&
            a[i + OFF_AMMO + 2] === 0 &&
            a[i + OFF_AMMO + 3] === 0 &&
            a[i + OFF_WEAPONOWNED] === 1 &&
            a[i + OFF_WEAPONOWNED + 1] === 1 &&
            a[i + OFF_WEAPONOWNED + 2] === 0 &&
            a[i + OFF_WEAPONOWNED + 8] === 0
        );
    }

    function locatePlayer() {
        const byteLength = memory.buffer.byteLength;
        const a = new Int32Array(memory.buffer, 0, Math.floor(byteLength / 4));
        // 1. hardcoded offset, every step
        if (byteLength >= MAXAMMO_BYTE_OFFSET + 64 && signatureAt(a, MAXAMMO_I32_INDEX)) {
            return MAXAMMO_I32_INDEX;
        }
        // 2. full scan, at most once per second (game clock), bounded number of attempts
        const t = now();
        if (t - lastScanAt < SCAN_INTERVAL_MS || scanAttempts >= MAX_SCAN_ATTEMPTS) {
            return -1;
        }
        lastScanAt = t;
        scanAttempts++;
        const start = -OFF_WEAPONOWNED; // 13: lowest index the strict check reads back to
        const end = a.length - 12;
        for (let i = start; i < end; i++) {
            if (a[i] === 200 && a[i + 1] === 50 && a[i + 2] === 300 && a[i + 3] === 50 && strictSignatureAt(a, i)) {
                throttledLog("debug", `player struct found by scan at byte ${i * 4}`);
                return i;
            }
        }
        return -1;
    }

    function onPlayerFound(index) {
        maxammoIndex = index;
        const a = new Int32Array(memory.buffer, 0, Math.floor(memory.buffer.byteLength / 4));
        engine.stats.found = true;
        engine.stats.health = a[index + OFF_HEALTH];
        engine.stats.armor = a[index + OFF_ARMOR];
        engine.stats.bullets = a[index + OFF_AMMO];
        engine.stats.killcount = a[index + OFF_KILLCOUNT];
        lastKillcount = engine.stats.killcount;
        throttledLog(
            "debug",
            `player stats online (maxammo @ byte ${index * 4}): health=${engine.stats.health} killcount=${lastKillcount}`
        );
    }

    function pollStats() {
        if (!memory) {
            return;
        }
        if (maxammoIndex < 0) {
            const idx = locatePlayer();
            if (idx < 0) {
                return;
            }
            onPlayerFound(idx);
            return;
        }
        const a = new Int32Array(memory.buffer, 0, Math.floor(memory.buffer.byteLength / 4));
        const stats = engine.stats;
        stats.health = a[maxammoIndex + OFF_HEALTH];
        stats.armor = a[maxammoIndex + OFF_ARMOR];
        stats.bullets = a[maxammoIndex + OFF_AMMO];
        const killcount = a[maxammoIndex + OFF_KILLCOUNT];
        stats.killcount = killcount;
        if (killcount === lastKillcount) {
            return;
        }
        if (killcount < lastKillcount) {
            // killcount resets to 0 on every new level (and on G_PlayerReborn): re-baseline.
            const previous = lastKillcount;
            lastKillcount = killcount;
            stats.levelChanges++;
            emit("levelchange", {
                killcount,
                previous,
                levelChanges: stats.levelChanges,
                seconds: engine.secondsSinceStart(),
            });
            return;
        }
        const delta = killcount - lastKillcount;
        lastKillcount = killcount;
        const seconds = engine.secondsSinceStart();
        for (let i = 0; i < delta; i++) {
            stats.totalKills++;
            emit("kill", {
                total: stats.totalKills,
                delta,
                health: stats.health,
                bullets: stats.bullets,
                seconds,
                killcount,
            });
        }
    }

    // ---- main loop ------------------------------------------------------------------------------
    function rafTick() {
        rafId = null;
        if (engine.state !== "running") {
            return;
        }
        engine.step();
        if (engine.state === "running") {
            rafId = requestAnimationFrame(rafTick);
        }
    }

    function startLoop() {
        if (typeof requestAnimationFrame !== "function") {
            throttledLog("warn", "requestAnimationFrame unavailable; call step() manually");
            return;
        }
        if (rafId === null) {
            rafId = requestAnimationFrame(rafTick);
        }
    }

    async function loadBytes(wasmBytes) {
        if (wasmBytes) {
            return wasmBytes;
        }
        if (typeof fetch !== "function") {
            throw new Error("no wasmBytes given and fetch() is unavailable");
        }
        const response = await fetch(WASM_URL);
        if (!response.ok) {
            throw new Error(`fetch ${WASM_URL} failed: HTTP ${response.status}`);
        }
        // arrayBuffer() (not instantiateStreaming): the served MIME type may not be application/wasm.
        return response.arrayBuffer();
    }

    async function doStart(opts) {
        if (typeof WebAssembly === "undefined") {
            throw new Error("WebAssembly is not supported in this environment");
        }
        if (typeof opts.now === "function") {
            now = opts.now;
        }
        setState("loading", null);
        const bytes = await loadBytes(opts.wasmBytes);
        const mem = new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES });
        const result = await WebAssembly.instantiate(bytes, buildImports(mem));
        // instantiate(bytes) resolves { module, instance }; instantiate(module) resolves an Instance.
        const instance = result && result.instance ? result.instance : result;
        const ex = instance.exports;
        for (const name of ["main", "doom_loop_step", "add_browser_event"]) {
            if (typeof ex[name] !== "function") {
                throw new Error(`doom.wasm export "${name}" is missing`);
            }
        }
        memory = mem;
        exports_ = ex;
        try {
            ex.main(); // D_DoomMain init; returns.
        } finally {
            flushOutput();
        }
        setState("running", null);
        const autoLoop = opts.autoLoop === undefined ? typeof requestAnimationFrame === "function" : !!opts.autoLoop;
        if (autoLoop) {
            startLoop();
        }
    }

    // ---- public object --------------------------------------------------------------------------
    const engine = {
        state: "idle",
        error: null,
        frameCanvas: null,
        latestFrame: null,
        frameCount: 0,
        stats: {
            found: false,
            health: 0,
            armor: 0,
            bullets: 0,
            killcount: 0,
            totalKills: 0,
            levelChanges: 0,
        },

        /**
         * Load + instantiate doom.wasm and run main(). Idempotent: every call returns the same promise.
         * @param {{ wasmBytes?: ArrayBuffer|Uint8Array, now?: () => number, autoLoop?: boolean }} [opts]
         */
        start(opts) {
            if (startPromise) {
                return startPromise;
            }
            startPromise = doStart(opts || {}).catch((err) => {
                fail(err, "start failed");
                throw err;
            });
            return startPromise;
        },

        /** One doom_loop_step() followed by a stats poll. The RAF loop calls this once per animation frame. */
        step() {
            if (engine.state !== "running" || !exports_ || inStep) {
                return;
            }
            inStep = true;
            try {
                exports_.doom_loop_step();
            } catch (err) {
                inStep = false;
                flushOutput();
                fail(err, "doom_loop_step threw");
                return;
            }
            inStep = false;
            try {
                pollStats();
            } catch (err) {
                throttledLog("error", "stats poll failed:", errorText(err));
            }
            flushOutput();
        },

        keyDown(doomCode) {
            if (exports_ && engine.state === "running") {
                exports_.add_browser_event(EVENT_TYPE_KEYDOWN, doomCode | 0);
            }
        },

        keyUp(doomCode) {
            if (exports_ && engine.state === "running") {
                exports_.add_browser_event(EVENT_TYPE_KEYUP, doomCode | 0);
            }
        },

        /**
         * Map a browser KeyboardEvent to DOOM and queue it. Returns false when the key is not mapped
         * (the caller then leaves the event alone) — including F5 and F12, which stay with the browser.
         */
        handleKeyboardEvent(ev, isDown) {
            const code = mapKeyboardEvent(ev);
            if (code === null) {
                return false;
            }
            if (isDown) {
                engine.keyDown(code);
            } else {
                engine.keyUp(code);
            }
            return true;
        },

        /** Subscribe to "frame" | "kill" | "state" | "levelchange". Returns an unsubscribe function. */
        on(event, cb) {
            if (typeof cb !== "function") {
                throw new TypeError("doomEngine.on(event, cb): cb must be a function");
            }
            let set = listeners.get(event);
            if (!set) {
                throttledLog("warn", `unknown event "${event}" (known: ${EVENT_NAMES.join(", ")})`);
                set = new Set();
                listeners.set(event, set);
            }
            set.add(cb);
            return () => {
                set.delete(cb);
            };
        },

        /** Seconds elapsed since the first drawn frame (0 before that). */
        secondsSinceStart() {
            if (firstFrameAt === null) {
                return 0;
            }
            return Math.max(0, (now() - firstFrameAt) / 1000);
        },
    };

    return engine;
}

export const doomEngine = createDoomEngine();
