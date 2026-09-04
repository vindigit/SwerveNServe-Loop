import * as THREE from "three";
import { CoronaConfig } from "@/config/gameConfig";
import type { CollisionWorld } from "@/world/CollisionWorld";

/**
 * PickupMarker
 *
 * The corona language from the reference plates (`reference/mockups/
 * corona-cash-alley.png`, `corona-weapon-fog.png`, `corona-language-weapons.png`):
 * a small item floating and turning over in the street, sitting in a soft round
 * bloom of light that reads from the far end of an alley through the fog.
 *
 * Exactly two objects at one world position:
 *
 *   1. THE MESH — a chunky low-poly item, floating at `meshFloatHeight`, turning
 *      continuously about Y and bobbing gently. Untextured; face shading is
 *      baked into vertex colours so it needs no light of its own and costs no
 *      part of the three-dynamic-light budget.
 *
 *   2. THE CORONA — ONE flat camera-facing billboard through the mesh. A radial
 *      gradient: near-white core, category colour through the body, fully
 *      transparent at the edge. Additive, unlit, no depth write, no fog.
 *
 * What this deliberately is NOT: no beam, no light column, no ground ring, no
 * particles, no sparks, no outline, no floating arrow, no world-space prompt, no
 * volumetric cone, no real PointLight. Those are all a later era's vocabulary.
 *
 * Occlusion: an additive billboard with `depthWrite: false` will happily bleed
 * around and through geometry — a corona glowing through a rowhouse ruins the
 * closed sightlines the map depends on. So the marker raycasts camera→marker
 * against the authored collision at ~8 Hz and cross-fades the corona out when a
 * wall is in the way (see OCCLUSION_HZ).
 */

export type PickupKind = "job" | "cash";

/** Occlusion sampling rate. 8 Hz is invisible to the player and near-free. */
const OCCLUSION_HZ = 8;
const OCCLUSION_INTERVAL = 1 / OCCLUSION_HZ;
/** Seconds for the corona to cross-fade in/out of occlusion — no popping. */
const OCCLUSION_FADE_SECONDS = 0.14;
/** A segment hit fraction below this counts as blocked (1 = clear line). */
const OCCLUSION_CLEAR_EPSILON = 0.995;
/** Corona texture resolution. Inside the 256 budget; it is a smooth ramp. */
const CORONA_TEXTURE_SIZE = 128;
/** Skip the corona draw call entirely once it has faded to nothing. */
const CORONA_MIN_VISIBLE_ALPHA = 0.012;
/** Don't re-upload the vertex-colour buffer for sub-perceptual alpha changes. */
const CORONA_ALPHA_UPLOAD_EPSILON = 0.004;
/** Push the billboard this far back along the view ray so it never z-fights. */
const CORONA_BACKSET = 0.12;

/* ------------------------------------------------------------------ *
 * Shared assets. Created on first use, reused by every marker, and
 * released together by disposeSharedPickupAssets().
 * ------------------------------------------------------------------ */

interface CoronaAssets {
  texture: THREE.Texture;
  material: THREE.MeshBasicMaterial;
}

interface ItemAssets {
  body: THREE.BufferGeometry;
  band: THREE.BufferGeometry;
}

const coronaAssets = new Map<PickupKind, CoronaAssets>();
const itemAssets = new Map<PickupKind, ItemAssets>();
/** One material for every pickup mesh — the colour lives in vertex colours. */
let itemMaterial: THREE.MeshBasicMaterial | null = null;
/** Staggers the occlusion probe across markers so they never all test at once. */
let markerPhaseCounter = 0;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The corona ramp, as a function of normalised radius.
 *
 *   alpha  — (1-r)² body plus a hot central core, so the glow has a bright
 *            middle and a long soft skirt instead of a hard disc.
 *   rgb    — the category colour, pushed towards white inside the core. Under
 *            additive blending that is what produces the blown-out white centre
 *            in the reference plates while the body stays saturated.
 */
