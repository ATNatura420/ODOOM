# doom.wasm — provenance and licence notice

`doom.wasm` (6,843,809 bytes) in this directory is a WebAssembly build of **DOOM** used by the
`odoom` module as a local-only demo ("DOOM inside Odoo spreadsheets"). It is a third-party
binary; nothing in it was written by Natura. Do not redistribute this module outside the local demo
without reviewing the licences below.

## What is inside the binary

| Component | Origin | Licence |
| --- | --- | --- |
| DOOM engine (linuxdoom-1.10) | id Software, `https://github.com/id-Software/DOOM` (1997 source release) | GNU GPL v2 |
| Rust/wasm glue (`I_*` video, input queue, time, libc shims), musl-1.2.2 pieces, clang compiler-rt | Lars Hupel / Cornelius Diekmann, **wasm-fizzbuzz** "doom" chapter, `https://github.com/diekmann/wasm-fizzbuzz/tree/main/doom` (built without Emscripten; `wasm-opt -O3`) | GPL v2 for the DOOM-derived parts; musl MIT; compiler-rt Apache-2.0 WITH LLVM-exception |
| `doom1.wad` (shareware IWAD, Episode 1 "Knee-Deep in the Dead", 9 maps) | id Software shareware release, **embedded in the wasm data segment** (the engine reads it from memory, no network fetch) | id Software shareware licence: free to copy and distribute unmodified, NOT to sell; not GPL |

The binary is byte-identical to the `doom.wasm` published by the wasm-fizzbuzz project and the
`IWAD` header of the embedded shareware WAD is present inside it. The engine takes no `-iwad`
argument: `main()` is called with `argv = ["linuxxdoom"]` and loads the embedded shareware data.

The separate `DOOM1.WAD` that ships with the source of the earlier "DOOM-in-excel" experiment
(`md5 f0cefca49926d00903cf57551d901abe`, 4,196,020 bytes, 1,264 lumps, maps E1M1–E1M9 only) is the
**same shareware v1.9 IWAD**. It is not read by this module; it is listed here only because it is
the WAD the project started from.

## Wasm interface (for maintainers)

- Imports: `js.js_milliseconds_since_start() -> i32`, `js.js_console_log(ptr, len)`, `js.js_stdout(ptr, len)`,
  `js.js_stderr(ptr, len)`, `js.js_draw_screen(ptr)`; `env.memory` (`WebAssembly.Memory({ initial: 108 })`).
- Exports used: `main()`, `doom_loop_step()`, `add_browser_event(type, doomKeyCode)` (0 = down, 1 = up).
- `js_draw_screen` hands over a 640x400 RGBA framebuffer (320x200 doubled, alpha 255) once per frame.

## Licence obligations honoured here

- GPL v2 (engine + glue): the corresponding source is publicly available at the wasm-fizzbuzz
  repository above (it vendors `linuxdoom-1.10`, `musl-1.2.2`, `clang_compiler_rt` and the Rust
  `src/`). This module ships only the binary and links to that source; it makes no changes to it.
- Shareware WAD: distributed unmodified inside the binary and never sold; this module is not a
  commercial product and the demo is not offered for a fee.
- DOOM is a registered trademark of id Software LLC / ZeniMax Media. Natura is not affiliated with
  id Software, ZeniMax, Bethesda or the wasm-fizzbuzz authors.
