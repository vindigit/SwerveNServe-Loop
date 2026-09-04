import * as THREE from "three";
import { RenderConfig } from "@/config/gameConfig";
import { MeshBuilder, bake, collider, pathLength, type BakedLamp, type LightRig } from "@/world/build";
import {
  createTextures,
  disposeTextures,
  SIGN_CELL,
  TILE_METRES,
  WINDOW_CELL,
} from "@/world/textures";
import { createProps, type PropKind, type PropPlacement } from "@/world/props";
import type { AuthoredRoute, BoxCollider, NeighborhoodBuild, WorldLocation } from "@/world/types";

/**
 * The neighbourhood. One hand-authored map, ~220 x 180 m, three interconnected
 * blocks plus a rail corridor. It is a racing course wearing a city's clothes:
 * every wall exists to close a sightline or create a routing decision.
 *
 * Structure (looking down, +X east, +Z south):
 *
 *      -110                    -28  -6            80      106
 *   -90 +-----------------------+----+-------------+--------+
 *       |    COURTYARD BLOCK    | X  |  ALLEY MAZE |  RAIL  |
 *       |   (apartment walk-ups)| st |  (rowhouses)| corridor
 *   -11 +--- breezeway ---------+----+--- alley ---+        |
 *     0 |============ MAIN AVENUE =================|        |
 *    11 +-----------------------+----+-------------+        |
 *       |          QUIET / VACANT-LOT EDGE         |        |
 *    84 +------------------------------------------+--------+
 *
 * Nothing here uses a dynamic light. See build.ts for why.
 */

const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------------------ */
/* layout constants — the map's skeleton, in one place                  */
/* ------------------------------------------------------------------ */

const MAP = {
  minX: -110,
  maxX: 110,
  minZ: -90,
  maxZ: 90,
  /** Main avenue: road surface between these Z, sidewalk out to ±11. */
  avenueRoadZ: 7,
  avenueWalkZ: 11,
  /** Cross street: road between these X, sidewalk out to -28 / -6. */
  crossRoadMinX: -24,
  crossRoadMaxX: -10,
  crossWalkMinX: -28,
  crossWalkMaxX: -6,
  /** Rail corridor. */
  railMinX: 80,
  railCentreX: 93,
  railDeckY: 9,
} as const;

/* ------------------------------------------------------------------ */
/* the light rig — authored pools, baked at build time                  */
/* ------------------------------------------------------------------ */

const SODIUM = new THREE.Color(1.0, 0.62, 0.24);
const COBALT = new THREE.Color(0.34, 0.5, 1.0);
const FLUORO = new THREE.Color(0.5, 0.86, 0.42);
const SHOP = new THREE.Color(1.0, 0.82, 0.5);

function lamp(
  x: number,
  z: number,
  y: number,
  color: THREE.Color,
  radius: number,
  intensity: number
): BakedLamp {
  return { x, y, z, color, radius, intensity };
}

function buildLightRig(): LightRig {
  const lamps: BakedLamp[] = [];

  // Main avenue — sodium streetlamps, alternating sides, deliberately sparse so
  // the troughs between pools stay dark. This spacing is the bar's signature.
  for (let x = -96; x <= 72; x += 28) {
    lamps.push(lamp(x, -9.2, 6.4, SODIUM, 14.5, 1.25));
    lamps.push(lamp(x + 14, 9.2, 6.4, SODIUM, 14.5, 1.25));
  }
  // Cross street.
  for (let z = -78; z <= 78; z += 30) lamps.push(lamp(-8.4, z, 6.4, SODIUM, 13.5, 1.1));

  // The corner store is the map's brightest landmark — you can navigate by it.
  lamps.push(lamp(-2, -14, 3.4, SHOP, 15, 1.15));
  lamps.push(lamp(-2, -11.5, 2.2, SHOP, 9, 0.8));
  // Laundromat opposite, cooler and weaker.
  lamps.push(lamp(-30, 13.5, 3.2, FLUORO, 11, 0.7));

  // Courtyard: two wall fixtures, one green doorway. Pools, not floodlight.
  lamps.push(lamp(-78, -34, 4.2, SODIUM, 19, 1.15));
  lamps.push(lamp(-52, -56, 4.2, FLUORO, 18, 1.0));
  lamps.push(lamp(-58, -33, 4.6, SODIUM, 17, 0.95));
  lamps.push(lamp(-80, -62, 4.4, COBALT, 13, 0.6));
  lamps.push(lamp(-65.5, -16, 3.6, COBALT, 12, 0.55)); // breezeway mouth
  lamps.push(lamp(-65.5, -24, 3.6, SODIUM, 11, 0.6)); // breezeway far end

  // Alley maze: security lights, far apart, with real darkness between.
  lamps.push(lamp(19, -36, 4.6, FLUORO, 14, 1.0));
  lamps.push(lamp(19, -47, 4.6, SODIUM, 13, 0.8));
  lamps.push(lamp(19, -58, 4.6, SODIUM, 13, 0.8));
  lamps.push(lamp(48, -60, 4.4, SODIUM, 15, 0.85)); // loading dock
  lamps.push(lamp(53, -40, 4.0, FLUORO, 12, 0.7)); // dock cut-through
  lamps.push(lamp(41, -76, 4.2, COBALT, 12, 0.5)); // dead-end stub, cold and wrong
  lamps.push(lamp(-2, -66, 4.2, SODIUM, 14, 0.75));

  // Quiet edge: barely lit. The pacing change is a lighting change.
  lamps.push(lamp(-70, 44, 5.0, SODIUM, 17, 0.7));
  lamps.push(lamp(-20, 38, 5.6, SODIUM, 16, 0.6));
  lamps.push(lamp(20, 62, 5.0, COBALT, 15, 0.45));

  // Rail corridor: cold light raking down through the deck.
  for (let z = -60; z <= 60; z += 40) lamps.push(lamp(MAP.railCentreX, z, 8.2, COBALT, 22, 0.6));
  lamps.push(lamp(86, 20, 4.2, SODIUM, 14, 0.8)); // underpass drop-off

  return {
    // Never pure black: the sky bounce keeps shadowed ground readable, exactly
    // as the bar's sampled asphalt range requires.
    ambientTop: new THREE.Color(0.058, 0.066, 0.101),
    ambientSide: new THREE.Color(0.038, 0.043, 0.070),
    lamps,
  };
}

/* ------------------------------------------------------------------ */
/* material set                                                         */
/* ------------------------------------------------------------------ */

