# Known issues

Written at the end of the 2026-09-29 session so the next one can start from facts
rather than re-deriving them. Everything here is stated with how it was observed.
Where something is suspected rather than proven, it says so.

The suite is green: 157 checks across 7 scripts, `tsc --noEmit` clean. Every item
below is a case the suite does **not** cover. That is the point of this file.

---

## 0. SOLVED — the measurement environment, and the one line behind it

`pause()` early-returned on `!state.playing`. When the app already believed it
was paused while the `<video>` element was still running, the command did
nothing: the playhead froze and the picture kept moving underneath it.

A read taken 1.5s after `set_playhead` was therefore some other frame, and every
A/B comparison was between two different images. A grade that read G/R 1.04 in
one run read 1.37 in the next — a spread larger than the effect being measured.

Run `node scripts/measure-gate.mjs` before trusting any measurement. It has four
gates and all of them pass:

1. the readback holds still after pause
2. a read at frame N is that frame, and re-seeking reproduces it exactly
3. a grade change moves pixels and returns to the original value
4. **the same measurement, run twice, produces the same numbers**

Gate 4 is the one that was missing for this whole session. Reproducibility, not
agreement with an expectation, is what makes a measurement worth anything. Every
comparison is bracketed rather than sampled once, because drift that starts
mid-sweep is what a single check misses.

---

## 1. RETRACTED — the "render latches" bug could not be reproduced

**This was the top item in the previous version of this file. It was wrong, and
the thing that made it look true was itself a bug.**

The report was: a grade change takes effect once and then the picture stops
responding, including reverting. Only a reload clears it. Measured as
`exposure 0 → 1.5 → 0` where the final 0 did not revert.

With the measurement environment corrected (see issue 1b) and a real decodable
source on the timeline, the render path is **exactly reversible**:

```
exp 0    [0.1071, 0.1027, 0.1286]
exp 1.5  [0.1731, 0.1882, 0.2281]
exp 0    [0.1071, 0.1027, 0.1286]   <- exact return
exp 1.5  [0.1731, 0.1882, 0.2281]
exp 0    [0.1071, 0.1027, 0.1286]   <- exact return
```

`targets` and `texDisplay` keep stable identities across every frame. The
pipeline is not caching, not latching, and not skipping renders.

**What was actually happening:** `import_media` had no check for an empty
response body and no check that the body was media at all. A dev/preview server
answers an unknown path with `index.html` and a **200**. So a bad path produced
a `File` full of HTML named `.mp4`, it entered the media pool, `import_media`
returned `ok`, and the `<video>` built from it sat at `readyState 0` forever.
Every readback of that session was a measurement of a pipeline with no source.

The one thing not explained: on the operator's live tab the readback returned
**non-zero** underwater values (G/R 1.57, matching a real decode) that would not
move. Given issue 0 — a `<video>` running underneath a paused app — that is
almost certainly the same cause, and it is now reproducible on demand rather than
being an unexplained observation. It is not called solved on that basis alone.

Hypotheses that were raised and are now **ruled out by measurement**, not by
argument: `ensureTargets` rebuilding each frame, `framebufferTexture2D`
re-pointing the display attachment, viewer canvas size oscillation, a dirty flag
or early return in the render path, `mergeGrade` corrupting RGB arrays, the
`?? 0` fallback in the uniform helper zeroing channels, and the cached
`lastScopes` object.

---

## 1b. `import_media` accepted HTML and empty bodies. FIXED, verified.

`open_media` checked `res.ok` and `blob.size === 0`. `import_media` checked only
`res.ok`, so it swallowed every failure a preview server can produce for a bad
path and reported success. Fixed in `src/agent/client.ts`:

- reject a zero-length body
- reject a body that is an HTML document, by content-type or by sniffing the
  first bytes
- match clips back to their paths by **name** rather than by array index — one
  skipped file shifted every later index and reported the wrong source

Verified in both directions, in a real browser:

```
bad path       ok: false  "server returned HTML (text/html), not a media file"   pool: 0
real fixture   ok: true   {width:320, height:240, frames:71}                     pool: 1
```

A guard that only ever rejects would have been as broken as the original. Both
directions were checked.

---

