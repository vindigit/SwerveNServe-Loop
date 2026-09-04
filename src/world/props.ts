import * as THREE from "three";
import { bake, collider, type LightRig } from "@/world/build";
import type { BoxCollider } from "@/world/types";

/**
 * Street furniture.
 *
 * The first playable had none, and the neighbourhood read as a corridor of
 * empty boxes — the single biggest gap against the bar, whose frames are dense
 * with poles, lamps, dumpsters, fire escapes and parked cars closing every
 * sightline. Clutter is not decoration here; it is what makes a 220 m map feel
 * like a place, and what stops you seeing 200 m down a street.
 *
 * Everything is an `InstancedMesh`: one geometry, one material, one draw call
 * per prop type no matter how many are placed. Per-instance lighting comes from
 * `instanceColor`, sampled from the same baked rig the buildings use — so a
 * dumpster under a sodium lamp is warm and the identical dumpster twenty metres
 * away is nearly black, for free.
 */

export type PropKind =
  | "streetlamp"
  | "utilityPole"
  | "dumpster"
  | "trashCan"
  | "acUnit"
  | "fireEscape"
  | "sedan"
  | "hydrant"
  | "crate"
  | "cellarDoor"
  | "waterTank"
  | "barrier"
  | "meter";

export interface PropPlacement {
  x: number;
  z: number;
  y?: number;
  rotY?: number;
}

/** Footprint used for collision, in local space before rotation. */
interface PropSpec {
  build(): THREE.BufferGeometry;
  /** half-extents x/z and height; omitted = no collider. */
  box?: { hx: number; hz: number; h: number; kind: BoxCollider["kind"] };
  /** Emissive lens geometry drawn as a second, unlit instanced mesh. */
  lens?: { build(): THREE.BufferGeometry; color: number };
}

/* ------------------------------------------------------------------ */
/* tiny geometry kit — boxes and cylinders with flat vertex colours     */
/* ------------------------------------------------------------------ */

interface Part {
  geometry: THREE.BufferGeometry;
  color: THREE.Color;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, rotY = 0): Part {
  const geometry = new THREE.BoxGeometry(w, h, d);
  if (rotY) geometry.rotateY(rotY);
  geometry.translate(x, y, z);
  return { geometry, color: new THREE.Color(hex) };
}

function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  seg: number,
  x: number,
  y: number,
  z: number,
  hex: number,
  rotZ = 0
): Part {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  if (rotZ) geometry.rotateZ(rotZ);
  geometry.translate(x, y, z);
  return { geometry, color: new THREE.Color(hex) };
}

