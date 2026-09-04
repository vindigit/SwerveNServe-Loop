import * as THREE from "three";
import type { BoxCollider } from "@/world/types";

/**
 * Geometry construction kit for the neighbourhood.
 *
 * Everything the map is made of goes through here, and the whole thing renders
 * with `MeshBasicMaterial` + vertex colours + fog — zero dynamic lights. That
 * is not a shortcut, it is the PS2 technique: the night look in the bar comes
 * from *baked pools of warm light on near-black ground*, and baking is both
 * cheaper and more controllable than lighting a scene at runtime.
 *
 * The two halves of the look:
 *   - `bake()` gives the broad, gouraud falloff across a surface.
 *   - additive glow decals (see Neighborhood) give the hot core of each pool.
 * Together they produce the luminance peaks-and-troughs profile BAR.md requires.
 */

/** An authored light. These emit no light at runtime — they drive the bake. */
export interface BakedLamp {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  /** Metres to full falloff. */
  radius: number;
  intensity: number;
}

export interface LightRig {
  /** Cold sky bounce applied everywhere, so nothing is ever pure black. */
  ambientTop: THREE.Color;
  /** Darker term for vertical surfaces — walls fall off faster than ground. */
  ambientSide: THREE.Color;
  lamps: BakedLamp[];
}

const _v = new THREE.Vector3();

/**
 * Light a point. `upFacing` is 1 for a floor, 0 for a wall — overhead lamps
 * pour onto the ground and only graze façades, which is what sells the pools.
 */
export function bake(rig: LightRig, x: number, y: number, z: number, upFacing: number): THREE.Color {
  const out = rig.ambientSide.clone().lerp(rig.ambientTop, upFacing);
  for (const lamp of rig.lamps) {
    const dx = x - lamp.x;
    const dy = y - lamp.y;
    const dz = z - lamp.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= lamp.radius) continue;
    // Quadratic falloff, plus a mild bias toward surfaces under the lamp.
    const t = 1 - dist / lamp.radius;
    const att = t * t;
    const below = y < lamp.y ? 1 : 0.45;
    const facing = 0.42 + 0.58 * upFacing * below;
    const k = att * lamp.intensity * facing;
    out.r += lamp.color.r * k;
    out.g += lamp.color.g * k;
    out.b += lamp.color.b * k;
  }
  // Keep it in range but let highlights bloom toward white inside a pool.
  out.r = Math.min(1, out.r);
  out.g = Math.min(1, out.g);
  out.b = Math.min(1, out.b);
  return out;
}

export interface QuadOptions {
  /** UV rect. Defaults to the unit square. */
  uv?: { u0: number; v0: number; u1: number; v1: number };
  /** Tiling repeats across the quad, applied on top of `uv`. */
  repeat?: { u: number; v: number };
  /** Flat colour multiplier applied after the bake (grime, paint). */
  tint?: THREE.Color;
  /** 1 = floor-like, 0 = wall-like. Drives the bake's facing term. */
  upFacing?: number;
  /** Skip the bake and use `tint` directly — for emissive windows and signs. */
  unlit?: boolean;
}

/**
 * Accumulates triangles into one buffer. One builder per material, so the whole
 * map ends up as a handful of draw calls instead of hundreds of meshes.
 */