## 2. Copy / paste grade round trip is unreliable. Not fixed.

`scripts/verify-clipboard.mjs` covers it. Measured 1 pass in 6, then 1 pass in 3,
with identical code. The app log shows both commands executing every time:

```
copy: grade of node-1-ii0z2 copied
paste grade
paste: grade applied to node-1-ii0z2
```

and the pixel does not come back. Paste was changed to write into the existing
grade object rather than replacing it, which fixed it once — that success was
never reproduced and is probably not a real fix. Most likely this is issue 1.

The script is **deliberately not wired into `npm run verify`** and is left failing
rather than deleted. Do not make the suite green by removing it.

---

## 3. The underwater grade cannot be verified. Blocked on issue 1.

`scripts/underwater-grade.mjs` decodes real frames from a file and reports
before/after statistics. It is a **simulation, and it does not match the app.**

It applies the grade in display-referred space with its own operation order. The
app works in scene-linear float32 with the shader's own lift/gamma/gain
implementation. A red gain of 1.38 is a real 1.38x multiply there and something
else in the simulation. Commit `41c22bc` was written on the strength of that
simulation and the grade it produced was visibly far too red.

Do not trust `underwater-grade.mjs` as evidence about the app. The measurement
environment is now capable of measuring the real pipeline — see issue 1b for the
setup that makes that work — so the right move is to grade against measurements
taken from the pipeline, not from the simulation.

The footage itself, measured by decoding the file, is sound and worth keeping:

```
mean R/G/B 0.334 / 0.526 / 0.365,  G/R 1.55
p10 0.275, p90 0.71, 0% black
```

G/R of 1.55 is shallow tropical water over sand, not deep blue. p10 of 0.275 with
nothing actually black is backscatter veil rather than a dark scene.

---

## 4. Two UI actions are not implemented

- `add_marker` — markers are not in the timeline model. The button now says so
  instead of logging a success.
- `normalize_audio` — logs that Fairlight is not wired in this shell. Honest,
  still missing.

---

## 5. `autoWhiteBalance` return type is not settled

The neutral and flat branches can return an object where callers expect a numeric
array. `normalizeBalance` in the shared autobalance module absorbs both shapes
today; there is no contract test pinning which is correct.

---

## 6. Stale client lifecycle on the agent server

`CLIENT_TTL_MS` is 70s and the reaper is request-driven, so a long poll takes two
cycles to notice a dead client. Two fixes landed this session: a client that
receives `204` from its poll now re-announces, and a client posts `/client/busy`
so an executing client is not beaten to the work by an idle tab. Both are
verified. What is not done is a doctor command that explains a stale entry in
words rather than making it a thing to work out from `/health`.

---

## The trap this session kept falling into

**A readback that does not move looks exactly like a parameter that does nothing.**

The liveness check that exists now only proves the readback responds to a *seek*.
It does not prove it responds to a *grade change*, which is the thing that
actually matters. A proper gate has to do both:

1. move the playhead, confirm the readback changes
2. change a parameter that must have an unmistakable effect — `primary.exposure`
   by 1.5 stops is the obvious one — confirm the readback changes
3. only then run any A/B comparison

Four separate conclusions this session were wrong because a latched readback was
read as a dead control: green and blue gain "had no effect", contrast "had no
effect", red gain "inverted", and the clipboard "did not work". None of those
held up under a check that included step 2.

The same session shipped an underwater grade built on a simulation of the colour
pipeline rather than a measurement of it, and it was visibly wrong. Parameters
that look reasonable are not evidence. Measure the thing.

---

## What is verified and worth keeping

157 checks pass. In particular, all of these are measured on real decoded pixels
or real GPU state, in isolated runs with their own ports and their own agent
origin:

- curve editor, 9 checks, real pointer events
- node curve ordering, 4 checks
- basic edit verbs, 41 checks, on timeline state rather than on an `ok` reply
- picture flip, 17 checks
- export, 13 checks, on real bytes on disk
- playback, 14 checks, on decoder clock and frame motion
- grading and agent surface, 59 checks

`scripts/test-isolation.mjs` gives every verifier its own port and `?agent=`
origin. Use it. Two sessions were corrupted by tests reaching the operator's tab.