/** Merge parts into one geometry, baking each part's colour into vertices. */
function merge(parts: Part[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let offset = 0;

  for (const part of parts) {
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    const pos = geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      // Slight per-face variation keeps flat colour from looking like plastic.
      const shade = 0.82 + ((i / 3) % 4) * 0.06;
      colors.push(part.color.r * shade, part.color.g * shade, part.color.b * shade);
    }
    for (let i = 0; i < pos.count; i++) indices.push(offset + i);
    offset += pos.count;
    if (geometry !== part.geometry) geometry.dispose();
    part.geometry.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}

/* ------------------------------------------------------------------ */
/* the catalogue                                                        */
/* ------------------------------------------------------------------ */

const STEEL = 0x4c5058;
const DARK_STEEL = 0x33363d;

const SPECS: Record<PropKind, PropSpec> = {
  /** Cobra-head streetlamp. The pole is the vertical that closes a sightline. */
  streetlamp: {
    build: () =>
      merge([
        cyl(0.09, 0.13, 6.4, 6, 0, 3.2, 0, DARK_STEEL),
        box(0.34, 0.34, 0.34, 0, 0.18, 0, 0x2b2e34),
        // Arm reaching over the roadway.
        box(1.5, 0.11, 0.11, 0.75, 6.35, 0, DARK_STEEL),
        box(0.62, 0.2, 0.34, 1.5, 6.22, 0, 0x3a3e45),
      ]),
    box: { hx: 0.16, hz: 0.16, h: 6.4, kind: "prop" },
    lens: {
      build: () => merge([box(0.5, 0.06, 0.28, 1.5, 6.11, 0, 0xffc46a)]),
      color: 0xffc46a,
    },
  },

  /** Utility pole with a crossarm. Reads instantly as an old US block. */
  utilityPole: {
    build: () =>
      merge([
        cyl(0.14, 0.19, 8.2, 6, 0, 4.1, 0, 0x4a3b2c),
        box(2.6, 0.13, 0.13, 0, 7.5, 0, 0x4a3b2c),
        box(2.2, 0.11, 0.11, 0, 6.9, 0, 0x4a3b2c),
        box(0.1, 0.22, 0.1, -1.0, 7.68, 0, 0x6f7a86),
        box(0.1, 0.22, 0.1, 0, 7.68, 0, 0x6f7a86),
        box(0.1, 0.22, 0.1, 1.0, 7.68, 0, 0x6f7a86),
        box(0.5, 0.6, 0.5, 0.0, 5.4, 0.36, 0x5a5f66),
      ]),
    box: { hx: 0.22, hz: 0.22, h: 8.2, kind: "prop" },
  },

  dumpster: {
    build: () =>
      merge([
        box(2.3, 1.15, 1.3, 0, 0.62, 0, 0x2f4a3a),
        box(2.42, 0.16, 1.42, 0, 1.24, 0, 0x37543f),
        box(0.14, 0.34, 0.14, -0.95, 0.17, 0.5, 0x1d1f22),
        box(0.14, 0.34, 0.14, 0.95, 0.17, 0.5, 0x1d1f22),
        box(0.14, 0.34, 0.14, -0.95, 0.17, -0.5, 0x1d1f22),
        box(0.14, 0.34, 0.14, 0.95, 0.17, -0.5, 0x1d1f22),
      ]),
    box: { hx: 1.2, hz: 0.72, h: 1.32, kind: "prop" },
  },

  trashCan: {
    build: () =>
      merge([
        cyl(0.34, 0.3, 0.95, 8, 0, 0.48, 0, 0x3c4148),
        cyl(0.37, 0.37, 0.08, 8, 0, 0.98, 0, 0x4a5058),
      ]),
    box: { hx: 0.37, hz: 0.37, h: 1.0, kind: "prop" },
  },

  /** Wall-mounted air conditioner — placed against façades, no collision. */
  acUnit: {
    build: () =>
      merge([
        box(0.8, 0.6, 0.55, 0, 0, 0, 0x8d9199),
        box(0.66, 0.46, 0.06, 0, 0, 0.3, 0x5c6169),
        box(0.9, 0.08, 0.6, 0, -0.33, 0, 0x53575e),
      ]),
  },

  /** Fire escape: the courtyard's signature silhouette. Cosmetic, no collision. */
  fireEscape: {
    build: () => {
      const parts: Part[] = [];
      for (let level = 0; level < 3; level++) {
        const y = 3.2 + level * 3.2;
        parts.push(box(2.6, 0.1, 1.15, 0, y, 0.58, DARK_STEEL));
        parts.push(box(2.6, 0.05, 0.05, 0, y + 0.95, 1.12, STEEL));
        parts.push(box(0.05, 0.95, 0.05, -1.28, y + 0.48, 1.12, STEEL));
        parts.push(box(0.05, 0.95, 0.05, 1.28, y + 0.48, 1.12, STEEL));
        // Ladder up to the next landing.
        parts.push(box(0.05, 3.0, 0.05, 0.9, y + 1.6, 0.95, STEEL));
        parts.push(box(0.05, 3.0, 0.05, 1.35, y + 1.6, 0.95, STEEL));
        for (let r = 0; r < 6; r++) {
          parts.push(box(0.5, 0.04, 0.04, 1.12, y + 0.4 + r * 0.5, 0.95, STEEL));
        }
      }
      return merge(parts);
    },
  },

  /** Late-90s sedan. Boxy on purpose — the era did not do curves. */
  sedan: {
    build: () =>
      merge([
        box(4.35, 0.62, 1.78, 0, 0.62, 0, 0x3b4654),
        box(2.35, 0.58, 1.62, -0.12, 1.2, 0, 0x2c3541),
        box(2.15, 0.42, 1.5, -0.12, 1.22, 0, 0x14181f),
        box(4.4, 0.14, 1.84, 0, 0.34, 0, 0x22262c),
        cyl(0.33, 0.33, 0.22, 8, -1.42, 0.33, 0.86, 0x17191d, Math.PI / 2),
        cyl(0.33, 0.33, 0.22, 8, 1.42, 0.33, 0.86, 0x17191d, Math.PI / 2),
        cyl(0.33, 0.33, 0.22, 8, -1.42, 0.33, -0.86, 0x17191d, Math.PI / 2),
        cyl(0.33, 0.33, 0.22, 8, 1.42, 0.33, -0.86, 0x17191d, Math.PI / 2),
        box(0.34, 0.16, 0.1, -2.14, 0.72, 0.58, 0xd9cfae),
        box(0.34, 0.16, 0.1, -2.14, 0.72, -0.58, 0xd9cfae),
        box(0.3, 0.14, 0.1, 2.16, 0.72, 0.6, 0x8a2a22),
        box(0.3, 0.14, 0.1, 2.16, 0.72, -0.6, 0x8a2a22),
      ]),
    box: { hx: 2.2, hz: 0.95, h: 1.5, kind: "prop" },
  },

  hydrant: {
    build: () =>
      merge([
        cyl(0.16, 0.2, 0.62, 7, 0, 0.31, 0, 0x8a3229),
        cyl(0.1, 0.14, 0.16, 7, 0, 0.68, 0, 0x9b3a2f),
        box(0.42, 0.11, 0.11, 0, 0.46, 0, 0x8a3229),
      ]),
    box: { hx: 0.22, hz: 0.22, h: 0.78, kind: "prop" },
  },

  crate: {
    build: () =>
      merge([
        box(0.9, 0.72, 0.9, 0, 0.36, 0, 0x6b5636),
        box(0.94, 0.06, 0.94, 0, 0.72, 0, 0x7a6440),
        box(0.06, 0.72, 0.94, -0.45, 0.36, 0, 0x59462c),
      ]),
    box: { hx: 0.48, hz: 0.48, h: 0.75, kind: "prop" },
  },

  /** Angled cellar doors set into a wall base. Walkable, hence "step". */
  cellarDoor: {
    build: () =>
      merge([
        box(1.9, 0.14, 1.5, 0, 0.42, 0, 0x455239, 0),
        box(1.9, 0.1, 0.16, 0, 0.5, -0.72, 0x2e3728),
      ]),
    box: { hx: 1.0, hz: 0.8, h: 0.5, kind: "step" },
  },

  /** Rooftop water tank — the skyline read, visible from everywhere. */
  waterTank: {
    build: () =>
      merge([
        cyl(1.5, 1.6, 3.0, 9, 0, 3.4, 0, 0x6b5336),
        cyl(1.2, 1.6, 0.9, 9, 0, 5.3, 0, 0x5b4630),
        box(0.16, 1.9, 0.16, -1.1, 0.95, -1.1, 0x4a3b2c),
        box(0.16, 1.9, 0.16, 1.1, 0.95, -1.1, 0x4a3b2c),
        box(0.16, 1.9, 0.16, -1.1, 0.95, 1.1, 0x4a3b2c),
        box(0.16, 1.9, 0.16, 1.1, 0.95, 1.1, 0x4a3b2c),
      ]),
  },

  barrier: {
    build: () =>
      merge([
        box(2.0, 0.82, 0.46, 0, 0.41, 0, 0x8b8b86),
        box(2.06, 0.1, 0.56, 0, 0.06, 0, 0x76766f),
      ]),
    box: { hx: 1.03, hz: 0.28, h: 0.84, kind: "prop" },
  },

  /** Utility meter cluster on a wall. Pure silhouette detail. */
  meter: {
    build: () =>
      merge([
        box(0.34, 0.46, 0.22, -0.2, 0, 0, 0x6d7076),
        box(0.34, 0.46, 0.22, 0.2, 0, 0, 0x63666c),
        box(0.08, 0.9, 0.08, 0, -0.6, 0.02, 0x4b4e53),
      ]),
  },
};

/* ------------------------------------------------------------------ */

export interface PropsBuild {
  meshes: THREE.Object3D[];
  colliders: BoxCollider[];
  dispose(): void;
}

/**
 * Instantiate every placed prop. One `InstancedMesh` per kind (plus one more
 * for lamp lenses), lit per instance from the baked rig.
 */
export function createProps(
  rig: LightRig,
  placements: Partial<Record<PropKind, PropPlacement[]>>
): PropsBuild {
  const meshes: THREE.Object3D[] = [];
  const colliders: BoxCollider[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();

  for (const kind of Object.keys(placements) as PropKind[]) {
    const list = placements[kind];
    if (!list || list.length === 0) continue;
    const spec = SPECS[kind];

    const geometry = spec.build();
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.name = `prop-${kind}`;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    geometries.push(geometry);
    materials.push(material);

    let lensMesh: THREE.InstancedMesh | null = null;
    if (spec.lens) {
      const lensGeometry = spec.lens.build();
      const lensMaterial = new THREE.MeshBasicMaterial({ color: spec.lens.color, fog: true });
      lensMesh = new THREE.InstancedMesh(lensGeometry, lensMaterial, list.length);
      lensMesh.name = `prop-${kind}-lens`;
      geometries.push(lensGeometry);
      materials.push(lensMaterial);
    }

    list.forEach((placement, index) => {
      const y = placement.y ?? 0;
      const rotY = placement.rotY ?? 0;
      position.set(placement.x, y, placement.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      lensMesh?.setMatrixAt(index, matrix);

      // Sample the bake at roughly the prop's visual centre.
      const sampleY = y + (spec.box ? spec.box.h * 0.6 : 1.2);
      const light = bake(rig, placement.x, sampleY, placement.z, 0.5);
      // Props sit in the world's shadow range; lift a touch so they read.
      light.multiplyScalar(2.15);
      light.r = Math.min(1, light.r);
      light.g = Math.min(1, light.g);
      light.b = Math.min(1, light.b);
      mesh.setColorAt(index, light);

      if (spec.box) {
        // Rotate the footprint by swapping extents on quarter turns — every
        // placement in this map uses axis-aligned rotations.
        const turned = Math.abs(Math.sin(rotY)) > 0.5;
        const hx = turned ? spec.box.hz : spec.box.hx;
        const hz = turned ? spec.box.hx : spec.box.hz;
        colliders.push(
          collider(
            new THREE.Vector3(placement.x - hx, y, placement.z - hz),
            new THREE.Vector3(placement.x + hx, y + spec.box.h, placement.z + hz),
            spec.box.kind,
            kind
          )
        );
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);

    if (lensMesh) {
      lensMesh.instanceMatrix.needsUpdate = true;
      lensMesh.computeBoundingSphere();
      meshes.push(lensMesh);
    }
  }

  return {
    meshes,
    colliders,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
