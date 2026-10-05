// Headless Node probe for odoom/static/src/bundle/doom_engine.js.
//
// Run:  node "odoom/static/tests/node/engine_probe.mjs"
//
// Loads doom.wasm from disk, drives the engine with a fake clock (advances on EVERY read, because
// Doom busy-waits inside doom_loop_step until the clock moves), walks the title -> New Game menu with
// four Enter presses, then asserts that frames were drawn and the player struct was located with the
// expected fresh-game stats (health 100, killcount 0). Prints PASS or FAIL and exits accordingly.
//
// Lives under static/tests (not static/src) so Odoo never bundles it.

import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = resolve(here, "..", "..", "..");
const wasmPath = resolve(moduleRoot, "static", "lib", "doom", "doom.wasm");
const enginePath = resolve(moduleRoot, "static", "src", "bundle", "doom_engine.js");

const { doomEngine, WASM_URL, mapKeyboardEvent, DOOM_KEYS } = await import(pathToFileURL(enginePath).href);

const failures = [];
function check(label, ok, detail) {
    const line = `${ok ? "ok  " : "FAIL"} ${label}${detail !== undefined ? ` (${detail})` : ""}`;
    console.log(line);
    if (!ok) {
        failures.push(label);
    }
}

// Fake clock: +1 ms per read, +30 ms per step (about one Doom tic).
let clock = 0;
const fakeClock = () => ++clock;

const wasmBytes = readFileSync(wasmPath);
console.log(`wasm: ${wasmPath} (${wasmBytes.length} bytes)`);

const stateLog = [];
const offState = doomEngine.on("state", (s) => stateLog.push(s.state));
let frameEvents = 0;
const offFrame = doomEngine.on("frame", () => frameEvents++);
const kills = [];
doomEngine.on("kill", (k) => kills.push(k));
const levelChanges = [];
doomEngine.on("levelchange", (l) => levelChanges.push(l));

const t0 = Date.now();
const p1 = doomEngine.start({ wasmBytes, now: fakeClock, autoLoop: false });
const p2 = doomEngine.start();
check("start() is idempotent (same promise)", p1 === p2);
await p1;
console.log(`main() done in ${Date.now() - t0} ms, state=${doomEngine.state}`);
check("state is running after start", doomEngine.state === "running", doomEngine.state);
check("state events idle->loading->running", stateLog.join(">") === "loading>running", stateLog.join(">"));

const step = (n) => {
    for (let i = 0; i < n; i++) {
        clock += 30;
        doomEngine.step();
    }
};
const press = (code) => {
    doomEngine.keyDown(code);
    step(3);
    doomEngine.keyUp(code);
    step(3);
};

step(70); // title screen
check("frames drawn on the title screen", doomEngine.frameCount > 0, `frameCount=${doomEngine.frameCount}`);
check("player struct NOT found before a game starts", doomEngine.stats.found === false);

// Enter x4: title -> main menu -> New Game -> Episode 1 -> skill (Hurt me plenty) -> E1M1
for (let i = 0; i < 4; i++) {
    press(DOOM_KEYS.ENTER);
    step(20);
}
step(120);

const frameCount = doomEngine.frameCount;
console.log(
    `frames=${frameCount} frameEvents=${frameEvents} secondsSinceStart=${doomEngine.secondsSinceStart().toFixed(2)} ` +
        `stats=${JSON.stringify(doomEngine.stats)} kills=${kills.length} levelchanges=${levelChanges.length}`
);