interface Surfaces {
  asphalt: MeshBuilder;
  pavement: MeshBuilder;
  brick: MeshBuilder;
  concrete: MeshBuilder;
  siding: MeshBuilder;
  metal: MeshBuilder;
  gravel: MeshBuilder;
  /** Unlit atlas quads: windows, doors, storefronts. */
  windows: MeshBuilder;
  /** Unlit atlas quads: awnings, road paint, cornices. */
  signs: MeshBuilder;
  chainLink: MeshBuilder;
  /** Additive glow decals — the hot core of every light pool. */
  glow: MeshBuilder;
}

function litMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map, vertexColors: true, fog: true });
}

/* ------------------------------------------------------------------ */
/* piece builders                                                       */
/* ------------------------------------------------------------------ */

const rep = (metres: number, tile: number) => metres / tile;

/** A façade band of windows across a building face. Unlit = emissive. */
function windowBand(
  s: Surfaces,
  axis: "z" | "x",
  fixed: number,
  from: number,
  to: number,
  y: number,
  h: number,
  seedIn: number,
  litChance: number,
  /** +1 if the face points toward +axis, -1 if toward -axis. */
  outward: 1 | -1
): void {
  const spacing = 2.75;
  const count = Math.max(1, Math.floor((to - from) / spacing));
  const lit = [WINDOW_CELL.dim, WINDOW_CELL.halfLit, WINDOW_CELL.curtain, WINDOW_CELL.tv];
  const dark = [WINDOW_CELL.dark, WINDOW_CELL.blinds, WINDOW_CELL.grimy, WINDOW_CELL.boarded];
  let seed = seedIn;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < count; i++) {
    const centre = from + spacing * (i + 0.5);
    const w = 1.0;
    const isLit = rand() < litChance;
    const cell = (isLit ? lit : dark)[Math.floor(rand() * 4)]();
    // Lit windows glow warm; unlit ones are near-black so the façade reads flat.
    const tint = isLit
      ? new THREE.Color().setHSL(0.09 + rand() * 0.03, 0.62, 0.42 + rand() * 0.16)
      : new THREE.Color(0.1, 0.11, 0.15);
    const opts = { uv: cell, unlit: true, tint };
    // Recessed frame behind each pane. Without it a façade reads as a grid of
    // glowing stickers rather than a wall with holes in it.
    const fw = w + 0.22;
    const frame = { uv: SIGN_CELL.plain(), unlit: true, tint: new THREE.Color(0.07, 0.07, 0.09) };
    const back = -outward * 0.06;
    if (axis === "z") {
      s.signs.addQuad(
        P(centre - fw, y - 0.2, fixed + back),
        P(centre + fw, y - 0.2, fixed + back),
        P(centre + fw, y + h + 0.2, fixed + back),
        P(centre - fw, y + h + 0.2, fixed + back),
        frame
      );
    } else {
      s.signs.addQuad(
        P(fixed + back, y - 0.2, centre + fw),
        P(fixed + back, y - 0.2, centre - fw),
        P(fixed + back, y + h + 0.2, centre - fw),
        P(fixed + back, y + h + 0.2, centre + fw),
        frame
      );
    }
    if (axis === "z") {
      s.windows.addQuad(
        P(centre - w, y, fixed),
        P(centre + w, y, fixed),
        P(centre + w, y + h, fixed),
        P(centre - w, y + h, fixed),
        opts
      );
    } else {
      s.windows.addQuad(
        P(fixed, y, centre + w),
        P(fixed, y, centre - w),
        P(fixed, y + h, centre - w),
        P(fixed, y + h, centre + w),
        opts
      );
    }
  }
}

interface BuildingOptions {
  height: number;
  /** Which face the windows/door go on. */
  front: "north" | "south" | "east" | "west";
  material?: "brick" | "concrete" | "siding";
  floors?: number;
  litChance?: number;
  seed?: number;
  /** Adds a cornice band and a parapet lip. */
  cornice?: boolean;
  /** Per-bay brightness variation so a run of houses is not one flat colour. */
  tintScale?: number;
  /** Lowest window row. Rows below the plinth would sit inside it. */
  windowFloorY?: number;
}

/**
 * One building shell. Boxes with painted detail — no modelled bricks, no
 * interiors, no hidden geometry. The silhouette does the work.
 */
function building(
  s: Surfaces,
  colliders: BoxCollider[],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  options: BuildingOptions
): void {
  const { height, front } = options;
  const mat = options.material ?? "brick";
  const builder = mat === "brick" ? s.brick : mat === "concrete" ? s.concrete : s.siding;
  const tile = mat === "brick" ? TILE_METRES.brick : mat === "concrete" ? TILE_METRES.concrete : TILE_METRES.siding;
  const seed = options.seed ?? (Math.round((minX * 31 + minZ * 17) | 0) || 7);

  const k = options.tintScale ?? 1;
  builder.addBox(P(minX, 0, minZ), P(maxX, height, maxZ), {
    tilePerMetre: 1 / tile,
    tint: new THREE.Color(0.92 * k, 0.88 * k, 0.86 * k),
    skip: { ny: true },
  });

  // Cornice + parapet: the top edge is what separates a PS2 building from a box.
  if (options.cornice !== false) {
    s.signs.addBox(P(minX - 0.25, height, minZ - 0.25), P(maxX + 0.25, height + 0.55, maxZ + 0.25), {
      uv: SIGN_CELL.cornice(),
      upFacing: 0.3,
    });
    s.signs.addBox(P(minX - 0.1, height + 0.55, minZ - 0.1), P(maxX + 0.1, height + 1.05, maxZ + 0.1), {
      uv: SIGN_CELL.plain(),
      tint: new THREE.Color(0.7, 0.68, 0.66),
      upFacing: 0.3,
    });
  }

  // Tar roof, so rooflines read from the rail deck and upper storeys.
  s.signs.addGround(minX, minZ, maxX, maxZ, height + 0.02, 6, {
    uv: SIGN_CELL.tarRoof(),
    upFacing: 1,
  });

  // Window rows on the front face, one band per floor above the ground floor.
  const floors = options.floors ?? Math.max(1, Math.floor(height / 3.2));
  const litChance = options.litChance ?? 0.45;
  for (let f = 1; f < floors; f++) {
    const y = (options.windowFloorY ?? 1.1) + f * (height / floors);
    if (y + 1.5 > height) break;
    if (front === "north") windowBand(s, "z", minZ - 0.06, minX, maxX, y, 1.5, seed + f * 13, litChance, -1);
    else if (front === "south") windowBand(s, "z", maxZ + 0.06, minX, maxX, y, 1.5, seed + f * 13, litChance, 1);
    else if (front === "west") windowBand(s, "x", minX - 0.06, minZ, maxZ, y, 1.5, seed + f * 13, litChance, -1);
    else windowBand(s, "x", maxX + 0.06, minZ, maxZ, y, 1.5, seed + f * 13, litChance, 1);
  }

  colliders.push(collider(P(minX, 0, minZ), P(maxX, height, maxZ), "wall", "building"));
}