function buildCoronaPixels(size: number, colorHex: number, data: Uint8Array): void {
  // Author the ramp in sRGB bytes; the texture is tagged sRGB where it is built.
  const cr = (colorHex >> 16) & 0xff;
  const cg = (colorHex >> 8) & 0xff;
  const cb = colorHex & 0xff;

  const centre = (size - 1) / 2;
  const maxR = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / maxR;
      const dy = (y - centre) / maxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;

      if (r >= 1) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        continue;
      }

      // Exponent 1.7 keeps the body saturated further out before the skirt
      // takes over — A/B'd against corona-cash-alley.png, where the coloured
      // disc is nearly solid across the middle of the glow.
      const body = Math.pow(1 - r, 1.7);
      const coreT = clamp01(1 - r / 0.3);
      const alpha = clamp01(body + 0.9 * coreT * coreT);

      // Whiteness is tight to the middle — the item sits in a white-hot pocket.
      const white = clamp01(Math.pow(clamp01(1 - r / 0.38), 1.6)) * 0.92;

      data[i] = Math.round(cr + (255 - cr) * white);
      data[i + 1] = Math.round(cg + (255 - cg) * white);
      data[i + 2] = Math.round(cb + (255 - cb) * white);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
}

/**
 * The gradient is painted into a 2D canvas where one exists (the browser), and
 * into an equivalent DataTexture where one does not (Node, unit tests, workers).
 * Both paths consume the same pixel buffer, so they are the same image.
 */
function createCoronaTexture(colorHex: number): THREE.Texture {
  const size = CORONA_TEXTURE_SIZE;
  // Backed by a concrete ArrayBuffer so it can hand itself straight to a
  // DataTexture without a cast.
  const pixels = new Uint8Array(new ArrayBuffer(size * size * 4));
  buildCoronaPixels(size, colorHex, pixels);

  let texture: THREE.Texture;
  const canvas =
    typeof document !== "undefined" && typeof document.createElement === "function"
      ? document.createElement("canvas")
      : null;
  const ctx = canvas ? canvas.getContext("2d") : null;

  if (canvas && ctx) {
    canvas.width = size;
    canvas.height = size;
    const image = ctx.createImageData(size, size);
    image.data.set(pixels);
    ctx.putImageData(image, 0, 0);
    texture = new THREE.CanvasTexture(canvas);
  } else {
    texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  }

  // Bilinear, no mipmaps: the era filtered its coronas smoothly, and a
  // nearest-filtered radial gradient reads as a blocky square, not a glow.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function getCoronaAssets(kind: PickupKind): CoronaAssets {
  const existing = coronaAssets.get(kind);
  if (existing) return existing;

  const texture = createCoronaTexture(CoronaConfig.colors[kind]);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    // White: the category colour is already baked into the ramp, and the
    // per-instance fade rides on vertex colours (see makeCoronaGeometry).
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  const assets: CoronaAssets = { texture, material };
  coronaAssets.set(kind, assets);
  return assets;
}

/**
 * Bake flat per-face shading into a box's vertex colours: bright top, mid
 * sides, dark underside. Chunky, readable at four pixels tall, and it costs
 * nothing from the real-time light budget.
 */
