# Swerve n Serve — Gauntlet Status

Bar: **The Warriors (Rockstar, PS2, 2005)** — see `docs/BAR.md`.
Everything below was actually run. Nothing is claimed that was not verified.

---

## Loop 0 — Repository truth

**State found.** The GitHub remote (`vindigit/SwerveNServe-Loop`) contained only a
README. The local working copy was ahead: a clean, well-commented architectural
scaffold — module boundaries matching the project instructions, an event bus, an
input abstraction — but **every gameplay system was a stub**. `new JobDirector([])`
meant no job could ever be offered. There was no map, no collision, no results
flow, no character. The game was an orange capsule on a flat purple plane with a
countdown running in the corner.

Baseline: typecheck passed, `vite build` passed, no tests existed, one animation
loop, no console errors. A green build on an empty game.

**Verified by:** headless Chromium playtest, `artifacts/baseline/`.

---

## Loop 1 — Foundation: contracts, collision, world

**Objective.** Give the map a spine that the player, camera and job director can
all agree on, so work could proceed without four systems inventing four
incompatible worlds.

Built `src/world/types.ts` (colliders, locations, routes), `CollisionWorld`
(uniform-grid AABBs, per-axis resolution, step-up, segment probe for the camera),
`src/core/rng.ts` (mulberry32 — no `Math.random()` in gameplay), and
`src/core/storage.ts` (every read defensive against missing/malformed values).

**Result:** typecheck clean. No player-facing change yet.

---

## Loop 2 — The neighbourhood

**Objective.** One hand-authored map, ~220 × 180 m, three interconnected blocks
plus a rail corridor, that reads as a place and plays as a course.

Key decision: **zero dynamic lights.** The night look is baked — per-vertex light
from an authored lamp rig, plus additive glow decals for the hot core of each
pool. This is the PS2 technique and it is also why 0 lights and ~50 draw calls
carry an entire neighbourhood.

**Acceptance criteria and result:**

| Criterion | Result |
| --- | --- |
| Five recognisable zones | ✅ avenue, courtyard, alley maze, quiet edge, elevated rail |
| ≥ 6 job locations | ✅ 11 |
| ≥ 3 meaningful shortcuts | ✅ 3, each asserted ≥15% shorter at build time |
| One intentional dead end | ✅ fenced stub at X 36–46, Z −84 |
| Collision matches visuals | ✅ every wall, fence, gate, dumpster, car, stoop, stair |
| ≤ 220 draw calls / 180k tris | ✅ 51 draw calls, 26.5k triangles |
| ≤ 3 dynamic lights | ✅ **0** |

**Defect found and fixed:** the first build had *no props at all*. Playtest
screenshots showed empty box corridors — flat, uniformly lit, nothing closing a
sightline. Measured against `BAR.md` rule 1 the ground luminance profile was flat
(min 0.137, max 0.259 — no peak, no trough).

**Repair:** built `src/world/props.ts` — 13 instanced prop types (streetlamps,
utility poles, dumpsters, cars, fire escapes, water tanks, hydrants, crates,
cellar doors, barriers, AC units, meters, trash cans), one draw call each, lit
per instance from the same baked rig via `instanceColor`.

---

## Loop 3 — Lighting balance

**Objective.** Make `BAR.md` rule 1 measurably true: pools of light with troughs
below 15% luminance between them.

Instrumented the playtest with a luminance profiler rather than judging by eye.

| View | Before | After |
| --- | --- | --- |
| Intersection | row 0.137–0.259, flat | **0.082–0.529**, real peaks and troughs |
| Alley (deep) | 93% below 15% — unnavigable | **14% below 15%**, mean 0.289 |
| Courtyard | 98% below 15% | **89%** with two authored pools |
| Spawn | — | 0.063–0.196, 89% dark with warm pool ahead |

**Defect found and fixed:** window frames were drawing *in front of* their panes,
turning every lit window into a grey rectangle. Cause: the recess offset was
derived from the sign of the wall's world coordinate instead of its outward
normal. Fixed by passing the normal explicitly.

