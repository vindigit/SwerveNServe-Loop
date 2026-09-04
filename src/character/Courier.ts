import * as THREE from "three";

/**
 * The courier — and every NPC, since they share this body.
 *
 * Built to the PS2 character rules in the production sheet: semi-realistic
 * proportions, smooth-shaded cylindrical limbs, a low-poly head with a painted
 * face, separate hair geometry, mitten hands, chunky shoes. ~2,100 triangles.
 *
 * Two deliberate choices:
 *
 * 1. **No lights touch it.** Materials are `MeshBasicMaterial`, and the Game
 *    tints them once per frame from the world's baked light rig. That is how
 *    the era did it, and it means the courier darkens in an alley and warms up
 *    under a sodium lamp for the cost of one colour multiply.
 *
 * 2. **Animation is stepped.** Poses are evaluated on a 12 Hz grid, not per
 *    frame. Smooth interpolation reads as modern; the stutter is the look.
 */

export interface LookPreset {
  head: number;
  shirt: number;
  pants: number;
  shoes: number;
}

/** Palettes, not meshes — variety comes from material swaps on shared bodies. */
export const LOOK_OPTIONS = {
  head: [
    { name: "Fade", skin: 0x8d5a3c, hair: 0x1a1410 },
    { name: "Cap", skin: 0x6b4028, hair: 0x24303f },
    { name: "Braids", skin: 0xa9714a, hair: 0x120e0c },
    { name: "Buzz", skin: 0xc08a62, hair: 0x2e2620 },
  ],
  shirt: [
    { name: "Sand Tee", color: 0x9c8f78 },
    { name: "Blue Thermal", color: 0x3d5875 },
    { name: "Gold Jersey", color: 0xb98a2e },
    { name: "Olive Hoodie", color: 0x4a5240 },
  ],
  pants: [
    { name: "Khaki Cargo", color: 0x8a7a5c },
    { name: "Dark Denim", color: 0x35435c },
    { name: "Grey Work", color: 0x55565a },
  ],
  shoes: [
    { name: "White Lows", color: 0xd8d5cc },
    { name: "Black Highs", color: 0x2a2a2e },
    { name: "Tan Boots", color: 0x8a6234 },
  ],
} as const;

export const LOOK_COUNTS = {
  head: LOOK_OPTIONS.head.length,
  shirt: LOOK_OPTIONS.shirt.length,
  pants: LOOK_OPTIONS.pants.length,
  shoes: LOOK_OPTIONS.shoes.length,
};

/** 12 Hz pose grid — the era's animation rate, and the reason it reads PS2. */
const ANIM_HZ = 12;

type PartName =
  | "skin"
  | "face"
  | "hair"
  | "shirt"
  | "pants"
  | "shoes"
  | "bag"
  | "parcel"
  | "parcelTape";

/** The courier root is the capsule's soles, not the model's hips. */
const TORSO_REST_Y = 1.09;

function faceTexture(skin: number): THREE.Texture {
  // 128×128 painted face: brow, eyes, nose shadow, mouth. No modelled features.
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  const base = new THREE.Color(skin);
  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, 128, 128);

  // Cheek and jaw shading, painted because the geometry has none.
  const shade = base.clone().multiplyScalar(0.72);
  ctx.fillStyle = `#${shade.getHexString()}`;
  ctx.fillRect(0, 96, 128, 32);
  ctx.fillRect(0, 0, 12, 128);
  ctx.fillRect(116, 0, 12, 128);

  // Brow.
  ctx.fillStyle = "#241a14";
  ctx.fillRect(30, 44, 24, 6);
  ctx.fillRect(74, 44, 24, 6);
  // Eyes.
  ctx.fillStyle = "#efe6d8";
  ctx.fillRect(32, 54, 20, 9);
  ctx.fillRect(76, 54, 20, 9);
  ctx.fillStyle = "#2a1d15";
  ctx.fillRect(39, 55, 7, 7);
  ctx.fillRect(83, 55, 7, 7);
  // Nose shadow + mouth.
  ctx.fillStyle = `#${shade.getHexString()}`;
  ctx.fillRect(60, 62, 8, 18);
  ctx.fillStyle = "#5c3830";
  ctx.fillRect(52, 88, 24, 5);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Joint {
  group: THREE.Group;
  restX: number;
}