function paintBoxFaces(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const normals = geometry.getAttribute("normal");
  const base = new THREE.Color(hex);
  const colors = new Float32Array(normals.count * 3);

  for (let i = 0; i < normals.count; i++) {
    const ny = normals.getY(i);
    const nz = normals.getZ(i);
    let shade: number;
    if (ny > 0.5) shade = 1.0;
    else if (ny < -0.5) shade = 0.42;
    else if (Math.abs(nz) > 0.5) shade = 0.58;
    else shade = 0.72;
    colors[i * 3] = base.r * shade;
    colors[i * 3 + 1] = base.g * shade;
    colors[i * 3 + 2] = base.b * shade;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function getItemAssets(kind: PickupKind): ItemAssets {
  const existing = itemAssets.get(kind);
  if (existing) return existing;

  let assets: ItemAssets;
  if (kind === "cash") {
    // A banded brick of notes: pale block, amber band round the short axis.
    assets = {
      body: paintBoxFaces(new THREE.BoxGeometry(0.4, 0.12, 0.22), 0xdfe7cd),
      band: paintBoxFaces(new THREE.BoxGeometry(0.13, 0.135, 0.235), 0xe0a63a),
    };
  } else {
    // A courier parcel: kraft box with a tape band wrapped over the top.
    assets = {
      body: paintBoxFaces(new THREE.BoxGeometry(0.44, 0.32, 0.34), 0xb98c52),
      band: paintBoxFaces(new THREE.BoxGeometry(0.46, 0.335, 0.11), 0xd8cdb4),
    };
  }
  itemAssets.set(kind, assets);
  return assets;
}

function getItemMaterial(): THREE.MeshBasicMaterial {
  if (!itemMaterial) {
    itemMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  }
  return itemMaterial;
}

/**
 * The billboard quad. It carries a per-vertex colour so one *shared* material
 * can still fade each marker independently: under additive blending, scaling
 * RGB by k scales the light the quad adds by k — identical to fading it out,
 * but without a material clone per marker.
 */
function makeCoronaGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  return geometry;
}

/** Release every shared texture/material/geometry. Call once on teardown. */
export function disposeSharedPickupAssets(): void {
  for (const { texture, material } of coronaAssets.values()) {
    texture.dispose();
    material.dispose();
  }
  coronaAssets.clear();

  for (const { body, band } of itemAssets.values()) {
    body.dispose();
    band.dispose();
  }
  itemAssets.clear();

  itemMaterial?.dispose();
  itemMaterial = null;
}

/* ------------------------------------------------------------------ *
 * The marker itself.
 * ------------------------------------------------------------------ */

export class PickupMarker {
  readonly object3d: THREE.Group;

  private readonly collision: CollisionWorld;
  private readonly spinner: THREE.Group;
  private readonly corona: THREE.Mesh;
  private readonly coronaGeometry: THREE.BufferGeometry;
  private readonly coronaColors: THREE.BufferAttribute;

  private bobPhase: number;
  private occlusionTimer: number;
  /** Where the last occlusion probe was cast from, so a moving camera re-probes. */
  private readonly lastProbeFrom = new THREE.Vector3(Infinity, Infinity, Infinity);
  private occluded = false;
  private occlusionAlpha = 1;
  private uploadedAlpha = -1;
  private snapNextSample = true;
  private disposed = false;

  /** Scratch — the update loop must not allocate. */
  private readonly worldPos = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();

  constructor(kind: PickupKind, collision: CollisionWorld) {
    this.collision = collision;

    this.object3d = new THREE.Group();
    this.object3d.name = `pickup-marker-${kind}`;

    // --- Element 1: the item.
    const item = getItemAssets(kind);
    const material = getItemMaterial();
    this.spinner = new THREE.Group();
    this.spinner.add(new THREE.Mesh(item.body, material));
    this.spinner.add(new THREE.Mesh(item.band, material));
    this.spinner.position.y = CoronaConfig.meshFloatHeight;
    this.object3d.add(this.spinner);

    // --- Element 2: the corona.
    this.coronaGeometry = makeCoronaGeometry();
    this.coronaColors = this.coronaGeometry.getAttribute("color") as THREE.BufferAttribute;
    this.corona = new THREE.Mesh(this.coronaGeometry, getCoronaAssets(kind).material);
    this.corona.position.y = CoronaConfig.meshFloatHeight;
    this.corona.scale.setScalar(CoronaConfig.spriteWorldSize);
    this.corona.renderOrder = 2;
    this.corona.frustumCulled = true;
    this.object3d.add(this.corona);

    // Phase-offset the spin, the bob and the occlusion probe per marker so a
    // pair of markers in the same street never beat in lockstep.
    markerPhaseCounter += 1;
    this.bobPhase = markerPhaseCounter * 1.37;
    this.spinner.rotation.y = markerPhaseCounter * 0.9;
    this.occlusionTimer = (markerPhaseCounter % OCCLUSION_HZ) * (OCCLUSION_INTERVAL / OCCLUSION_HZ);
  }

  setPosition(p: THREE.Vector3): void {
    this.object3d.position.copy(p);
  }

  setVisible(v: boolean): void {
    if (this.object3d.visible === v) return;
    this.object3d.visible = v;
    // Coming back into play, resolve occlusion immediately rather than fading
    // in from whatever the state was when it was hidden.
    if (v) {
      this.snapNextSample = true;
      this.occlusionTimer = 0;
    }
  }

  isVisible(): boolean {
    return this.object3d.visible;
  }

  update(dt: number, cameraPosition: THREE.Vector3): void {
    if (this.disposed || !this.object3d.visible) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // --- Item: continuous Y spin plus a gentle bob.
    this.spinner.rotation.y += CoronaConfig.meshRotationRadPerSec * step;
    if (this.spinner.rotation.y > Math.PI * 2) this.spinner.rotation.y -= Math.PI * 2;
    this.bobPhase += CoronaConfig.meshBobRadPerSec * step;
    if (this.bobPhase > Math.PI * 2) this.bobPhase -= Math.PI * 2;
    const bob = Math.sin(this.bobPhase) * CoronaConfig.meshBobAmplitude;
    this.spinner.position.y = CoronaConfig.meshFloatHeight + bob;

    // --- Corona: sits with the item, faces the camera, backed off slightly so
    // the item stays solid in the middle of its own glow.
    this.worldPos.copy(this.object3d.position);
    this.worldPos.y += CoronaConfig.meshFloatHeight + bob;
    this.toCamera.copy(cameraPosition).sub(this.worldPos);
    const distance = this.toCamera.length();

    this.corona.position.y = CoronaConfig.meshFloatHeight + bob;
    if (distance > 1e-4) {
      this.corona.position.addScaledVector(this.toCamera, -CORONA_BACKSET / distance);
      this.corona.lookAt(cameraPosition);
    }

    // --- Occlusion probe, throttled. Only walls count: `segmentHit` skips steps
    // and props by default, so a dumpster never snuffs out a marker.
    // Throttled, but a moving camera re-probes immediately: rounding a corner
    // and waiting 150 ms for the marker to come back reads as a dropped frame,
    // not as occlusion. Static cameras still get the cheap path.
    this.occlusionTimer -= step;
    const cameraMoved = this.lastProbeFrom.distanceToSquared(cameraPosition) > 0.12;
    if (this.occlusionTimer <= 0 || cameraMoved || this.snapNextSample) {
      this.occlusionTimer = OCCLUSION_INTERVAL;
      this.lastProbeFrom.copy(cameraPosition);
      const hit = this.collision.segmentHit(cameraPosition, this.worldPos);
      this.occluded = hit < OCCLUSION_CLEAR_EPSILON;
    }

    const occlusionTarget = this.occluded ? 0 : 1;
    if (this.snapNextSample) {
      this.occlusionAlpha = occlusionTarget;
      this.snapNextSample = false;
    } else {
      const move = step / OCCLUSION_FADE_SECONDS;
      const delta = occlusionTarget - this.occlusionAlpha;
      this.occlusionAlpha += Math.abs(delta) <= move ? delta : Math.sign(delta) * move;
    }

    // --- Distance: scale conservatively so it never blooms up close, and fade
    // out well before the far plane so the fog owns the deep street.
    const scaleT = clamp01(distance / CoronaConfig.spriteFadeStart);
    const scale =
      CoronaConfig.spriteMinScale +
      (CoronaConfig.spriteMaxScale - CoronaConfig.spriteMinScale) * scaleT;
    this.corona.scale.setScalar(CoronaConfig.spriteWorldSize * scale);

    const fadeSpan = Math.max(1e-3, CoronaConfig.spriteFadeEnd - CoronaConfig.spriteFadeStart);
    const distanceAlpha = 1 - clamp01((distance - CoronaConfig.spriteFadeStart) / fadeSpan);

    const alpha = clamp01(distanceAlpha * this.occlusionAlpha);
    this.corona.visible = alpha > CORONA_MIN_VISIBLE_ALPHA;
    if (this.corona.visible && Math.abs(alpha - this.uploadedAlpha) > CORONA_ALPHA_UPLOAD_EPSILON) {
      const array = this.coronaColors.array as Float32Array;
      array.fill(alpha);
      this.coronaColors.needsUpdate = true;
      this.uploadedAlpha = alpha;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object3d.removeFromParent();
    this.object3d.clear();
    // Only the billboard quad is per-instance; everything else is shared and is
    // released by disposeSharedPickupAssets().
    this.coronaGeometry.dispose();
  }
}