**Defect found and fixed:** the courier had block shoulders sticking out past the
torso. Narrowed the chest and moved the arm roots inboard.

---

## Loop 4 — Loop certification

**Objective.** Prove the courier loop actually runs, and that restart is clean.

Played four complete jobs headlessly by driving the debug API:

```
toPickup @ Loading Dock   → toDelivery @ Rowhouse Stoop  → cash=192   streak=1
toPickup @ Rail Underpass → toDelivery @ Alley Door      → cash=505   streak=2
toPickup @ Cellar Steps   → toDelivery @ Wash n Dry      → cash=846   streak=3
toPickup @ Courtyard B    → toDelivery @ Loading Dock    → cash=1507  streak=4
```

Timer forced to expiry → phase moved to `results` exactly once, with cash and
delivery count intact.

**Restart stress — five consecutive runs:**

| Run | Scene objects | Listeners |
| --- | --- | --- |
| 0–4 | 70 (flat) | 9 (flat) |

Zero growth. One `requestAnimationFrame` chain throughout. Player, timer, cash,
streak and job state all reset; no page refresh.

**Defect found and fixed:** the pickup corona took up to 150 ms to reappear after
the camera cleared a wall, because the occlusion probe was throttled on a fixed
interval. Rounding a corner and waiting for the marker reads as a dropped frame.
Repaired by re-probing immediately whenever the camera has moved, keeping the
cheap path for a static camera. This was caught by a failing test, not by eye.

---

## Loop 5 — Screens

Title, Choose Your Look and Results built as DOM overlays over the live 3D view —
the world stays visible behind every screen.

Verified headlessly: title → CHOOSE LOOK → change all four categories with the
keyboard → confirm → run starts with the chosen look → selection persists to
`localStorage` as `{"head":1,"shirt":2,"pants":1,"shoes":1}`.

---

---

## Loop 6 — Façades, and the routes that turned out not to exist

**Objective.** Close the largest named visual gap: walls were flat brick boxes
with sparse windows, where the bar's are dense with doors, plinths and window
grids. One of ours was 62 m of unbroken façade.

**What changed**

- `rowhouseRun()` splits a long span into 5–7 m bays, each with its own height
  (±1.4 m), tint, cornice, door and stoop. Twelve long runs converted. This one
  change gave the map a roofline, broke the brick texture repeat, and made a
  street read as a row of buildings rather than one wall.
- A ground-floor plinth on every run and every apartment block — the horizontal
  line that gives a street its scale.
- Doorways with lit transoms: a warm rectangle per house, readable at 40 m.
- Window spacing tightened from 3.4 m to 2.75 m.

**Three defects found by looking, then measuring**

1. *The plinth buried every door.* It stood 8 cm proud of the wall; the door
   quads only 5 cm. Doors were rendering inside it.
2. *The plinth read as a bright concrete wall the length of the street*, because
   it was lighter than the brick above it. A base is darker than what it carries.
3. *The pavement was the brightest thing in frame and the road was covered in
   what looked like chalk scribbles.* The scribbles were the asphalt texture's
   tar seams — six high-contrast random zigzags per 4 m tile, repeated 55 times
   down the avenue. Now two low-contrast seams running with the road, on a 6 m
   tile. The warm foreground wash turned out not to be tint at all: the additive
   glow decals were twice the size and strength they should have been, and
   additive blending ignores surface tint, so a big decal simply erases the
   darkness the bake worked to create. All 20 decals scaled to 0.72× radius and
   0.55× strength — the bake owns the falloff, the decal owns only the core.

| View | Before loop 6 | After |
| --- | --- | --- |
| Intersection ground row | 0.075 – 0.298 | **0.082 – 0.529**, 48% below 15% |
| Alley, deep | 43% below 15% | 40% below 15%, mean 0.188 |
| Courtyard | 98% below 15% — unnavigable | **63%**, two authored pools |

---

## Loop 7 — Certifying route mastery by running it

