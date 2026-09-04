import * as THREE from "three";
import type { BoxCollider } from "@/world/types";

/**
 * CollisionWorld
 *
 * Authored-volume collision. No physics engine: the whole map is a list of
 * axis-aligned boxes in a uniform grid, and the player is a vertical cylinder.
 * That is enough for a courier game in alleys, and it means collision is
 * deterministic, cheap, and debuggable — you can see every volume.
 *
 * Two rules do most of the work:
 *   - A box whose top is at or below (feet + stepHeight) is *ground*, not a wall.
 *     Stoops, kerbs and loading docks therefore get walked onto, not bumped into.
 *   - Resolution is per-axis. Sliding along a wall is the default behaviour,
 *     which is what makes narrow alleys feel good instead of sticky.
 */

const CELL = 8; // metres per broadphase cell

export interface MoveResult {
  /** Resolved position (mutates and returns the vector passed in). */
  position: THREE.Vector3;
  grounded: boolean;
  /** True if lateral motion was blocked this frame — drives scuff audio/anim. */
  hitWall: boolean;
  /** Ground height under the resolved position. */
  groundY: number;
}

export class CollisionWorld {
  private readonly boxes: BoxCollider[];
  private readonly grid = new Map<number, number[]>();
  private readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private readonly cols: number;
  private readonly originX: number;
  private readonly originZ: number;

  constructor(boxes: BoxCollider[], bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    this.boxes = boxes;
    this.bounds = bounds;
    this.originX = Math.floor(bounds.minX / CELL) - 1;
    this.originZ = Math.floor(bounds.minZ / CELL) - 1;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / CELL) + 3;

    boxes.forEach((box, index) => {
      const x0 = Math.floor(box.minX / CELL);
      const x1 = Math.floor(box.maxX / CELL);
      const z0 = Math.floor(box.minZ / CELL);
      const z1 = Math.floor(box.maxZ / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = this.cellKey(x, z);
          const list = this.grid.get(key);
          if (list) list.push(index);
          else this.grid.set(key, [index]);
        }
      }
    });
  }

  getBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return this.bounds;
  }

  getBoxes(): readonly BoxCollider[] {
    return this.boxes;
  }

  private cellKey(cx: number, cz: number): number {
    return (cz - this.originZ) * this.cols + (cx - this.originX);
  }

  /** Candidate boxes overlapping an AABB query. Reused array — do not retain. */
  private readonly queryScratch: number[] = [];
  private query(minX: number, maxX: number, minZ: number, maxZ: number): number[] {
    const out = this.queryScratch;
    out.length = 0;
    const x0 = Math.floor(minX / CELL);
    const x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL);
    const z1 = Math.floor(maxZ / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const list = this.grid.get(this.cellKey(x, z));
        if (!list) continue;
        for (const index of list) if (!out.includes(index)) out.push(index);
      }
    }
    return out;
  }

  /**
   * Highest walkable surface under (x, z) that is not above `ceiling`.
   * Street level is 0, so an empty map still has a floor.
   */
  groundHeightAt(x: number, z: number, ceiling: number): number {
    let best = 0;
    const candidates = this.query(x, x, z, z);
    for (const index of candidates) {
      const box = this.boxes[index];
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (box.maxY > ceiling) continue;
      if (box.maxY > best) best = box.maxY;
    }
    return best;
  }

  /**
   * Move a vertical cylinder from `position` by `delta`, resolving per axis.
   * `position` is the capsule's *feet*.
   */
  moveCapsule(
    position: THREE.Vector3,
    delta: THREE.Vector3,
    radius: number,
    height: number,
    stepHeight: number
  ): MoveResult {
    let hitWall = false;

    // --- Lateral, resolved one axis at a time so the player slides along walls.
    for (const axis of ["x", "z"] as const) {
      const amount = delta[axis];
      if (amount === 0) continue;
      position[axis] += amount;

      // Only boxes tall enough to matter at the current feet height block us.
      const feet = position.y;
      const blockCeiling = feet + stepHeight;
      const headY = feet + height;

      const candidates = this.query(
        position.x - radius,
        position.x + radius,
        position.z - radius,
        position.z + radius
      );

      for (const index of candidates) {
        const box = this.boxes[index];
        if (box.maxY <= blockCeiling) continue; // walkable — handled by gravity
        if (box.minY >= headY) continue; // overhead — duck under it

        const closestX = Math.max(box.minX, Math.min(position.x, box.maxX));
        const closestZ = Math.max(box.minZ, Math.min(position.z, box.maxZ));
        const dx = position.x - closestX;
        const dz = position.z - closestZ;
        if (dx * dx + dz * dz >= radius * radius) continue;

        hitWall = true;
        // Push out along the axis we just moved on — cheap, and correct for AABBs.
        if (axis === "x") {
          position.x = amount > 0 ? box.minX - radius : box.maxX + radius;
        } else {
          position.z = amount > 0 ? box.minZ - radius : box.maxZ + radius;
        }
      }
    }

    // --- Vertical.
    position.y += delta.y;
    const groundY = this.groundHeightAt(position.x, position.z, position.y + stepHeight);
    let grounded = false;
    if (position.y <= groundY + 1e-4) {
      position.y = groundY;
      grounded = true;
    }

    return { position, grounded, hitWall, groundY };
  }

  /**
   * First hit fraction along a segment, 0..1 (1 = clear). Used by the camera to
   * pull in when a wall gets between it and the player. `props` are skipped by
   * default: a dumpster should not yank the camera, a building should.
   */
  segmentHit(from: THREE.Vector3, to: THREE.Vector3, pad = 0, includeProps = false): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;

    const candidates = this.query(
      Math.min(from.x, to.x) - pad,
      Math.max(from.x, to.x) + pad,
      Math.min(from.z, to.z) - pad,
      Math.max(from.z, to.z) + pad
    );

    let nearest = 1;
    for (const index of candidates) {
      const box = this.boxes[index];
      if (box.kind === "step") continue;
      if (!includeProps && box.kind === "prop") continue;

      // Slab test against the box expanded by `pad`.
      let tMin = 0;
      let tMax = nearest;
      let ok = true;
      const lo = [box.minX - pad, box.minY - pad, box.minZ - pad];
      const hi = [box.maxX + pad, box.maxY + pad, box.maxZ + pad];
      const origin = [from.x, from.y, from.z];
      const dir = [dx, dy, dz];

      for (let a = 0; a < 3; a++) {
        if (Math.abs(dir[a]) < 1e-8) {
          if (origin[a] < lo[a] || origin[a] > hi[a]) {
            ok = false;
            break;
          }
          continue;
        }
        const inv = 1 / dir[a];
        let t0 = (lo[a] - origin[a]) * inv;
        let t1 = (hi[a] - origin[a]) * inv;
        if (t0 > t1) [t0, t1] = [t1, t0];
        if (t0 > tMin) tMin = t0;
        if (t1 < tMax) tMax = t1;
        if (tMin > tMax) {
          ok = false;
          break;
        }
      }
      if (ok && tMin >= 0 && tMin < nearest) nearest = tMin;
    }
    return nearest;
  }

  /** True if the point is outside the authored map — triggers a safe respawn. */
  isOutOfWorld(position: THREE.Vector3): boolean {
    const b = this.bounds;
    return (
      position.y < -12 ||
      position.x < b.minX - 12 ||
      position.x > b.maxX + 12 ||
      position.z < b.minZ - 12 ||
      position.z > b.maxZ + 12
    );
  }
}