export class MeshBuilder {
  private positions: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];
  private vertexCount = 0;

  constructor(private readonly rig: LightRig) {}

  get isEmpty(): boolean {
    return this.vertexCount === 0;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Corners in winding order; the normal follows the right-hand rule. */
  addQuad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    options: QuadOptions = {}
  ): void {
    const uv = options.uv ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
    const rep = options.repeat ?? { u: 1, v: 1 };
    const up = options.upFacing ?? 0;
    const tint = options.tint;

    const corners = [a, b, c, d];
    const uvCoords = [
      [uv.u0, uv.v0],
      [uv.u1 * rep.u, uv.v0],
      [uv.u1 * rep.u, uv.v1 * rep.v],
      [uv.u0, uv.v1 * rep.v],
    ];

    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      this.positions.push(p.x, p.y, p.z);
      this.uvs.push(uvCoords[i][0], uvCoords[i][1]);

      let col: THREE.Color;
      if (options.unlit) {
        col = tint ? tint.clone() : new THREE.Color(1, 1, 1);
      } else {
        col = bake(this.rig, p.x, p.y, p.z, up);
        if (tint) col.multiply(tint);
      }
      this.colors.push(col.r, col.g, col.b);
    }

    const v = this.vertexCount;
    this.indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.vertexCount += 4;
  }

  /**
   * Horizontal slab subdivided on a grid so the light bake has vertices to
   * interpolate between. Without subdivision a road is four vertices and every
   * pool of light vanishes.
   */
  addGround(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    y: number,
    step: number,
    options: QuadOptions = {}
  ): void {
    const nx = Math.max(1, Math.round((maxX - minX) / step));
    const nz = Math.max(1, Math.round((maxZ - minZ) / step));
    const dx = (maxX - minX) / nx;
    const dz = (maxZ - minZ) / nz;
    const repU = options.repeat?.u ?? 1;
    const repV = options.repeat?.v ?? 1;

    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x0 = minX + ix * dx;
        const x1 = x0 + dx;
        const z0 = minZ + iz * dz;
        const z1 = z0 + dz;
        // UVs continue across the whole slab so tiling doesn't reset per cell.
        const u0 = (x0 - minX) / (maxX - minX);
        const u1 = (x1 - minX) / (maxX - minX);
        const v0 = (z0 - minZ) / (maxZ - minZ);
        const v1 = (z1 - minZ) / (maxZ - minZ);
        this.addQuad(
          _v.set(x0, y, z1).clone(),
          _v.set(x1, y, z1).clone(),
          _v.set(x1, y, z0).clone(),
          _v.set(x0, y, z0).clone(),
          {
            ...options,
            upFacing: options.upFacing ?? 1,
            uv: { u0: u0 * repU, v0: v0 * repV, u1: u1 * repU, v1: v1 * repV },
            repeat: { u: 1, v: 1 },
          }
        );
      }
    }
  }

  /**
   * Box shell. `skip` drops faces you will never see — the back of a rowhouse
   * pressed against its neighbour, the underside of a stoop. Fewer triangles,
   * and no hidden geometry per the asset rules.
   */
  addBox(
    min: THREE.Vector3,
    max: THREE.Vector3,
    options: QuadOptions & {
      skip?: Partial<Record<"px" | "nx" | "py" | "ny" | "pz" | "nz", boolean>>;
      /** Repeats per metre, so texture scale stays constant across sizes. */
      tilePerMetre?: number;
    } = {}
  ): void {
    const { min: a, max: b } = { min, max };
    const skip = options.skip ?? {};
    const tpm = options.tilePerMetre ?? 0;
    const w = b.x - a.x;
    const h = b.y - a.y;
    const d = b.z - a.z;
    const rep = (u: number, v: number) => (tpm ? { u: u * tpm, v: v * tpm } : options.repeat);

    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    if (!skip.py)
      this.addQuad(P(a.x, b.y, b.z), P(b.x, b.y, b.z), P(b.x, b.y, a.z), P(a.x, b.y, a.z), {
        ...options,
        upFacing: 1,
        repeat: rep(w, d),
      });
    if (!skip.ny)
      this.addQuad(P(a.x, a.y, a.z), P(b.x, a.y, a.z), P(b.x, a.y, b.z), P(a.x, a.y, b.z), {
        ...options,
        upFacing: 0,
        repeat: rep(w, d),
      });
    if (!skip.pz)
      this.addQuad(P(a.x, a.y, b.z), P(b.x, a.y, b.z), P(b.x, b.y, b.z), P(a.x, b.y, b.z), {
        ...options,
        upFacing: 0,
        repeat: rep(w, h),
      });
    if (!skip.nz)
      this.addQuad(P(b.x, a.y, a.z), P(a.x, a.y, a.z), P(a.x, b.y, a.z), P(b.x, b.y, a.z), {
        ...options,
        upFacing: 0,
        repeat: rep(w, h),
      });
    if (!skip.px)
      this.addQuad(P(b.x, a.y, b.z), P(b.x, a.y, a.z), P(b.x, b.y, a.z), P(b.x, b.y, b.z), {
        ...options,
        upFacing: 0,
        repeat: rep(d, h),
      });
    if (!skip.nx)
      this.addQuad(P(a.x, a.y, a.z), P(a.x, a.y, b.z), P(a.x, b.y, b.z), P(a.x, b.y, a.z), {
        ...options,
        upFacing: 0,
        repeat: rep(d, h),
      });
  }

  build(): THREE.BufferGeometry | null {
    if (this.vertexCount === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Convenience: a wall/prop/step collider from a min/max pair. */
export function collider(
  min: THREE.Vector3,
  max: THREE.Vector3,
  kind: BoxCollider["kind"],
  tag?: string
): BoxCollider {
  return {
    minX: min.x,
    maxX: max.x,
    minY: min.y,
    maxY: max.y,
    minZ: min.z,
    maxZ: max.z,
    kind,
    tag,
  };
}

/** Straight-line length of a polyline, used to certify shortcut savings. */
export function pathLength(points: THREE.Vector3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1]);
  return total;
}