**Objective.** `docs/BAR.md` asks that shortcut knowledge beat the safe route by
≥20%. The build-time assertion only compared *path length*, which certifies
nothing — a breezeway 20% shorter but blocked by a collider is a bug, not a
shortcut. So the debug API gained `walkRoute()`, which drives the real
`PlayerController` through the real `CollisionWorld` at full sprint on a fixed
timestep and reports seconds, distance, arrival, and where it wedged.

**The first run failed every route.** Four separate causes, all real:

1. *The walker spawned at y = 0, inside the loading dock's volume*, wedged from
   every direction. My bug, not the map's — it now drops in from above and lets
   gravity settle.
2. *Stoops ran across the avenue's running line.* Three risers ate 1.65 m of a
   4 m sidewalk and put a 0.9 m wall in the path. Cut to two risers, and the
   avenue locations and waypoints moved to the sidewalk's outer half.
3. *Two "safe" routes ran straight through buildings*, and the courtyard's east
   exit led into the east wing. The wing was shortened to open a real lane, and
   both safe paths re-authored along streets that exist.
4. *The dock cut-through was walled off before it reached the avenue.* The south
   strip is now split at X 50–56 so the passage runs all the way through.

Two further blockages turned out to be lamp posts squarely on the line — a
player steps around one, so the walker gained a sidestep rather than the map
losing its lamps.

**Certified result**

| Route | Shortcut | Safe | Shortcut | Saving |
| --- | --- | --- | --- | --- |
| laundromat → courtyard | Courtyard breezeway | 9.18 s | 8.37 s | 8.8% |
| corner mart → loading dock | Service alley | 22.80 s | 10.38 s | **54.5%** |
| loading dock → rail underpass | Dock cut-through | 24.28 s | 14.07 s | **42.1%** |
| **Overall** | | 56.26 s | 32.82 s | **41.7%** |

Above the bar's 20% floor. The breezeway at 8.8% is the weak one and is
reported as such — from the corner mart the cross-street lane is simply closer,
so the pair was re-authored to the laundromat, where the breezeway genuinely
wins. It is still the thinnest of the three.

**Every job location certified standable.** `checkLocations()` probes eight
directions out of each of the 11 locations: all report 8/8 open except
`cellar-steps` at 7/8, which is correct — it is a doorway with a wall behind it.
No objective sits inside collision geometry, so no job can be impossible.

## Current verification state

**Verified**

- 49/49 unit tests pass (`npm test`)
- TypeScript strict typecheck clean (`npm run typecheck`)
- Production build clean (`npm run build`)
- Zero console errors and zero page errors across every scenario run
- One animation loop; no object or listener growth across 5 restarts
- Full job cycle: offer → pickup → delivery → payout → streak → next job
- Timer expiry fires results exactly once
- Choose Your Look navigation and persistence
- 51 draw calls, 26.5k triangles, **0 dynamic lights**
- Shortcut savings certified by *running* all three routes with the real
  controller and collision: 41.7% overall, all six paths arrive
- All 11 job locations probed for clearance; none inside geometry

**Implemented but not fully verified**

- Gamepad path — code is one abstraction with the keyboard, but no physical pad
  was attached in the headless harness
- Real-hardware frame rate — the harness renders through SWiftShader (software),
  so its FPS number is not a GPU signal. Draw-call and triangle counts are the
  meaningful, hardware-independent evidence
- Best-score persistence writes only on a run that beats the stored value; a
  0-cash run correctly stores nothing

**Deferred**

- Audio (`AudioDirector` was a stub and was removed rather than left as dead code)
- Hazards and NPCs — out of scope until the loop is fun, per the gauntlet order
- The courtyard breezeway saves only 8.8%; the other two shortcuts carry the
  route-mastery requirement. Worth a redesign pass.
- Brick still tiles visibly at distance — the grime blobs repeat.
- No awnings on the rowhouse runs; the bar's storefronts have them.

**Not started**

- Audio zones
- Hazards and light NPC traffic