/**
 * Ground-floor plinth. Every building on this map used to be one uniform brick
 * box from pavement to parapet; real blocks have a distinct base — stone,
 * painted concrete, a shopfront — and that horizontal line is most of what
 * gives a street its scale. Proud of the wall by 8 cm so it casts an edge.
 */
function baseBand(
  s: Surfaces,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  height: number,
  tint: THREE.Color
): void {
  const p = 0.08;
  s.concrete.addBox(P(minX - p, 0, minZ - p), P(maxX + p, height, maxZ + p), {
    tilePerMetre: 1 / TILE_METRES.concrete,
    tint,
    skip: { ny: true },
  });
  // The cap line where plinth meets brick.
  s.signs.addBox(P(minX - 0.14, height, minZ - 0.14), P(maxX + 0.14, height + 0.16, maxZ + 0.14), {
    uv: SIGN_CELL.kerb(),
    tint: new THREE.Color(0.42, 0.41, 0.4),
    upFacing: 0.4,
  });
}

const DOOR_CELLS = [WINDOW_CELL.doorGreen, WINDOW_CELL.doorSteel, WINDOW_CELL.doorWood];

/**
 * A recessed doorway with a lit transom. Doors are how a wall reads as a place
 * people live rather than as a barrier, and the little warm rectangle above
 * each one is a navigation cue at 40 m.
 */
function doorway(
  s: Surfaces,
  axis: "z" | "x",
  fixed: number,
  centre: number,
  outward: 1 | -1,
  variant: number,
  lit: boolean
): void {
  const f = fixed + outward * 0.17;
  const w = 0.62;
  const top = 2.15;
  const cell = DOOR_CELLS[variant % DOOR_CELLS.length]();
  const door = { uv: cell, unlit: true, tint: new THREE.Color(0.55, 0.53, 0.5) };
  const transom = {
    uv: SIGN_CELL.plain(),
    unlit: true,
    tint: lit ? new THREE.Color(1.0, 0.74, 0.36) : new THREE.Color(0.12, 0.12, 0.14),
  };

  if (axis === "z") {
    s.windows.addQuad(P(centre - w, 0.1, f), P(centre + w, 0.1, f), P(centre + w, top, f), P(centre - w, top, f), door);
    s.signs.addQuad(
      P(centre - w - 0.14, top + 0.04, f),
      P(centre + w + 0.14, top + 0.04, f),
      P(centre + w + 0.14, top + 0.42, f),
      P(centre - w - 0.14, top + 0.42, f),
      transom
    );
  } else {
    s.windows.addQuad(P(f, 0.1, centre + w), P(f, 0.1, centre - w), P(f, top, centre - w), P(f, top, centre + w), door);
    s.signs.addQuad(
      P(f, top + 0.04, centre + w + 0.14),
      P(f, top + 0.04, centre - w - 0.14),
      P(f, top + 0.42, centre - w - 0.14),
      P(f, top + 0.42, centre + w + 0.14),
      transom
    );
  }
}

interface RunOptions extends BuildingOptions {
  /** Metres per bay. Real rowhouses are 5–7 m wide. */
  bayWidth?: number;
  /** Peak-to-peak height variation between neighbouring bays. */
  heightJitter?: number;
  /** Put a stoop in front of each door. */
  stoops?: boolean;
  /** Ground-floor plinth height; 0 disables it. */
  base?: number;
}

/**
 * A run of rowhouses.
 *
 * This replaced the map's long single-box façades — one of them was 62 m of
 * unbroken brick — and it is the change that most moved the neighbourhood
 * toward the bar. Splitting the same span into 5–7 m bays with their own
 * height, tint and door gives a roofline, breaks the texture repeat, and makes
 * a street read as a row of buildings instead of one wall.
 */
function rowhouseRun(
  s: Surfaces,
  colliders: BoxCollider[],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  options: RunOptions
): void {
  const { front, height } = options;
  const alongX = front === "north" || front === "south";
  const spanStart = alongX ? minX : minZ;
  const spanEnd = alongX ? maxX : maxZ;
  const span = spanEnd - spanStart;
  const bayWidth = options.bayWidth ?? 6.2;
  const bays = Math.max(1, Math.round(span / bayWidth));
  const step = span / bays;
  const jitter = options.heightJitter ?? 1.4;
  const baseHeight = options.base ?? 1.95;

  let seed = (options.seed ?? 17) | 0;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < bays; i++) {
    const a = spanStart + i * step;
    const b = a + step;
    const bayHeight = height + (rand() - 0.5) * 2 * jitter;
    const shade = 0.84 + rand() * 0.3;

    const bx0 = alongX ? a : minX;
    const bx1 = alongX ? b : maxX;
    const bz0 = alongX ? minZ : a;
    const bz1 = alongX ? maxZ : b;

    building(s, colliders, bx0, bz0, bx1, bz1, {
      ...options,
      height: bayHeight,
      floors: Math.max(1, Math.round(bayHeight / 3.1)),
      seed: seed & 0xffff,
      tintScale: shade,
    });

    if (baseHeight > 0) {
      baseBand(s, bx0, bz0, bx1, bz1, baseHeight, new THREE.Color(0.34 * shade, 0.335 * shade, 0.34 * shade));
    }

    // Door on the fronting face, at the bay's centre.
    const centre = (a + b) / 2;
    const lit = rand() < 0.55;
    if (front === "north") doorway(s, "z", minZ, centre, -1, i, lit);
    else if (front === "south") doorway(s, "z", maxZ, centre, 1, i, lit);
    else if (front === "west") doorway(s, "x", minX, centre, -1, i, lit);
    else doorway(s, "x", maxX, centre, 1, i, lit);

    if (options.stoops !== false && rand() < 0.75) {
      if (front === "north") stoop(s, colliders, centre, minZ, "north", 2.2);
      else if (front === "south") stoop(s, colliders, centre, maxZ, "south", 2.2);
    }
  }
}