export class Courier {
  readonly object3d = new THREE.Group();

  private readonly materials = new Map<PartName, THREE.MeshBasicMaterial>();
  private readonly baseColors = new Map<PartName, THREE.Color>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private faceMap: THREE.Texture | null = null;

  private readonly joints: Record<"armL" | "armR" | "legL" | "legR" | "torso" | "head", Joint>;
  private readonly bagGroup = new THREE.Group();
  private readonly parcelGroup = new THREE.Group();

  private look: LookPreset = { head: 0, shirt: 0, pants: 0, shoes: 0 };
  private animClock = 0;
  private stepped = 0;
  private carrying = false;

  constructor(look?: Partial<LookPreset>) {
    const material = (name: PartName, color: number, map?: THREE.Texture): THREE.MeshBasicMaterial => {
      const params: THREE.MeshBasicMaterialParameters = { color, fog: true };
      if (map) params.map = map;
      const m = new THREE.MeshBasicMaterial(params);
      this.materials.set(name, m);
      this.baseColors.set(name, new THREE.Color(color));
      return m;
    };

    const skinMat = material("skin", 0x8d5a3c);
    const hairMat = material("hair", 0x1a1410);
    const shirtMat = material("shirt", 0x9c8f78);
    const pantsMat = material("pants", 0x8a7a5c);
    const shoesMat = material("shoes", 0xd8d5cc);
    const bagMat = material("bag", 0x4a4038);
    const parcelMat = material("parcel", 0x8b5b32);
    const parcelTapeMat = material("parcelTape", 0xc7a36a);

    const track = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
      this.geometries.push(g);
      return g;
    };

    // --- torso: tapered box, broad clothing silhouette
    const torso = new THREE.Group();
    // With the torso at 0.92 the shoe geometry extended 0.17 m below the
    // capsule's feet and visibly sank into every pavement. This value puts the
    // bottom of both shoes exactly on the actor root at rest.
    torso.position.y = TORSO_REST_Y;
    const chest = new THREE.Mesh(track(new THREE.BoxGeometry(0.46, 0.62, 0.28)), shirtMat);
    chest.position.y = 0.31;
    const hips = new THREE.Mesh(track(new THREE.BoxGeometry(0.46, 0.24, 0.28)), pantsMat);
    hips.position.y = -0.10;
    torso.add(chest, hips);

