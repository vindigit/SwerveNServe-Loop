# Swerve n Serve

Early-PS2-inspired urban courier game — Crazy-Taxi-on-foot. Three.js + TypeScript + Vite.

**PICK UP → CHOOSE A ROUTE → DELIVER → EARN CASH → TAKE THE NEXT JOB**

One 12-minute night in one hand-authored neighbourhood. Score attack on foot.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 49 unit + integration tests
npm run typecheck
npm run build      # production bundle in dist/
npm run preview    # serve the production build
```

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move | WASD / arrows | Left stick |
| Look | Mouse | Right stick |
| Sprint | Shift | Right trigger |
| Jump | Space | A / Cross |
| Interact / accept | E / Enter | A / Cross |
| Back | Esc | B / Circle |
| Menu navigation | WASD / arrows | D-pad / left stick |

## The neighbourhood

~220 × 180 m, three interconnected blocks plus a rail corridor. It is a racing
course disguised as a city block — every wall exists to close a sightline or
create a routing decision.

- **Main Avenue** — four-way intersection, Corner Mart (the map's brightest
  landmark), Wash n Dry, rowhouse frontage, parked cars, streetlamps
- **Apartment Courtyard** — five-storey walk-ups, fire escapes, a breezeway
  through to the avenue, a chain-link gap into the alleys
- **Rowhouse / Service-Alley Maze** — narrow interconnected alleys, a loading
  dock, cellar doors, dumpsters, two deliberate cut-throughs
- **Quiet / Vacant-Lot Edge** — garages, fences, a lonely change of pace
- **Elevated Railway** — the orienting landmark, visible from most of the map

Three shortcuts, each asserted at build time to be at least 15% shorter than the
safe route: the **courtyard breezeway**, the **service alley**, and the **dock
cut-through**. One intentional dead end.

## Architecture

Small typed modules with a lightweight typed event bus. Composition over
inheritance. No ECS, no DI container, no open-world framework.

```
src/
  Game.ts                  Assembly + the ONE animation loop + phase machine
  main.ts                  Bootstrap
  config/gameConfig.ts     Every tunable, typed. No magic numbers in logic.
  core/
    EventBus.ts            Typed pub/sub; reset() drops all listeners
    InputManager.ts        One abstraction over keyboard + standard gamepad
    rng.ts                 Seeded mulberry32 — no Math.random() in gameplay
    storage.ts             Best score + look, defensive against bad values
    types.ts               Cross-module vocabulary (data only)
  modules/
    PlayerController.ts    Capsule movement, frame-rate-independent accel
    ThirdPersonCamera.ts   Follow + obstruction retraction for narrow alleys
    JobDirector.ts         Job pool, seeded selection, lifecycle, triggers
    PickupMarker.ts        Rotating mesh + additive camera-facing corona
    RunTimer.ts / ScoreSystem.ts / StreakSystem.ts / InteractionSystem.ts
  character/Courier.ts     ~2.1k-tri PS2 courier, stepped 12 Hz animation
  ui/HUD.ts, ui/Screens.ts DOM overlays: HUD, title, look select, results
  world/
    types.ts               Collision/location/route contracts
    CollisionWorld.ts      Authored AABBs, per-axis resolution, step-up
    build.ts               Mesh builder + the light bake
    textures.ts            Procedural PS2 textures (<=256px, nearest)
    props.ts               13 instanced prop types
    Neighborhood.ts        The authored map
```

## Rendering

Renders internally at 540p and upscales with nearest-neighbour. Maximum 256×256
textures, nearest filtering, heavy fog, saturated artificial light.

**Zero real-time dynamic lights.** Night is baked: per-vertex light from an
authored lamp rig, plus additive glow decals for the hot core of each pool, plus
emissive window and signage quads. Characters are lit by sampling the same rig
once per frame. That is the PS2 technique, and it is why the whole neighbourhood
costs ~51 draw calls and 26.5k triangles.

## Scoring

```
base   = max(120, distance_m * 1.6) * reach_multiplier   (easy 1.0 / medium 1.25 / risky 1.55)
speed  = base * 0.6 * (1 - clamp01((elapsed - par) / par))
payout = round((base + speed) * streak_multiplier)       (1.0 → 2.5, +0.15 per delivery)
```

Streak breaks if a delivery runs past 2× par. Best score is stored locally.

## Status

See `docs/GAUNTLET_STATUS.md` for what has been verified and what has not, and
`docs/BAR.md` for the visual reference this is built against.