/** Concrete stoop with risers the player walks up. */
function stoop(
  s: Surfaces,
  colliders: BoxCollider[],
  x: number,
  z: number,
  facing: "north" | "south",
  width = 2.6
): void {
  const dir = facing === "north" ? -1 : 1;
  // Two risers, not three: a 1.65 m stoop swallowed most of the sidewalk and
  // put a 0.9 m wall across the avenue's running line.
  const risers = 2;
  for (let i = 0; i < risers; i++) {
    const y0 = 0;
    const y1 = 0.3 * (i + 1);
    const z0 = z + dir * (0.55 * i);
    const z1 = z0 + dir * 0.55;
    const minZ = Math.min(z0, z1);
    const maxZ = Math.max(z0, z1);
    s.concrete.addBox(P(x - width / 2, y0, minZ), P(x + width / 2, y1, maxZ), {
      tilePerMetre: 1 / TILE_METRES.concrete,
      tint: new THREE.Color(0.86, 0.85, 0.83),
    });
    colliders.push(collider(P(x - width / 2, 0, minZ), P(x + width / 2, y1, maxZ), "step", "stoop"));
  }
}

/** Chain-link run. Fences block the player but not the camera. */
function fence(
  s: Surfaces,
  colliders: BoxCollider[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height = 2.2
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  s.chainLink.addQuad(P(x0, 0, z0), P(x1, 0, z1), P(x1, height, z1), P(x0, height, z0), {
    repeat: { u: len / 2, v: height / 2 },
    upFacing: 0.15,
  });
  s.chainLink.addQuad(P(x1, 0, z1), P(x0, 0, z0), P(x0, height, z0), P(x1, height, z1), {
    repeat: { u: len / 2, v: height / 2 },
    upFacing: 0.15,
  });
  const pad = 0.15;
  colliders.push(
    collider(
      P(Math.min(x0, x1) - pad, 0, Math.min(z0, z1) - pad),
      P(Math.max(x0, x1) + pad, height, Math.max(z0, z1) + pad),
      "prop",
      "fence"
    )
  );
}

/**
 * Ground light pool: the additive *core* under a lamp, nothing more.
 *
 * These were originally twice this size and strength, and the result was a warm
 * wash across the whole foreground instead of a pool — additive blending
 * ignores the surface tint, so a big decal simply erases the darkness the bake
 * worked to create. The bake owns the broad falloff; this owns the hot centre.
 */
function glowPool(s: Surfaces, x: number, z: number, radius: number, color: THREE.Color, y = 0.02): void {
  s.glow.addQuad(
    P(x - radius, y, z + radius),
    P(x + radius, y, z + radius),
    P(x + radius, y, z - radius),
    P(x - radius, y, z - radius),
    { unlit: true, tint: color, upFacing: 1 }
  );
}

/* ------------------------------------------------------------------ */
/* the map                                                              */
/* ------------------------------------------------------------------ */

export function buildNeighborhood(): NeighborhoodBuild {
  const rig = buildLightRig();
  const textures = createTextures();
  const colliders: BoxCollider[] = [];

  const s: Surfaces = {
    asphalt: new MeshBuilder(rig),
    pavement: new MeshBuilder(rig),
    brick: new MeshBuilder(rig),
    concrete: new MeshBuilder(rig),
    siding: new MeshBuilder(rig),
    metal: new MeshBuilder(rig),
    gravel: new MeshBuilder(rig),
    windows: new MeshBuilder(rig),
    signs: new MeshBuilder(rig),
    chainLink: new MeshBuilder(rig),
    glow: new MeshBuilder(rig),
  };

  /* --- ground plane: streets, sidewalks, yards ---------------------- */

  const AV = MAP.avenueRoadZ;
  const AW = MAP.avenueWalkZ;
  const asphaltTint = new THREE.Color(0.5, 0.55, 0.68);
  const walkTint = new THREE.Color(0.4, 0.42, 0.47);

  // Main avenue roadway + its lane paint.
  s.asphalt.addGround(MAP.minX, -AV, MAP.maxX, AV, 0, 3, {
    repeat: { u: rep(220, TILE_METRES.asphalt), v: rep(14, TILE_METRES.asphalt) },
    tint: asphaltTint,
  });
  for (let x = MAP.minX + 4; x < MAP.maxX; x += 9) {
    s.signs.addGround(x, -0.16, x + 4.5, 0.16, 0.015, 4.5, {
      uv: SIGN_CELL.paintYellow(),
      upFacing: 1,
    });
  }
  // Sidewalks, raised 0.14 so the kerb reads and the player steps up.
  for (const side of [-1, 1]) {
    const z0 = side < 0 ? -AW : AV;
    const z1 = side < 0 ? -AV : AW;
    s.pavement.addGround(MAP.minX, z0, MAP.maxX, z1, 0.14, 3, {
      repeat: { u: rep(220, TILE_METRES.pavement), v: rep(4, TILE_METRES.pavement) },
      tint: walkTint,
    });
    colliders.push(
      collider(P(MAP.minX, 0, z0), P(MAP.maxX, 0.14, z1), "step", "avenue-kerb")
    );
  }

  // Cross street.
  s.asphalt.addGround(MAP.crossRoadMinX, MAP.minZ, MAP.crossRoadMaxX, MAP.maxZ, 0, 3, {
    repeat: { u: rep(14, TILE_METRES.asphalt), v: rep(180, TILE_METRES.asphalt) },
    tint: asphaltTint,
  });
  for (const [x0, x1] of [
    [MAP.crossWalkMinX, MAP.crossRoadMinX],
    [MAP.crossRoadMaxX, MAP.crossWalkMaxX],
  ]) {
    for (const [z0, z1] of [
      [MAP.minZ, -AW],
      [AW, MAP.maxZ],
    ]) {
      s.pavement.addGround(x0, z0, x1, z1, 0.14, 3, {
        repeat: { u: rep(4, TILE_METRES.pavement), v: rep(79, TILE_METRES.pavement) },
        tint: walkTint,
      });
      colliders.push(collider(P(x0, 0, z0), P(x1, 0.14, z1), "step", "cross-kerb"));
    }
  }

  // Block interiors: courtyard slab, alley asphalt, quiet-edge gravel.
  s.concrete.addGround(-106, -84, -28, -11, 0, 3, {
    repeat: { u: rep(78, TILE_METRES.concrete), v: rep(73, TILE_METRES.concrete) },
    tint: new THREE.Color(0.46, 0.47, 0.5),
  });
  s.asphalt.addGround(-6, -84, 80, -11, 0, 3, {
    repeat: { u: rep(86, TILE_METRES.asphalt), v: rep(73, TILE_METRES.asphalt) },
    tint: new THREE.Color(0.44, 0.48, 0.6),
  });
  s.gravel.addGround(-106, 11, 80, 84, 0, 4, {
    repeat: { u: rep(186, TILE_METRES.gravel), v: rep(73, TILE_METRES.gravel) },
    tint: new THREE.Color(0.5, 0.49, 0.46),
  });
  s.gravel.addGround(MAP.railMinX, MAP.minZ, 106, MAP.maxZ, 0, 4, {
    repeat: { u: rep(26, TILE_METRES.gravel), v: rep(180, TILE_METRES.gravel) },
    tint: new THREE.Color(0.46, 0.46, 0.5),
  });

  /* --- COURTYARD BLOCK (north-west) --------------------------------- */

  // U of walk-ups around an open courtyard, with a breezeway to the avenue.
  building(s, colliders, -106, -84, -84, -20, { height: 17, front: "east", floors: 5, litChance: 0.5, seed: 11 });
  building(s, colliders, -84, -84, -40, -70, { height: 17, front: "south", floors: 5, litChance: 0.5, seed: 23 });
  building(s, colliders, -46, -70, -28, -44, { height: 16, front: "west", floors: 5, litChance: 0.42, seed: 37 });
  baseBand(s, -106, -84, -84, -20, 2.6, new THREE.Color(0.31, 0.305, 0.31));
  baseBand(s, -84, -84, -40, -70, 2.6, new THREE.Color(0.31, 0.305, 0.31));
  baseBand(s, -46, -70, -28, -44, 2.6, new THREE.Color(0.3, 0.295, 0.3));
  // Recessed entrances into the courtyard wings.
  doorway(s, "x", -46, -50, -1, 0, true);
  doorway(s, "x", -46, -60, -1, 1, false);
  doorway(s, "z", -70, -66, 1, 2, true);
  doorway(s, "x", -84, -50, 1, 1, true);
  // South edge: two rowhouse runs with the breezeway gap between them.
  rowhouseRun(s, colliders, -106, -20, -68, -11, { height: 10, front: "south", seed: 41, bayWidth: 6.4 });
  rowhouseRun(s, colliders, -63, -20, -28, -11, { height: 10, front: "south", seed: 53, bayWidth: 5.9 });
  // Breezeway ceiling — you pass under the building, which reads as a tunnel.
  s.concrete.addBox(P(-68, 4.2, -20), P(-63, 10, -11), {
    tilePerMetre: 1 / TILE_METRES.concrete,
    tint: new THREE.Color(0.7, 0.69, 0.68),
    skip: { ny: false },
  });
  colliders.push(collider(P(-68, 4.2, -20), P(-63, 10, -11), "wall", "breezeway-ceiling"));

  // Courtyard fixtures: stoops, a chain-link line, the green door.
  stoop(s, colliders, -78, -20, "north");
  stoop(s, colliders, -52, -56, "south", 3.0);
  // The lane at X -46..-28, Z -44..-20 is the courtyard's second way in, off
  // the cross street. Half-fenced so the opening reads as an opening.
  fence(s, colliders, -46, -44, -39, -44);

  glowPool(s, -78, -34, 6.12, new THREE.Color(0.341, 0.187, 0.072));
  glowPool(s, -52, -56, 5.76, new THREE.Color(0.132, 0.253, 0.099));
  glowPool(s, -58, -33, 6.2, new THREE.Color(0.33, 0.185, 0.066));
  glowPool(s, -80, -62, 5.04, new THREE.Color(0.077, 0.105, 0.242));
  glowPool(s, -65.5, -15.5, 4.32, new THREE.Color(0.088, 0.121, 0.275));

  /* --- ALLEY MAZE (north-east) -------------------------------------- */

  // South strip faces the avenue; the gap at X 14..24 is the alley mouth.
  rowhouseRun(s, colliders, -6, -32, 14, -11, { height: 11, front: "south", seed: 61, bayWidth: 6.6 });
  rowhouseRun(s, colliders, 24, -32, 50, -11, { height: 11, front: "south", seed: 67, bayWidth: 6.4 });
  rowhouseRun(s, colliders, 56, -32, 80, -11, { height: 11, front: "south", seed: 149, bayWidth: 6.0 });
  // Mid strip, split by the dock cut-through at X 50..56.
  rowhouseRun(s, colliders, -6, -62, 14, -38, { height: 12, front: "east", seed: 71, bayWidth: 6.0, stoops: false });
  rowhouseRun(s, colliders, 24, -56, 50, -38, { height: 12, front: "west", seed: 79, bayWidth: 6.0, stoops: false });
  rowhouseRun(s, colliders, 56, -62, 80, -38, { height: 12, front: "west", seed: 83, bayWidth: 6.0, stoops: false });
  // North strip, with the dead-end stub at X 36..46.
  rowhouseRun(s, colliders, -6, -84, 36, -70, { height: 14, front: "south", seed: 89, bayWidth: 7.0, stoops: false });
  rowhouseRun(s, colliders, 46, -84, 80, -70, { height: 14, front: "south", seed: 97, bayWidth: 6.8, stoops: false });

  // Loading dock: a raised platform bridging the back alley to the cut-through.
  const dockY = 1.15;
  s.concrete.addBox(P(40, 0, -62), P(56, dockY, -56), {
    tilePerMetre: 1 / TILE_METRES.concrete,
    tint: new THREE.Color(0.8, 0.79, 0.77),
  });
  colliders.push(collider(P(40, 0, -62), P(56, dockY, -56), "step", "loading-dock"));
  for (let i = 0; i < 3; i++) {
    const y = (dockY / 3) * (i + 1);
    const x0 = 37 + i * 1.0;
    s.concrete.addBox(P(x0, 0, -61), P(x0 + 1.0, y, -57), {
      tilePerMetre: 1 / TILE_METRES.concrete,
      tint: new THREE.Color(0.82, 0.81, 0.79),
    });
    colliders.push(collider(P(x0, 0, -61), P(x0 + 1.0, y, -57), "step", "dock-steps"));
  }
  s.signs.addQuad(P(40, dockY + 0.01, -56), P(56, dockY + 0.01, -56), P(56, dockY + 0.01, -62), P(40, dockY + 0.01, -62), {
    uv: SIGN_CELL.hazard(),
    upFacing: 1,
  });

  // Dead-end stub: looks like a route, is fenced at the far end.
  fence(s, colliders, 36, -83.5, 46, -83.5);
  stoop(s, colliders, 8, -32, "south");
  stoop(s, colliders, 62, -38, "south");

  glowPool(s, 19, -36, 4.68, new THREE.Color(0.132, 0.264, 0.099));
  glowPool(s, 19, -47, 4.32, new THREE.Color(0.286, 0.165, 0.061));
  glowPool(s, 19, -58, 4.68, new THREE.Color(0.275, 0.154, 0.055));
  glowPool(s, 48, -60, 5.76, new THREE.Color(0.303, 0.176, 0.066));
  glowPool(s, 53, -40, 4.32, new THREE.Color(0.11, 0.22, 0.083));
  glowPool(s, 41, -76, 3.96, new THREE.Color(0.072, 0.094, 0.231));
  glowPool(s, -2, -66, 4.68, new THREE.Color(0.275, 0.154, 0.055));

  /* --- MAIN AVENUE frontage ----------------------------------------- */

  // Corner Mart: the brightest thing on the map and the primary landmark.
  building(s, colliders, -6, -18, 10, -11, {
    height: 5.2,
    front: "south",
    material: "concrete",
    floors: 1,
    cornice: true,
    seed: 101,
  });
  for (let i = 0; i < 4; i++) {
    const x = -5 + i * 3.9;
    s.windows.addQuad(P(x, 0.6, -10.94), P(x + 3.4, 0.6, -10.94), P(x + 3.4, 3.6, -10.94), P(x, 3.6, -10.94), {
      uv: i % 2 === 0 ? WINDOW_CELL.shopA() : WINDOW_CELL.shopB(),
      unlit: true,
      tint: new THREE.Color(1.0, 0.86, 0.58),
    });
  }
  s.signs.addQuad(P(-6, 3.8, -10.8), P(10, 3.8, -10.8), P(10, 5.0, -10.8), P(-6, 5.0, -10.8), {
    uv: SIGN_CELL.signWarm(),
    unlit: true,
    tint: new THREE.Color(1.0, 0.74, 0.36),
  });
  glowPool(s, 2, -9.5, 7.2, new THREE.Color(0.396, 0.286, 0.132));

  // Laundromat / closed storefront across the avenue.
  building(s, colliders, -40, 11, -20, 24, { height: 6.5, front: "north", material: "concrete", floors: 1, seed: 103 });
  s.windows.addQuad(P(-36, 0.7, 10.94), P(-24, 0.7, 10.94), P(-24, 3.4, 10.94), P(-36, 3.4, 10.94), {
    uv: WINDOW_CELL.laundry(),
    unlit: true,
    tint: new THREE.Color(0.62, 0.98, 0.6),
  });
  s.signs.addQuad(P(-38, 3.7, 10.85), P(-22, 3.7, 10.85), P(-22, 4.8, 10.85), P(-38, 4.8, 10.85), {
    uv: SIGN_CELL.signCool(),
    unlit: true,
    tint: new THREE.Color(0.5, 0.8, 0.95),
  });
  glowPool(s, -30, 12.5, 6.48, new THREE.Color(0.11, 0.209, 0.11));

  // Rowhouse frontage along the rest of the avenue's south side.
  rowhouseRun(s, colliders, -106, 11, -44, 22, { height: 10, front: "north", seed: 107, bayWidth: 6.2 });
  rowhouseRun(s, colliders, -16, 11, 34, 22, { height: 10, front: "north", seed: 109, bayWidth: 6.5 });
  rowhouseRun(s, colliders, 38, 11, 80, 22, { height: 10, front: "north", seed: 113, bayWidth: 6.0 });

  // Streetlamp glow pools along the avenue.
  for (let x = -96; x <= 72; x += 28) {
    glowPool(s, x, -9.2, 5.4, new THREE.Color(0.341, 0.187, 0.066));
    glowPool(s, x + 14, 9.2, 5.4, new THREE.Color(0.341, 0.187, 0.066));
  }
  for (let z = -78; z <= 78; z += 30) glowPool(s, -8.4, z, 5.04, new THREE.Color(0.319, 0.176, 0.061));

  /* --- QUIET / VACANT-LOT EDGE (south) ------------------------------ */

  building(s, colliders, -90, 40, -50, 52, { height: 3.6, front: "north", material: "siding", floors: 1, cornice: false, seed: 127 });
  building(s, colliders, -64, 40, -50, 52, { height: 3.9, front: "north", material: "siding", floors: 1, cornice: false, seed: 131 });
  building(s, colliders, -40, 30, -10, 48, { height: 8, front: "north", floors: 2, litChance: 0.3, seed: 137 });
  building(s, colliders, 44, 30, 78, 50, { height: 8, front: "west", floors: 2, litChance: 0.25, seed: 139 });

  fence(s, colliders, 0, 40, 40, 40);
  fence(s, colliders, 40, 40, 40, 76);
  fence(s, colliders, 0, 76, 40, 76);
  glowPool(s, -70, 44, 5.76, new THREE.Color(0.231, 0.132, 0.05));
  glowPool(s, -20, 38, 5.4, new THREE.Color(0.22, 0.121, 0.044));
  glowPool(s, 20, 62, 5.04, new THREE.Color(0.066, 0.088, 0.209));

  /* --- ELEVATED RAILWAY --------------------------------------------- */

  const railHalf = 5;
  for (let z = MAP.minZ; z <= MAP.maxZ; z += 12) {
    for (const dx of [-railHalf + 0.8, railHalf - 0.8]) {
      const x = MAP.railCentreX + dx;
      s.metal.addBox(P(x - 0.55, 0, z - 0.55), P(x + 0.55, MAP.railDeckY, z + 0.55), {
        tilePerMetre: 1 / TILE_METRES.metal,
        tint: new THREE.Color(0.42, 0.44, 0.5),
      });
      colliders.push(collider(P(x - 0.55, 0, z - 0.55), P(x + 0.55, MAP.railDeckY, z + 0.55), "prop", "rail-column"));
    }
    // Cross-bracing between the columns — silhouette, no collision.
    s.metal.addBox(
      P(MAP.railCentreX - railHalf, MAP.railDeckY - 1.4, z - 0.2),
      P(MAP.railCentreX + railHalf, MAP.railDeckY - 1.0, z + 0.2),
      { tilePerMetre: 1 / TILE_METRES.metal, tint: new THREE.Color(0.36, 0.38, 0.44) }
    );
  }
  // Deck + track bed.
  s.metal.addBox(
    P(MAP.railCentreX - railHalf - 0.6, MAP.railDeckY, MAP.minZ),
    P(MAP.railCentreX + railHalf + 0.6, MAP.railDeckY + 0.9, MAP.maxZ),
    { tilePerMetre: 1 / TILE_METRES.metal, tint: new THREE.Color(0.34, 0.36, 0.42) }
  );
  for (const dx of [-1.6, 1.6]) {
    s.metal.addBox(
      P(MAP.railCentreX + dx - 0.12, MAP.railDeckY + 0.9, MAP.minZ),
      P(MAP.railCentreX + dx + 0.12, MAP.railDeckY + 1.05, MAP.maxZ),
      { tilePerMetre: 1 / TILE_METRES.metal, tint: new THREE.Color(0.58, 0.58, 0.6) }
    );
  }
  colliders.push(
    collider(
      P(MAP.railCentreX - railHalf - 0.6, MAP.railDeckY, MAP.minZ),
      P(MAP.railCentreX + railHalf + 0.6, MAP.railDeckY + 1.1, MAP.maxZ),
      "wall",
      "rail-deck"
    )
  );

  /* --- map edge: keep the player inside without a visible wall ------ */

  const EDGE = 3;
  colliders.push(collider(P(MAP.minX - EDGE, 0, MAP.minZ - EDGE), P(MAP.minX, 24, MAP.maxZ + EDGE), "wall", "edge-w"));
  colliders.push(collider(P(106, 0, MAP.minZ - EDGE), P(106 + EDGE, 24, MAP.maxZ + EDGE), "wall", "edge-e"));
  colliders.push(collider(P(MAP.minX - EDGE, 0, MAP.minZ - EDGE), P(MAP.maxX + EDGE, 24, MAP.minZ), "wall", "edge-n"));
  colliders.push(collider(P(MAP.minX - EDGE, 0, MAP.maxZ), P(MAP.maxX + EDGE, 24, MAP.maxZ + EDGE), "wall", "edge-s"));


  /* --- street furniture: the clutter that closes sightlines ---------- */

  const W = 0.14; // sidewalk height — props on the kerb sit on top of it
  const at = (x: number, z: number, y = 0, rotY = 0): PropPlacement => ({ x, z, y, rotY });
  const props: Partial<Record<PropKind, PropPlacement[]>> = {
    streetlamp: [],
    utilityPole: [],
    sedan: [],
    dumpster: [],
    trashCan: [],
    hydrant: [],
    acUnit: [],
    fireEscape: [],
    crate: [],
    cellarDoor: [],
    waterTank: [],
    barrier: [],
    meter: [],
  };
  const push = (kind: PropKind, placement: PropPlacement): void => {
    props[kind]!.push(placement);
  };

  // Streetlamps sit exactly where the bake put their pools — geometry and
  // light must agree or the map reads as if the lamps are decorative.
  for (let x = -96; x <= 72; x += 28) {
    push("streetlamp", at(x, -9.2, W, -Math.PI / 2));
    push("streetlamp", at(x + 14, 9.2, W, Math.PI / 2));
    push("utilityPole", at(x + 8, -10.4, W));
  }
  for (let z = -78; z <= 78; z += 30) push("streetlamp", at(-8.4, z, W, Math.PI));
  for (const [x, z] of [[-70, 44], [-20, 38], [20, 62], [86, 20], [-58, -33], [-80, -62]] as const) {
    push("streetlamp", at(x, z, 0, Math.PI / 2));
  }

  // Parked cars along both kerbs. They break the road into lanes you thread.
  for (const [x, z] of [[-88, -5.4], [-60, 5.4], [-34, -5.4], [6, 5.4], [30, -5.4], [56, 5.4], [70, -5.4]] as const) {
    push("sedan", at(x, z));
  }
  push("sedan", at(10, 55, 0, 0.6));
  push("sedan", at(-58, 36, 0, Math.PI / 2));
  push("sedan", at(-20, -46, 0, Math.PI / 2));

  // Alleys: dumpsters, cans, crates. Dense enough to force a line through them.
  push("streetlamp", at(14.6, -47, 0, -Math.PI / 2));
  push("streetlamp", at(14.6, -36, 0, -Math.PI / 2));
  for (const [x, z, r] of [
    [16.0, -40, Math.PI / 2], [22.0, -55, Math.PI / 2], [30, -68.4, 0],
    [62, -68.4, 0], [-50, -25, 0], [-79, -66, 0], [44, -52.5, 0], [8, -68.4, 0],
  ] as const) {
    push("dumpster", at(x, z, 0, r));
  }
  for (const [x, z, y] of [
    [-90, -9.6, W], [-56, 10.4, W], [0, 10.4, W], [20, 10.4, W], [48, 10.4, W],
    [-70, -22, 0], [15.6, -35, 0], [26, -63, 0], [-52, -58, 0], [66, -40, 0],
  ] as const) {
    push("trashCan", at(x, z, y));
  }
  for (const [x, z, y] of [[43, -60.7, 1.15], [46.5, -57.2, 1.15], [53.4, -60.8, 1.15], [22, -45, 0], [-49, -63, 0]] as const) {
    push("crate", at(x, z, y));
  }
  for (const [x, z] of [[-40, -9.6], [12, -9.6], [44, 9.6], [-22, 9.6], [-8.4, -34]] as const) {
    push("hydrant", at(x, z, W));
  }

  // Wall furniture. Cosmetic, but it is most of what a façade reads as.
  for (const x of [-2, 6, 30, 42, 60, 72]) push("acUnit", at(x, -11.35, 4.6));
  for (const x of [-88, -50, 4, 24, 56]) push("acUnit", at(x, 11.35, 4.4, Math.PI));
  for (const z of [-30, -48]) push("acUnit", at(-45.65, z, 4.8, -Math.PI / 2));
  for (const [x, z] of [[-2, -11.3], [28, -11.3], [-46.3, -40]] as const) push("meter", at(x, z, 1.7));

  // Fire escapes — the courtyard's signature, and the alley's ceiling detail.
  for (const z of [-30, -45, -60]) push("fireEscape", at(-83.5, z, 0, Math.PI / 2));
  for (const z of [-30, -48, -62]) push("fireEscape", at(-46.5, z, 0, -Math.PI / 2));
  for (const x of [-75, -60, -50]) push("fireEscape", at(x, -69.5, 0, 0));
  for (const x of [4, 30, 44, 66]) push("fireEscape", at(x, -32.5, 0, Math.PI));
  push("fireEscape", at(23.5, -45, 0, -Math.PI / 2));
  push("fireEscape", at(14.5, -50, 0, Math.PI / 2));

  for (const [x, z] of [[8, -31.2], [35, -31.2], [-67, -19.2]] as const) push("cellarDoor", at(x, z));
  push("cellarDoor", at(14.9, -50, 0, Math.PI / 2));

  // Rooftop tanks: the skyline read from the avenue and the rail deck.
  for (const [x, z, y] of [[-95, -50, 17.6], [-60, -77, 17.6], [10, -77, 14.6], [62, -77, 14.6], [40, -20, 11.6], [-30, 16, 10.6]] as const) {
    push("waterTank", at(x, z, y));
  }

  // Barriers mark the dead end — it should look plausible, then stop you.
  push("barrier", at(38.5, -82, 0, Math.PI / 2));
  push("barrier", at(43.5, -82, 0, Math.PI / 2));
  push("barrier", at(5, 42));

  const propsBuild = createProps(rig, props);
  colliders.push(...propsBuild.colliders);

  /* --- assemble meshes ---------------------------------------------- */

  const root = new THREE.Group();
  root.name = "neighborhood";
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  const addLayer = (builder: MeshBuilder, material: THREE.Material, name: string): void => {
    const geometry = builder.build();
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = true;
    root.add(mesh);
    materials.push(material);
    geometries.push(geometry);
  };

  for (const mesh of propsBuild.meshes) root.add(mesh);

  addLayer(s.asphalt, litMaterial(textures.asphalt), "asphalt");
  addLayer(s.pavement, litMaterial(textures.pavement), "pavement");
  addLayer(s.gravel, litMaterial(textures.gravel), "gravel");
  addLayer(s.brick, litMaterial(textures.brick), "brick");
  addLayer(s.concrete, litMaterial(textures.concrete), "concrete");
  addLayer(s.siding, litMaterial(textures.siding), "siding");
  addLayer(s.metal, litMaterial(textures.metal), "metal");
  addLayer(s.windows, litMaterial(textures.windows), "windows");
  addLayer(s.signs, litMaterial(textures.signs), "signs");
  addLayer(
    s.chainLink,
    new THREE.MeshBasicMaterial({
      map: textures.chainLink,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      fog: true,
    }),
    "chainlink"
  );
  addLayer(
    s.glow,
    new THREE.MeshBasicMaterial({
      map: textures.glow,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }),
    "glow"
  );

  // Sky dome: never black, and it closes the top of every corridor.
  const skyGeometry = new THREE.SphereGeometry(RenderConfig.cameraFar * 0.82, 16, 10);
  const skyMaterial = new THREE.MeshBasicMaterial({
    map: textures.sky,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.name = "sky";
  sky.renderOrder = -1;
  root.add(sky);
  materials.push(skyMaterial);
  geometries.push(skyGeometry);

  /* --- authored locations ------------------------------------------- */

  const L = (
    id: string,
    name: string,
    zone: WorldLocation["zone"],
    x: number,
    z: number,
    facingRad: number,
    reach: WorldLocation["reach"]
  ): WorldLocation => ({ id, name, zone, position: P(x, 0, z), facingRad, reach });

  const locations: WorldLocation[] = [
    L("corner-mart", "Corner Mart", "avenue", 2, -8.4, 0, "easy"),
    L("laundromat", "Wash n Dry", "avenue", -30, 8.4, Math.PI, "easy"),
    L("rowhouse-stoop", "Rowhouse Stoop", "avenue", 20, 8.4, Math.PI, "easy"),
    L("courtyard-b", "Courtyard B", "courtyard", -66, -46, 0, "medium"),
    L("walkup-a", "Walk-Up A", "courtyard", -80, -24, 0, "medium"),
    L("alley-door", "Alley Door", "alleys", 19, -34, 0, "medium"),
    L("loading-dock", "Loading Dock", "alleys", 48, -59, Math.PI, "risky"),
    L("cellar-steps", "Cellar Steps", "alleys", 62, -36, Math.PI, "risky"),
    L("garage-row", "Garage Row", "quiet", -70, 38, Math.PI, "medium"),
    L("vacant-lot", "Vacant Lot", "quiet", 20, 44, Math.PI, "medium"),
    L("rail-underpass", "Rail Underpass", "rail", 86, 18, Math.PI / 2, "risky"),
  ];

  /* --- authored routes: the shortcuts must actually pay -------------- */

  const byId = new Map(locations.map((l) => [l.id, l]));
  const routes: AuthoredRoute[] = [
    {
      id: "laundromat-to-courtyard",
      fromLocationId: "laundromat",
      toLocationId: "courtyard-b",
      shortcutName: "Courtyard breezeway",
      // Safe: back east to the cross street, north, then west in through the
      // lane beside the walk-ups. Every metre of it is a street you can see.
      safePath: [P(-30, 0, 8.4), P(-26, 0, 0), P(-26, 0, -32), P(-40, 0, -32), P(-56, 0, -40), P(-66, 0, -46)],
      // Shortcut: straight west along the avenue and duck through the breezeway.
      shortcutPath: [P(-30, 0, 8.4), P(-65.5, 0, -8.4), P(-65.5, 0, -22), P(-66, 0, -46)],
    },
    {
      id: "mart-to-dock",
      fromLocationId: "corner-mart",
      toLocationId: "loading-dock",
      shortcutName: "Service alley",
      // Safe: east along the avenue to the rail corridor, then north and back.
      safePath: [P(2, 0, -8.4), P(86, 0, -8.4), P(86, 0, -66), P(36, 0, -66), P(36, 0, -59), P(48, 0, -59)],
      // Shortcut: up the alley mouth at X 19, then east along the back alley.
      shortcutPath: [P(2, 0, -8.4), P(19, 0, -8.4), P(19, 0, -59), P(36, 0, -59), P(48, 0, -59)],
    },
    {
      id: "dock-to-rail",
      fromLocationId: "loading-dock",
      toLocationId: "rail-underpass",
      shortcutName: "Dock cut-through",
      // Safe: back west down the alley, out the mouth, and all the way east
      // along the avenue — the whole block, the long way round.
      safePath: [P(48, 0, -59), P(36, 0, -59), P(19, 0, -59), P(19, 0, -8.4), P(86, 0, -8.4), P(86, 0, 18)],
      // Shortcut: south through the building gap at X 50-56, straight out.
      shortcutPath: [P(48, 0, -59), P(53, 0, -56), P(53, 0, -34), P(53, 0, -8.4), P(86, 0, -8.4), P(86, 0, 18)],
    },
  ];

  // Certify at build time that every shortcut is genuinely shorter. This is a
  // gameplay guarantee, not decoration — if it fails, the route is redesigned.
  for (const route of routes) {
    const safe = pathLength(route.safePath);
    const short = pathLength(route.shortcutPath);
    const saving = 1 - short / safe;
    if (saving < 0.15) {
      console.warn(
        `[neighborhood] shortcut "${route.shortcutName}" only saves ${(saving * 100).toFixed(1)}% — redesign it`
      );
    }
    if (!byId.has(route.fromLocationId) || !byId.has(route.toLocationId)) {
      console.warn(`[neighborhood] route ${route.id} references an unknown location`);
    }
  }

  const bounds = { minX: MAP.minX, maxX: 106, minZ: MAP.minZ, maxZ: MAP.maxZ };

  return {
    root,
    colliders,
    locations,
    routes,
    // Start at the intersection, facing the corner store — the first objective
    // is visible from the spawn, so nobody needs telling where to go.
    spawn: { position: P(-17, 0, 4), facingRad: 0 },
    bounds,
    sampleLight(x: number, y: number, z: number): THREE.Color {
      return bake(rig, x, y, z, 0.65);
    },
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      propsBuild.dispose();
      disposeTextures(textures);
      root.clear();
    },
  };
}