    // --- head: low-poly block with a painted face on the front
    const head = new THREE.Group();
    head.position.y = 0.72;
    this.faceMap = faceTexture(LOOK_OPTIONS.head[0].skin);
    const skull = new THREE.Mesh(track(new THREE.BoxGeometry(0.24, 0.28, 0.24)), [
      skinMat,
      skinMat,
      skinMat,
      skinMat,
      material("face", 0xffffff, this.faceMap), // +Z face carries the texture
      skinMat,
    ]);
    skull.position.y = 0.14;
    const neck = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.08, 0.09, 6)), skinMat);
    neck.position.y = -0.02;
    // Separate hair geometry, per the character rules.
    const hair = new THREE.Mesh(track(new THREE.BoxGeometry(0.26, 0.13, 0.26)), hairMat);
    hair.position.y = 0.235;
    const hairBack = new THREE.Mesh(track(new THREE.BoxGeometry(0.25, 0.14, 0.10)), hairMat);
    hairBack.position.set(0, 0.13, -0.09);
    head.add(skull, neck, hair, hairBack);
    torso.add(head);

    // --- limbs: smooth-shaded cylinders, mitten hands, chunky shoes
    const limb = (
      radiusTop: number,
      radiusBottom: number,
      length: number,
      mat: THREE.Material
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(track(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 7)), mat);
      mesh.position.y = -length / 2;
      return mesh;
    };

    const makeArm = (side: number): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(0.27 * side, 0.54, 0);
      const upper = limb(0.078, 0.068, 0.30, shirtMat);
      const fore = new THREE.Group();
      fore.position.y = -0.30;
      fore.add(limb(0.072, 0.062, 0.28, skinMat));
      const hand = new THREE.Mesh(track(new THREE.BoxGeometry(0.10, 0.13, 0.07)), skinMat);
      hand.position.y = -0.34;
      fore.add(hand);
      g.add(upper, fore);
      return g;
    };

    const makeLeg = (side: number): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(0.13 * side, -0.20, 0);
      const thigh = limb(0.115, 0.10, 0.40, pantsMat);
      const shin = new THREE.Group();
      shin.position.y = -0.40;
      shin.add(limb(0.098, 0.082, 0.40, pantsMat));
      const shoe = new THREE.Mesh(track(new THREE.BoxGeometry(0.15, 0.10, 0.28)), shoesMat);
      shoe.position.set(0, -0.44, 0.045);
      shin.add(shoe);
      g.add(thigh, shin);
      return g;
    };

    const armL = makeArm(-1);
    const armR = makeArm(1);
    const legL = makeLeg(-1);
    const legR = makeLeg(1);
    torso.add(armL, armR, legL, legR);

    // --- courier bag, the silhouette read that says "delivery"
    const strap = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.60, 0.34)), bagMat);
    strap.position.set(0.05, 0.30, 0.0);
    strap.rotation.z = 0.32;
    const satchel = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.26, 0.16)), bagMat);
    satchel.position.set(-0.26, 0.02, -0.06);
    this.bagGroup.add(strap, satchel);
    torso.add(this.bagGroup);

    // The pickup is a real carried object, separate from the world marker.
    // It sits between the tucked forearms and follows the stepped body pose.
    const parcel = new THREE.Mesh(track(new THREE.BoxGeometry(0.42, 0.28, 0.32)), parcelMat);
    const tapeVertical = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.075, 0.286, 0.326)),
      parcelTapeMat
    );
    const tapeHorizontal = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.426, 0.075, 0.326)),
      parcelTapeMat
    );
    this.parcelGroup.position.set(0, 0.29, 0.34);
    this.parcelGroup.name = "carried-parcel";
    this.parcelGroup.add(parcel, tapeVertical, tapeHorizontal);
    this.parcelGroup.visible = false;
    torso.add(this.parcelGroup);

    this.object3d.add(torso);
    this.joints = {
      torso: { group: torso, restX: 0 },
      head: { group: head, restX: 0 },
      armL: { group: armL, restX: 0 },
      armR: { group: armR, restX: 0 },
      legL: { group: legL, restX: 0 },
      legR: { group: legR, restX: 0 },
    };

    this.setLook(look ?? {});
  }

  setLook(partial: Partial<LookPreset>): void {
    this.look = {
      head: clampIndex(partial.head ?? this.look.head, LOOK_COUNTS.head),
      shirt: clampIndex(partial.shirt ?? this.look.shirt, LOOK_COUNTS.shirt),
      pants: clampIndex(partial.pants ?? this.look.pants, LOOK_COUNTS.pants),
      shoes: clampIndex(partial.shoes ?? this.look.shoes, LOOK_COUNTS.shoes),
    };

    const head = LOOK_OPTIONS.head[this.look.head];
    this.setBase("skin", head.skin);
    this.setBase("hair", head.hair);
    this.setBase("shirt", LOOK_OPTIONS.shirt[this.look.shirt].color);
    this.setBase("pants", LOOK_OPTIONS.pants[this.look.pants].color);
    this.setBase("shoes", LOOK_OPTIONS.shoes[this.look.shoes].color);

    // Repaint the face so the skin tone on the texture matches the body.
    const old = this.faceMap;
    this.faceMap = faceTexture(head.skin);
    for (const [, material] of this.materials) {
      if (material.map === old) material.map = this.faceMap;
    }
    old?.dispose();
  }

  getLook(): LookPreset {
    return { ...this.look };
  }

  setCarrying(carrying: boolean): void {
    this.carrying = carrying;
    this.parcelGroup.visible = carrying;
    // Force the arm pose to react on the next update even within the same
    // 12 Hz animation cell as the pickup/delivery event.
    this.stepped = -1;
  }

  /**
   * `locomotion` is 0 (idle) to 1 (full sprint). The pose is evaluated on the
   * 12 Hz grid; between grid steps nothing moves, which is the point.
   */
  update(dt: number, locomotion: number, grounded: boolean, verticalSpeed = 0): void {
    const speed = THREE.MathUtils.clamp(locomotion, 0, 1);
    this.animClock += dt * (0.9 + speed * 2.6);
    const grid = Math.floor(this.animClock * ANIM_HZ);
    if (grid === this.stepped) return;
    this.stepped = grid;

    const phase = (grid / ANIM_HZ) * Math.PI * 2;
    const swing = 0.18 + speed * 0.85;
    const j = this.joints;

    if (!grounded) {
      const rising = verticalSpeed >= 0;
      j.legL.group.rotation.x = rising ? -0.52 : -0.22;
      j.legR.group.rotation.x = rising ? 0.34 : 0.5;
      j.armL.group.rotation.x = this.carrying ? -1.25 : rising ? -1.0 : -0.62;
      j.armR.group.rotation.x = this.carrying ? -1.25 : rising ? -1.0 : -0.62;
      j.armL.group.rotation.z = this.carrying ? 0.42 : 0.14;
      j.armR.group.rotation.z = this.carrying ? -0.42 : -0.14;
      j.torso.group.rotation.x = rising ? 0.08 : -0.04;
      j.torso.group.position.y = TORSO_REST_Y;
      return;
    }

    j.legL.group.rotation.x = Math.sin(phase) * swing;
    j.legR.group.rotation.x = Math.sin(phase + Math.PI) * swing;

    if (this.carrying) {
      // Package held to the chest — arms tucked, torso leans in a little.
      j.armL.group.rotation.x = -1.25 + Math.sin(phase) * 0.08 * speed;
      j.armR.group.rotation.x = -1.25 + Math.sin(phase + Math.PI) * 0.08 * speed;
      j.armL.group.rotation.z = 0.42;
      j.armR.group.rotation.z = -0.42;
    } else {
      j.armL.group.rotation.x = Math.sin(phase + Math.PI) * swing * 0.85;
      j.armR.group.rotation.x = Math.sin(phase) * swing * 0.85;
      j.armL.group.rotation.z = 0.06 + speed * 0.12;
      j.armR.group.rotation.z = -0.06 - speed * 0.12;
    }

    // Lean into a sprint, and bob on the stride — stiff, not smooth.
    j.torso.group.rotation.x = speed * 0.22;
    j.torso.group.position.y = TORSO_REST_Y + Math.abs(Math.sin(phase)) * 0.035 * speed;
    j.head.group.rotation.x = -speed * 0.16;
  }

  /**
   * Tint every material by the sampled world light. One multiply per material
   * per frame — this is the whole character lighting model.
   */
  applyLight(sample: THREE.Color): void {
    for (const [name, material] of this.materials) {
      const base = this.baseColors.get(name);
      if (!base) continue;
      material.color.copy(base).multiply(sample);
    }
  }

  private setBase(name: PartName, hex: number): void {
    const base = this.baseColors.get(name);
    if (base) base.setHex(hex);
    // The textured face material shares the "skin" key; leave its white base.
    const material = this.materials.get(name);
    if (material && !material.map) material.color.setHex(hex);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const [, material] of this.materials) material.dispose();
    this.faceMap?.dispose();
    this.object3d.clear();
  }
}

function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(value)));
}
