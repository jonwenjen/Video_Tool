# hermes-resolve

A Resolve-style colour grading application that runs in the browser and is
driven by the Hermes agent over a local RPC bridge.

The point of the project is the second half: every control a colourist uses is
reachable as a command, so an agent can perform a real grading session —
import, balance, shape, isolate with a keyer, inspect with scopes, and render —
without a human moving a single control.

> **Read [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) before trusting anything here.**
> The top item in it is a retraction: a "the render latches" bug that turned out
> to be a broken measurement, not a broken renderer. The underwater grading work
> is not finished, and the script that produced the first attempt simulates the
> colour pipeline rather than measuring it.

## Running it

```bash
npm install
npm run dev          # http://127.0.0.1:5178
```

For the agent to reach it, the bridge and the app must both be up:

```bash
npm run agent        # local RPC server on 127.0.0.1:7801
npm run dev          # the app, which registers itself on load
```

Then from Hermes:

```bash
curl -s localhost:7801/health
curl -s localhost:7801/rpc -H 'content-type: application/json' \
  -d '{"id":"1","command":"get_scopes"}'
```

**Use `127.0.0.1`, not `localhost`.** WebCodecs is gated on
`window.isSecureContext`, and on this machine `http://localhost:PORT` reports
`false` while `http://127.0.0.1:PORT` reports `true`. A localhost binding
leaves the whole encode path silently absent.

## Verifying it

```bash
npm test        # 46 numeric tests: colour science + CPU grade engine
npm run verify  # boots the built app in headless Chrome, asserts on real pixels
```

`npm run verify` is the one that matters. It drives the app through the agent
API and asserts on the rendered frame, not on a UI state. It checks that a
default grade is a bit-exact no-op, that each of nineteen grade controls
actually moves pixels when measured from a pristine baseline, that
`gl.getError()` is empty, and that a pixel probe returns a real colour.

## What is actually implemented

**Colour pipeline** — WebGL2, 32-bit float ping-pong (`RGBA32F` with a
documented `RGBA16F`/`RGBA8` fallback surfaced in the status bar). Nothing is
clamped inside the chain; only the final output transform clamps. Node graph
with serial and parallel nodes, per-node keyframes, and every stage an exact
identity at its default.

Per node: lift/gamma/gain wheels, offset, contrast with pivot and low/high
split, brightness, shadows/midtones/highlights, colour boost, temperature/tint,
hue, saturation, vibrance, per-channel and master curves, ASC CDL, HSL
qualifier, chroma key, 2D power window (ellipse/rectangle/linear with softness,
feather, invert, mix), 3D LUT, blur, unsharp, glow, vignette, film grain, and
a filmic contrast curve.

**CPU engine** (`src/color/cpugrade.ts`) — the same stage order in TypeScript,
for headless verification, auto-balance, and stills. The null case is the
reason it exists: a colour pipeline that shifts pixels at its defaults makes
every downstream measurement relative to a silently-wrong baseline.

**Agent bridge** — a local HTTP server, a browser client that resolves the app
through `window.__resolve`, and commands for media, the node graph, grades,
keyframes, analysis, and export. Errors are returned as structured
`CommandError`s, never thrown into the socket.

## Layout

```
src/core/     types, colour science, identity defaults
src/color/    CPU grade engine (reference implementation)
src/gpu/      shaders and the WebGL2 pipeline
src/agent/    protocol and the browser-side bridge
src/ui/       the design system
server/       the local RPC server
test/         numeric tests and generated fixtures
scripts/      cdp.mjs, verify.mjs, matrix derivation and diagnostics
```

## Colour science notes

Three things here are load-bearing and easy to get wrong:

**Only forward matrices are constants.** Every `XYZ -> RGB` matrix is computed
with `mat3Inverse` at module load. The widely-copied AP1 forward/inverse pair
is not mutual inverses (max deviation ~0.25), which tints every neutral pixel
while still producing a plausible image. `scripts/derive-ap1.mts` regenerates
the forward constants from chromaticity primaries and reproduces the published
sRGB matrix to ten decimal places, which is what validates the method.

**Bradford adaptation is required** on every sRGB <-> AP1 crossing. sRGB white
is D65, AP1 white is D60, and skipping the adaptation runs the whole image
~5% warm. The z component of a white point is `1 - x - y`; passing `z = 1.0`
inflates it roughly threefold.

**Hue rotation preserves luma by construction.** It is built as a rotation in
the plane orthogonal to the luma normal, not from remembered YIQ coefficients
that drift and stop matching the weights the scopes actually use.

LogC replaces the "DaVinci Intermediate" constants that circulate in blog
posts, whose encode and decode toe breakpoints disagree and therefore do not
round-trip.

## Known limitations

- Single clip grading is complete; multi-clip timeline compositing is present
  but the Fusion page's node-based compositing is not.
- Video decode is via the browser's `<video>` element, so codec coverage is the
  browser's rather than a bundled demuxer. Export uses WebCodecs with mp4-muxer
  and covers H.264, VP9 and AV1, but the export path is not yet covered by the
  e2e assertions.
- The shared curve LUT is one texture for the whole graph, which looks like a
  per-node bug and is not: it is re-uploaded inside the render loop, once per
  node, before that node draws. Swapping two nodes' curves changes the output —
  asserted in `scripts/verify-node-curves.mjs`.
- Tracking is not implemented. The panel and node kind exist; the solver does
  not.
