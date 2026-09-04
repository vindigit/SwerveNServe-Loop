import type * as THREE from "three";

/**
 * Shared world contracts.
 *
 * These types are the seam between the four systems that must agree about the
 * neighbourhood: the world builder authors them, the player and camera consume
 * collision, and the job director consumes locations. Nothing here should grow
 * behaviour — it is data, deliberately.
 */

/** Axis-aligned box collider. Y range matters: low boxes are steps, tall boxes are walls. */
export interface BoxCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** World Y of the bottom face. Street level is 0. */
  minY: number;
  /** World Y of the top face. A box the player can stand on reports this as ground. */
  maxY: number;
  /**
   * `wall` blocks and occludes the camera.
   * `prop` blocks the player but the camera may pass (dumpsters, cars, fences).
   * `step` is walkable-onto geometry (stoops, kerbs, loading docks, stairs).
   */
  kind: "wall" | "prop" | "step";
  /** Debug label, surfaced in the collision overlay. */
  tag?: string;
}

/** One of the five authored zones. Used for audio, pacing and job difficulty. */
export type ZoneId = "avenue" | "courtyard" | "alleys" | "quiet" | "rail";

/** An authored pickup/delivery endpoint. Positions are floor-level (y = ground). */
export interface WorldLocation {
  id: string;
  /** Shown in the job offer and HUD, e.g. "Corner Mart". */
  name: string;
  zone: ZoneId;
  position: THREE.Vector3;
  /** Which way the player is expected to arrive from, for marker placement. */
  facingRad: number;
  /** Authored difficulty of reaching this point — feeds the payout. */
  reach: "easy" | "medium" | "risky";
}

/** A named route the map guarantees, used to certify that shortcuts actually pay. */
export interface AuthoredRoute {
  id: string;
  fromLocationId: string;
  toLocationId: string;
  /** Ordered waypoints along the obvious main-avenue path. */
  safePath: THREE.Vector3[];
  /** Ordered waypoints along the shortcut. Must be genuinely shorter or safer. */
  shortcutPath: THREE.Vector3[];
  shortcutName: string;
}

/** Everything the world builder hands back to the game. */
export interface NeighborhoodBuild {
  /** Single root added to the scene; disposed wholesale on teardown. */
  root: THREE.Object3D;
  colliders: BoxCollider[];
  locations: WorldLocation[];
  routes: AuthoredRoute[];
  /** Where the player starts a run. */
  spawn: { position: THREE.Vector3; facingRad: number };
  /** Map extent, used by the collision broadphase and the out-of-world respawn. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /**
   * Sample the authored light bake at a point. Characters are lit by sampling
   * this once per frame and tinting their materials — the PS2 way — so a
   * courier darkens in an alley and glows warm under a sodium lamp without
   * adding a single dynamic light.
   */
  sampleLight(x: number, y: number, z: number): THREE.Color;

  /** Called on teardown — dispose geometries/materials/textures created here. */
  dispose(): void;
}