check("frameCount > 0", frameCount > 0, frameCount);
check("frame events fired once per frame", frameEvents === frameCount, `${frameEvents} vs ${frameCount}`);
check("latestFrame is a Uint8ClampedArray", doomEngine.latestFrame instanceof Uint8ClampedArray);
check("latestFrame length 1024000", doomEngine.latestFrame && doomEngine.latestFrame.length === 1024000);
let nonBlack = 0;
if (doomEngine.latestFrame) {
    const f = doomEngine.latestFrame;
    for (let i = 0; i < f.length; i += 4) {
        if (f[i] | f[i + 1] | f[i + 2]) {
            nonBlack++;
        }
    }
}
check("latestFrame has content", nonBlack > 1000, `${nonBlack} non-black pixels`);
check("latestFrame alpha is 255", doomEngine.latestFrame && doomEngine.latestFrame[3] === 255);
check("frameCanvas is null in Node", doomEngine.frameCanvas === null);
check("stats.found", doomEngine.stats.found === true);
check("stats.health === 100", doomEngine.stats.health === 100, doomEngine.stats.health);
check("stats.armor === 0", doomEngine.stats.armor === 0, doomEngine.stats.armor);
check("stats.bullets === 50", doomEngine.stats.bullets === 50, doomEngine.stats.bullets);
check("stats.killcount === 0", doomEngine.stats.killcount === 0, doomEngine.stats.killcount);
check("stats.totalKills === 0", doomEngine.stats.totalKills === 0);
check("no kill events without kills", kills.length === 0);
check("secondsSinceStart > 0", doomEngine.secondsSinceStart() > 0, doomEngine.secondsSinceStart().toFixed(2));
check("state still running", doomEngine.state === "running" && doomEngine.error === null, doomEngine.state);
check("WASM_URL", WASM_URL === "/odoom/static/lib/doom/doom.wasm", WASM_URL);

// unsubscribe works
offFrame();
const before = frameEvents;
step(5);
check("unsubscribe stops frame events", frameEvents === before);
offState();

// key mapping
const map = (key, code) => mapKeyboardEvent({ key, code });
check("map ArrowLeft", map("ArrowLeft", "ArrowLeft") === 0xac);
check("map ArrowUp", map("ArrowUp", "ArrowUp") === 0xad);
check("map ArrowRight", map("ArrowRight", "ArrowRight") === 0xae);
check("map ArrowDown", map("ArrowDown", "ArrowDown") === 0xaf);
check("map Control -> fire 0x9d", map("Control", "ControlLeft") === 0x9d);
check("map Alt -> strafe 0xb8", map("Alt", "AltLeft") === 0xb8);
check("map Shift -> run 0xb6", map("Shift", "ShiftLeft") === 0xb6);
check("map Enter", map("Enter", "Enter") === 13);
check("map Escape", map("Escape", "Escape") === 27);
check("map Backspace", map("Backspace", "Backspace") === 127);
check("map Tab", map("Tab", "Tab") === 9);
check("map space", map(" ", "Space") === 32);
check("map 'Y' -> 'y'", map("Y", "KeyY") === 121);
check("map 'n'", map("n", "KeyN") === 110);
check("map '3'", map("3", "Digit3") === 51);
check("map Shift+2 ('@', Digit2) -> '2' (weapon while running)", map("@", "Digit2") === 50);
check("map AZERTY '&' (Digit1) -> '1'", map("&", "Digit1") === 49);
check("map non-ASCII 'é' (Digit2) -> '2'", map("é", "Digit2") === 50);
check("map Numpad5 -> '5'", map("5", "Numpad5") === 53);
check("map non-ASCII 'ü' on an unmapped code -> null", map("ü", "BracketLeft") === null);
check("map F1 -> 187", map("F1", "F1") === 187);
check("map F11 -> 215 (doomdef.h)", map("F11", "F11") === 215);
check("F5 unmapped", map("F5", "F5") === null);
check("F12 unmapped", map("F12", "F12") === null);
check("Meta unmapped", map("Meta", "MetaLeft") === null);
check("Dead key falls back to code", map("Dead", "KeyA") === 97);
check("handleKeyboardEvent returns true for mapped", doomEngine.handleKeyboardEvent({ key: "ArrowUp", code: "ArrowUp" }, true) === true);
check("handleKeyboardEvent returns false for F5", doomEngine.handleKeyboardEvent({ key: "F5", code: "F5" }, true) === false);
check("handleKeyboardEvent returns false for F12", doomEngine.handleKeyboardEvent({ key: "F12", code: "F12" }, false) === false);
doomEngine.handleKeyboardEvent({ key: "ArrowUp", code: "ArrowUp" }, false);
step(3);
check("engine survives queued key events", doomEngine.state === "running");

if (failures.length === 0) {
    console.log(`PASS (${frameCount} frames, health ${doomEngine.stats.health}, killcount ${doomEngine.stats.killcount})`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
}
