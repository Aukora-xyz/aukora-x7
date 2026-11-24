# The living Pentora in Auma Live: a display of flow

What it is: the Pentora drawn behind Auma Live's voice field, with every one of its cells visible and each cell in
one of three colours at every instant. Source: `apps/web/scripts/stock-apps/pentora-live/` (lattice, flow, packets,
renderer), built into `apps/web/public/app/aura-trace.js` and `aura-trace.css` by
`node apps/web/scripts/stock-apps/build-auma-live-modules.mjs`. A test rebuilds them and compares bytes, so the page
can never again show a stale build.

## What it is NOT

Not health. Not a fingerprint. Not proof or authorization of anything. A cell's health is undetermined on x6.1 and is
never drawn here; no colour here means healthy, and red is never used. Every colour on screen comes from three live
levels Auma Live already has and from where a cell sits in its cube. Nothing else feeds it.

## The numbers (all derived from `spatial/aura/tables.ts`, never copied by hand)

- 5 concentric cubes. Each is a 3 x 3 x 3 lattice: 8 corners, 12 edge midpoints, 6 face centres and the centre point.
- The centre (point 55) is shared by all five cubes. It is the heart: drawn as one soft orb, with no value.
- 26 cells per cube; each of the 20 corners belongs to exactly two cubes; 20 + 60 + 30 = 110 cells in all.
  So in one cube a person can count 27 positions: 8 + 12 + 6 + the heart.
- 270 lines: 120 edge half-segments (each of the 60 edges through its midpoint cell), 120 face crosses (each face
  centre to the 4 midpoints of its own face) and 30 spokes (each face centre to the heart).

## The three colours: the breath of the conversation

| Value | Name | Colour (page token) | Meaning |
|---|---|---|---|
| -1 | IN | green (`--hue-l`) | your voice arriving |
| 0 | HOLD | blue (`--hue-c`) | her thinking, and rest |
| +1 | OUT | purple (`--hue-r`) | her voice leaving |

These are Auma Live's own meanings for its own three colours (green you, blue thinking, purple her).

## The exact function (`flow.mjs`)

Inputs, each 0 to 1, read every frame from Auma Live: `mic` (your voice level), `think` (her working state), `say`
(her voice level). A short history (1.5 s) of each is kept. For a cell on shell d (corner 0, edge midpoint 1, face
centre 2; the heart would be 3) of cube k, at time t, with T = 110 ms, P = 35 ms, REACH = 0.8, HOLD_FLOOR = 0.1:

    in(d, k, t)   = mic(t - d*T - k*P)     * REACH^d
    out(d, k, t)  = say(t - (3-d)*T - k*P) * REACH^(2-d)
    hold(d, k, t) = HOLD_FLOOR + think(t)

P is the cube phase: the five cubes hear the same breath one after another, 35 ms apart, so a wave runs through them
in sequence instead of striking all five at once (the cubes talk). A corner belongs to two cubes and takes the earlier
of the two. Cube 0 keeps the single-cube timings exactly; cube k is exactly k*P later. Her thinking (HOLD) does not
travel: it is the same in every cube at the same instant.

The candidate is the largest of the three (ties keep HOLD, then OUT). A cell changes only when the candidate leads the
cell's current value by more than 0.06 on two consecutive frames, so it never flickers. Before the history begins a
level reads as 0. The function is pure and deterministic.

So: silence is a calm blue lattice. When you speak, green fills from the outside in, cube after cube, and the louder
you are the deeper it reaches. When she speaks, purple blooms from the heart outward, cube after cube. When you speak over her, the outer shells turn
green while the inner ones are still purple, and the front between them is visible.

## Light that travels (`packets.mjs`)

A cell that changes value flares and sends a packet of its new colour along each of its lines toward the next shell:
inward for green, outward for purple. A purple packet that reaches a corner crosses, once, into the other cube that
shares that corner. While `think` is above 0.4, blue packets circulate slowly round each cube's edges. A line between a
green and a purple cell carries both colours and shimmers. At most 220 packets live at once (the oldest is recycled)
and at most two on any one line (a third is not sent; a blue one that would step onto a full line fades).

## Drawing (`renderer.mjs`)

One canvas, a 2D context, additive light and pre-rendered glow sprites; no React, no WebGL. The projection, lean, roll
and breath are the old figure's (`PentoraFigure.tsx`); the turn quickens with `think`. Device pixel ratio is capped at
2. The canvas holds only the figure and its glow: a square 1.25 times the figure's side, centred exactly where the
figure sits, never more than 1,024 CSS px a side (so at most 2,048 backing pixels a side; about 4.8 MB at the usual
550 px, where a full-field canvas on a large Retina screen was about 59 MB).

Sizes: at equal depth a corner's core is the largest (1.9 view units), an edge midpoint's medium (1.55), a face
centre's small (1.3); nearer is larger. Each frame draws, in order: the light (cell glows, the heart, every line once,
the packet heads; all additive), then the cells (corner rings and every core) painted over the light, so each value
stays crisp in its own colour while light travels; a core grows by a fifth while a line touching it carries light.
The shell's Aura Coherence page (`PentoraFigure.tsx`) draws the same 110 cells at the same three sizes plus a hollow
ring at the centre. There the RING of a dot shows its cell's health (undetermined, verified, failed) and the CORE shows these
three colours, fed by the shown Session through the same rule (`aura/flow.ts`); flow is never health.

The light bound: additive light that piles up turns white and loses its hue. No channel of the three colours can
saturate while the summed alpha at a point stays at or below 1. A line that carries light is drawn once, in that
light's colour, at alpha 0.28 (never stacked on its hairline), and every packet head is dimmed or skipped so that the
additive light of the whole frame at its position stays at or below 0.92. A test plays the scripted interruption and
checks every packet head drawn against the bound of 1. It pauses while the page is hidden or the surface is not active. Under reduced motion it draws one still frame each
time a value changes: no packets, no turn, and no cube phase (the five cubes change together, so one onset is at most
three still frames and never a run of them). No words are drawn on the surface.
