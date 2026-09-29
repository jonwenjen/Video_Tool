# Known issues

Written at the end of the 2026-09-29 session so the next one can start from facts
rather than re-deriving them. Everything here is stated with how it was observed.
Where something is suspected rather than proven, it says so.

The suite is green: 157 checks across 7 scripts, `tsc --noEmit` clean. Every item
below is a case the suite does **not** cover. That is the point of this file.

---

## 1. The render output latches. Highest priority, not fixed.

**Symptom.** A grade change takes effect once, then the picture stops responding
to further changes — including reverting to the value it started at. Only a page
reload clears it. A seek does not.

**Observed, on a long-running tab:**

```
exposure 0     scopes [0.1475, 0.2384, 0.1689]   export 10,656,873 bytes
exposure 1.5   scopes [0.2573, 0.3974, 0.2903]   export 11,869,842 bytes   <- changed
exposure 0     scopes [0.2573, 0.3974, 0.2903]   export 11,869,842 bytes   <- did not revert
```

On a freshly reloaded tab the same sequence sometimes changes nothing at all,
including the first edit. `scopes`, `read_pixel` and `export_frame` all agree with
each other and disagree with what the operator sees on screen.

**Why this matters more than its size.** Most of what follows in this file is
either this bug or an artefact of mistaking it for something else. Four separate
conclusions in this session were wrong because of it — see the trap at the end.

**Where to look.** `grabPixels` in `src/agent/client.ts` prefers
`pipeline.readPixels`, which reads the pipeline's own display framebuffer. The
viewer canvas is composited through the default framebuffer. Those are different
attachments. The most likely place for the fault is the framebuffer binding and
any attachment-swap inside `ColorPipeline.render` in `src/gpu/pipeline.ts` —
not yet read in this session.

**How to reproduce.**

```
POST /rpc {"command":"set_playhead","params":{"frame":30}}
POST /rpc {"command":"get_scopes"}                              # record
POST /rpc {"command":"set_node_param","params":{"path":"primary.exposure","value":1.5}}
POST /rpc {"command":"get_scopes"}                              # should change
POST /rpc {"command":"set_node_param","params":{"path":"primary.exposure","value":0}}
POST /rpc {"command":"get_scopes"}                              # should return to the first value
```

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

Do not trust `underwater-grade.mjs` as evidence about the app until it is
reconciled with the real pipeline, or replaced by a measurement taken from the
pipeline itself.

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
