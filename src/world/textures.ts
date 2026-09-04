import * as THREE from "three";
import { RenderConfig } from "@/config/gameConfig";
import { Rng } from "@/core/rng";

/**
 * Procedural PS2-era texture set.
 *
 * Everything the neighbourhood is skinned with is painted here into a canvas at
 * 256x256 (128x128 for props), with nearest magnification so the pixels stay
 * chunky under the 540p internal buffer. There are no image files and no
 * lettering — signage is abstract colour blocks, per the aesthetic pledge.
 *
 * ONE CONVENTION MATTERS, and everything downstream depends on it:
 *
 *   Every albedo texture is painted around a mid-tone of roughly sRGB 0x78.
 *   Hue lives in the texture; *luminance lives in the baked vertex colour*.
 *
 * That is what lets `props.ts` treat a vertex colour of 1.0 as "fully lit to the
 * texture's own brightness" and drive the whole night look — near-black troughs,
 * warm sodium pools — from baked light alone, with zero dynamic lights. Paint a
 * texture dark here and it will read as unlit mud no matter what the lighting
 * does, so keep the mid-tone up and let the bake take it down.
 */

/** Nominal metres covered by one tile of each repeating surface texture. */
export const TILE_METRES = {
  brick: 2,
  concrete: 2,
  pavement: 2,
  asphalt: 6,
  gravel: 2,
  siding: 2,
  metal: 1,
} as const;

export interface TextureSet {
  brick: THREE.Texture;
  concrete: THREE.Texture;
  pavement: THREE.Texture;
  asphalt: THREE.Texture;
  gravel: THREE.Texture;
  siding: THREE.Texture;
  metal: THREE.Texture;
  /** 4x4 atlas: windows lit/unlit, doors, shutters, storefront glass, vents. */
  windows: THREE.Texture;
  /** 4x4 atlas: awnings, abstract signage, road paint, hazard stripes. */
  signs: THREE.Texture;
  /** Alpha chain-link, tiles 2 m. */
  chainLink: THREE.Texture;
  /** Radial falloff for lamp glows and ground pools. */
  glow: THREE.Texture;
  /** Soft wet blotch for puddles. */
  puddle: THREE.Texture;
  /** Equirect-ish purple-navy night sky with cloud banding. */
  sky: THREE.Texture;
}

const BIG = RenderConfig.maxTextureSize; // 256
const SMALL = RenderConfig.propTextureSize; // 128

/* ------------------------------------------------------------------ */
/* canvas helpers                                                       */
/* ------------------------------------------------------------------ */

interface Pad {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function pad(w: number, h = w): Pad {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx, w, h };
}

function fill(p: Pad, css: string): void {
  p.ctx.fillStyle = css;
  p.ctx.fillRect(0, 0, p.w, p.h);
}

/** rgb() string from 0-255 components, clamped. */
function rgb(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function rgba(r: number, g: number, b: number, a: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgba(${c(r)},${c(g)},${c(b)},${a.toFixed(3)})`;
}

/** Uniform value noise, drawn as 1px dots. Cheap grain that survives nearest. */
function speckle(p: Pad, rng: Rng, count: number, lo: number, hi: number, alpha = 0.5): void {
  for (let i = 0; i < count; i++) {
    const v = lo + rng.next() * (hi - lo);
    p.ctx.fillStyle = rgba(v, v, v, alpha);
    p.ctx.fillRect(rng.int(p.w), rng.int(p.h), 1, 1);
  }
}

/**
 * Grime: a handful of soft dark blobs that wrap across the tile seam, so a wall
 * tiled eight times across does not read as eight identical stamps.
 */
function grime(p: Pad, rng: Rng, count: number, radius: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const cx = rng.next() * p.w;
    const cy = rng.next() * p.h;
    const r = radius * (0.5 + rng.next());
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const g = p.ctx.createRadialGradient(cx + dx * p.w, cy + dy * p.h, 0, cx + dx * p.w, cy + dy * p.h, r);
        g.addColorStop(0, rgba(20, 18, 22, alpha));
        g.addColorStop(1, rgba(20, 18, 22, 0));
        p.ctx.fillStyle = g;
        p.ctx.fillRect(cx + dx * p.w - r, cy + dy * p.h - r, r * 2, r * 2);
      }
    }
  }
}

/** Vertical rain-streak stains — the single most "grimy brick" cue there is. */
function streaks(p: Pad, rng: Rng, count: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = rng.int(p.w);
    const w = 1 + rng.int(3);
    const top = rng.int(p.h);
    const len = 20 + rng.int(p.h);
    const g = p.ctx.createLinearGradient(0, top, 0, top + len);
    g.addColorStop(0, rgba(28, 24, 26, alpha));
    g.addColorStop(1, rgba(28, 24, 26, 0));
    p.ctx.fillStyle = g;
    p.ctx.fillRect(x, top, w, len);
    if (top + len > p.h) p.ctx.fillRect(x, top - p.h, w, len);
  }
}

/* ------------------------------------------------------------------ */
/* surface painters                                                     */
/* ------------------------------------------------------------------ */

function paintBrick(): HTMLCanvasElement {
  const p = pad(BIG);
  const rng = new Rng(0x8a11);
  fill(p, rgb(96, 90, 84)); // mortar
  const rows = 26;
  const rh = p.h / rows;
  const bw = p.w / 9;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * bw * 0.5;
    for (let c = -1; c < 10; c++) {
      const x = c * bw + offset;
      const y = r * rh;
      // Brick body: warm brown-red around 0x8a5a48, jittered per brick.
      const t = rng.next();
      const rr = 128 + t * 34 - 12;
      const gg = 84 + t * 20 - 6;
      const bb = 68 + t * 16 - 6;
      const cool = rng.next() < 0.12 ? 0.72 : 1; // occasional grey/burnt header
      p.ctx.fillStyle = rgb(rr * cool, gg * cool * 1.05, bb * cool * 1.1);
      p.ctx.fillRect(Math.round(x) + 1, Math.round(y) + 1, Math.round(bw) - 1, Math.round(rh) - 1);
    }
  }
  streaks(p, rng, 22, 0.4);
  grime(p, rng, 7, 46, 0.34);
  speckle(p, rng, 2600, 40, 190, 0.16);
  return p.canvas;
}

function paintConcrete(): HTMLCanvasElement {
  const p = pad(BIG);
  const rng = new Rng(0x3c07);
  fill(p, rgb(126, 124, 118));
  // Patchy pours.
  for (let i = 0; i < 26; i++) {
    const v = 108 + rng.next() * 30;
    p.ctx.fillStyle = rgba(v, v - 2, v - 6, 0.28);
    p.ctx.fillRect(rng.int(p.w), rng.int(p.h), 20 + rng.int(70), 16 + rng.int(60));
  }
  // Hairline cracks.
  p.ctx.strokeStyle = rgba(60, 58, 56, 0.55);
  p.ctx.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    let x = rng.int(p.w);
    let y = rng.int(p.h);
    p.ctx.beginPath();
    p.ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += rng.next() * 40 - 20;
      y += rng.next() * 40 - 20;
      p.ctx.lineTo(x, y);
    }
    p.ctx.stroke();
  }
  grime(p, rng, 6, 52, 0.3);
  speckle(p, rng, 3200, 60, 200, 0.14);
  return p.canvas;
}

function paintPavement(): HTMLCanvasElement {
  const p = pad(BIG);
  const rng = new Rng(0x5d21);
  fill(p, rgb(70, 70, 74)); // joint
  const cells = 2; // 1 m slabs over a 2 m tile
  const s = p.w / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const v = 118 + rng.next() * 22;
      p.ctx.fillStyle = rgb(v, v + 1, v + 5);
      p.ctx.fillRect(cx * s + 2, cy * s + 2, s - 4, s - 4);
      // A worn corner on some slabs.
      if (rng.next() < 0.5) {
        p.ctx.fillStyle = rgba(84, 84, 88, 0.5);
        p.ctx.fillRect(cx * s + 2, cy * s + 2 + (rng.int(2) ? 0 : s - 26), s - 4, 24);
      }
    }
  }
  grime(p, rng, 8, 44, 0.32);
  speckle(p, rng, 3600, 50, 200, 0.16);
  return p.canvas;
}

function paintAsphalt(): HTMLCanvasElement {
  const p = pad(BIG);
  const rng = new Rng(0x2f93);
  fill(p, rgb(122, 125, 132));
  speckle(p, rng, 15000, 70, 190, 0.30);
  // Repair patches — darker rectangles with ragged tar edges.
  for (let i = 0; i < 7; i++) {
    const x = rng.int(p.w);
    const y = rng.int(p.h);
    const w = 30 + rng.int(90);
    const h = 24 + rng.int(70);
    p.ctx.fillStyle = rgba(88, 90, 96, 0.24);
    p.ctx.fillRect(x, y, w, h);
    p.ctx.strokeStyle = rgba(56, 56, 62, 0.26);
    p.ctx.lineWidth = 2;
    p.ctx.strokeRect(x, y, w, h);
  }
  // Tar seams: two per tile, running roughly with the road and only just
  // darker than the surface. Anything stronger tiles into visible scribble.
  p.ctx.strokeStyle = rgba(60, 60, 66, 0.22);
  p.ctx.lineWidth = 2;
  for (let i = 0; i < 2; i++) {
    const horizontal = rng.int(2) === 0;
    let x = horizontal ? 0 : rng.int(p.w);
    let y = horizontal ? rng.int(p.h) : 0;
    p.ctx.beginPath();
    p.ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      if (horizontal) {
        x += p.w / 8;
        y += rng.next() * 10 - 5;
      } else {
        y += p.h / 8;
        x += rng.next() * 10 - 5;
      }
      p.ctx.lineTo(x, y);
    }
    p.ctx.stroke();
  }
  grime(p, rng, 6, 70, 0.26);
  return p.canvas;
}

function paintGravel(): HTMLCanvasElement {
  const p = pad(SMALL);
  const rng = new Rng(0x71bd);
  fill(p, rgb(116, 112, 102));
  for (let i = 0; i < 5200; i++) {
    const v = 78 + rng.next() * 90;
    p.ctx.fillStyle = rgba(v, v - 4, v - 12, 0.55);
    p.ctx.fillRect(rng.int(p.w), rng.int(p.h), 1 + rng.int(2), 1 + rng.int(2));
  }
  // Weed clumps — the vacant-lot tell.
  for (let i = 0; i < 22; i++) {
    p.ctx.fillStyle = rgba(96, 116, 74, 0.5);
    p.ctx.fillRect(rng.int(p.w), rng.int(p.h), 2 + rng.int(4), 2 + rng.int(4));
  }
  grime(p, rng, 5, 30, 0.3);
  return p.canvas;
}

function paintSiding(): HTMLCanvasElement {
  const p = pad(BIG);
  const rng = new Rng(0x1ee4);
  fill(p, rgb(120, 118, 108));
  const boards = 11; // ~0.18 m clapboards over a 2 m tile
  const bh = p.h / boards;
  for (let i = 0; i < boards; i++) {
    const v = 104 + rng.next() * 34;
    p.ctx.fillStyle = rgb(v, v * 0.98, v * 0.9);
    p.ctx.fillRect(0, i * bh, p.w, bh - 1);
    p.ctx.fillStyle = rgba(52, 48, 44, 0.65);
    p.ctx.fillRect(0, (i + 1) * bh - 2, p.w, 2);
  }
  streaks(p, rng, 14, 0.32);
  grime(p, rng, 6, 42, 0.34);
  speckle(p, rng, 2200, 60, 190, 0.14);
  return p.canvas;
}

function paintMetal(): HTMLCanvasElement {
  const p = pad(SMALL);
  const rng = new Rng(0x66a2);
  fill(p, rgb(118, 122, 126));
  // Corrugation: vertical ribs, so a rotated quad gives horizontal ribs too.
  const ribs = 16;
  const rw = p.w / ribs;
  for (let i = 0; i < ribs; i++) {
    const g = p.ctx.createLinearGradient(i * rw, 0, (i + 1) * rw, 0);
    g.addColorStop(0, rgba(70, 74, 80, 0.75));
    g.addColorStop(0.45, rgba(180, 184, 190, 0.35));
    g.addColorStop(1, rgba(70, 74, 80, 0.75));
    p.ctx.fillStyle = g;
    p.ctx.fillRect(i * rw, 0, rw, p.h);
  }
  // Rust runs.
  for (let i = 0; i < 16; i++) {
    const x = rng.int(p.w);
    const y = rng.int(p.h);
    const g = p.ctx.createLinearGradient(0, y, 0, y + 30);
    g.addColorStop(0, rgba(150, 86, 44, 0.55));
    g.addColorStop(1, rgba(150, 86, 44, 0));
    p.ctx.fillStyle = g;
    p.ctx.fillRect(x, y, 2 + rng.int(4), 30);
  }
  grime(p, rng, 5, 26, 0.3);
  speckle(p, rng, 1400, 60, 200, 0.16);
  return p.canvas;
}

/* ------------------------------------------------------------------ */
/* atlases                                                              */
/* ------------------------------------------------------------------ */

/**
 * Window / door atlas, 4x4 cells of 64px.
 *
 * col,row (row 0 = top of the canvas):
 *   0,0 dark window   1,0 warm curtain   2,0 warm blinds    3,0 cold TV glow
 *   0,1 boarded       1,1 grimy dark     2,1 warm dim       3,1 half-lit sash
 *   0,2 steel door    1,2 green door     2,2 wood+glass     3,2 roll shutter
 *   0,3 shop glass A  1,3 shop glass B   2,3 laundry glass  3,3 vent grille
 */
function paintWindowAtlas(): HTMLCanvasElement {
  const p = pad(BIG);
  const rng = new Rng(0x4b19);
  const s = BIG / 4;
  fill(p, rgb(24, 24, 28));

  const frame = (cx: number, cy: number, col: string) => {
    p.ctx.fillStyle = col;
    p.ctx.fillRect(cx, cy, s, s);
  };
  const sash = (cx: number, cy: number, col: string) => {
    p.ctx.fillStyle = col;
    p.ctx.fillRect(cx + 6, cy + 4, s - 12, 3);
    p.ctx.fillRect(cx + 6, cy + s - 8, s - 12, 3);
    p.ctx.fillRect(cx + 6, cy + s / 2 - 2, s - 12, 4);
    p.ctx.fillRect(cx + 6, cy + 4, 3, s - 10);
    p.ctx.fillRect(cx + s - 9, cy + 4, 3, s - 10);
  };
  const dirt = (cx: number, cy: number, n: number) => {
    for (let i = 0; i < n; i++) {
      p.ctx.fillStyle = rgba(30, 30, 34, 0.25 + rng.next() * 0.3);
      p.ctx.fillRect(cx + rng.int(s), cy + rng.int(s), 2 + rng.int(8), 2 + rng.int(10));
    }
  };

  const cell = (col: number, row: number) => ({ x: col * s, y: row * s });

  // --- row 0: windows -----------------------------------------------------
  let c = cell(0, 0);
  frame(c.x, c.y, rgb(38, 42, 52));
  dirt(c.x, c.y, 14);
  sash(c.x, c.y, rgb(88, 84, 78));

  c = cell(1, 0); // warm curtain
  frame(c.x, c.y, rgb(150, 108, 62));
  p.ctx.fillStyle = rgba(198, 158, 96, 0.85);
  for (let i = 0; i < 7; i++) p.ctx.fillRect(c.x + 8 + i * 7, c.y + 8, 4, s - 18);
  sash(c.x, c.y, rgb(96, 88, 76));

  c = cell(2, 0); // warm blinds
  frame(c.x, c.y, rgb(162, 118, 66));
  p.ctx.fillStyle = rgba(70, 52, 34, 0.75);
  for (let i = 0; i < 9; i++) p.ctx.fillRect(c.x + 6, c.y + 8 + i * 6, s - 12, 2);
  sash(c.x, c.y, rgb(96, 88, 76));

  c = cell(3, 0); // cold TV flicker
  frame(c.x, c.y, rgb(96, 122, 150));
  p.ctx.fillStyle = rgba(150, 178, 206, 0.7);
  p.ctx.fillRect(c.x + 14, c.y + 18, s - 30, s - 40);
  sash(c.x, c.y, rgb(80, 78, 74));

  // --- row 1 --------------------------------------------------------------
  c = cell(0, 1); // boarded
  frame(c.x, c.y, rgb(112, 96, 74));
  p.ctx.fillStyle = rgba(76, 64, 50, 0.8);
  for (let i = 0; i < 4; i++) p.ctx.fillRect(c.x + 4, c.y + 8 + i * 13, s - 8, 10);
  sash(c.x, c.y, rgb(86, 80, 72));

  c = cell(1, 1); // grimy dark
  frame(c.x, c.y, rgb(46, 48, 54));
  dirt(c.x, c.y, 22);
  sash(c.x, c.y, rgb(78, 74, 70));

  c = cell(2, 1); // warm dim
  frame(c.x, c.y, rgb(112, 84, 54));
  dirt(c.x, c.y, 10);
  sash(c.x, c.y, rgb(90, 84, 74));

  c = cell(3, 1); // half-lit sash
  frame(c.x, c.y, rgb(44, 48, 58));
  p.ctx.fillStyle = rgb(168, 124, 70);
  p.ctx.fillRect(c.x + 6, c.y + 6, s - 12, s / 2 - 8);
  sash(c.x, c.y, rgb(92, 86, 78));

  // --- row 2: doors -------------------------------------------------------
  c = cell(0, 2); // steel
  frame(c.x, c.y, rgb(104, 108, 112));
  p.ctx.fillStyle = rgba(70, 74, 78, 0.8);
  p.ctx.fillRect(c.x + 8, c.y + 8, s - 16, s - 16);
  p.ctx.fillStyle = rgb(146, 148, 150);
  p.ctx.fillRect(c.x + s - 20, c.y + s / 2, 6, 3);

  c = cell(1, 2); // green painted
  frame(c.x, c.y, rgb(88, 120, 82));
  p.ctx.fillStyle = rgba(58, 84, 56, 0.85);
  p.ctx.fillRect(c.x + 8, c.y + 10, s / 2 - 12, s / 2 - 14);
  p.ctx.fillRect(c.x + s / 2 + 4, c.y + 10, s / 2 - 12, s / 2 - 14);
  p.ctx.fillRect(c.x + 8, c.y + s / 2 + 6, s - 16, s / 2 - 16);
  p.ctx.fillStyle = rgb(170, 168, 150);
  p.ctx.fillRect(c.x + s - 18, c.y + s / 2 - 2, 5, 4);

  c = cell(2, 2); // wood with glass
  frame(c.x, c.y, rgb(126, 96, 66));
  p.ctx.fillStyle = rgb(60, 70, 84);
  p.ctx.fillRect(c.x + 12, c.y + 8, s - 24, s / 2 - 12);
  p.ctx.fillStyle = rgba(86, 66, 46, 0.9);
  p.ctx.fillRect(c.x + 10, c.y + s / 2 + 2, s - 20, s / 2 - 12);

  c = cell(3, 2); // roll shutter
  frame(c.x, c.y, rgb(112, 114, 110));
  for (let i = 0; i < 12; i++) {
    p.ctx.fillStyle = i % 2 ? rgba(78, 80, 78, 0.85) : rgba(140, 142, 138, 0.7);
    p.ctx.fillRect(c.x, c.y + i * 5 + 2, s, 4);
  }
  dirt(c.x, c.y, 8);

  // --- row 3: storefront glass / vents ------------------------------------
  c = cell(0, 3); // bright shop glass with stacked colour blocks (goods)
  frame(c.x, c.y, rgb(206, 168, 104));
  for (let i = 0; i < 16; i++) {
    const hue = [rgb(198, 90, 60), rgb(210, 176, 70), rgb(120, 156, 96), rgb(190, 190, 180)][rng.int(4)];
    p.ctx.fillStyle = hue;
    p.ctx.fillRect(c.x + 6 + rng.int(s - 20), c.y + 8 + rng.int(s - 24), 5 + rng.int(9), 4 + rng.int(7));
  }
  p.ctx.fillStyle = rgba(60, 52, 40, 0.8);
  p.ctx.fillRect(c.x + s / 2 - 2, c.y, 4, s);

  c = cell(1, 3); // shop glass B — cooler, emptier
  frame(c.x, c.y, rgb(188, 156, 100));
  for (let i = 0; i < 8; i++) {
    p.ctx.fillStyle = rgba(120, 96, 60, 0.7);
    p.ctx.fillRect(c.x + 6, c.y + 10 + i * 7, s - 12, 3);
  }
  p.ctx.fillStyle = rgba(60, 52, 40, 0.8);
  p.ctx.fillRect(c.x, c.y + s - 8, s, 8);

  c = cell(2, 3); // laundromat glass — dim green-blue fluorescent
  frame(c.x, c.y, rgb(120, 148, 128));
  p.ctx.fillStyle = rgba(78, 104, 96, 0.8);
  for (let i = 0; i < 3; i++) p.ctx.fillRect(c.x + 8 + i * 16, c.y + 24, 12, 26);
  p.ctx.fillStyle = rgba(178, 202, 176, 0.6);
  p.ctx.fillRect(c.x + 4, c.y + 6, s - 8, 6);
  dirt(c.x, c.y, 10);

  c = cell(3, 3); // vent grille
  frame(c.x, c.y, rgb(104, 104, 100));
  for (let i = 0; i < 10; i++) {
    p.ctx.fillStyle = rgba(52, 52, 50, 0.85);
    p.ctx.fillRect(c.x + 6, c.y + 6 + i * 6, s - 12, 3);
  }
  dirt(c.x, c.y, 8);

  return p.canvas;
}

/**
 * Signage / paint atlas, 4x4 cells of 32px (128 canvas).
 *   0,0 awning stripe (red/cream)   1,0 awning stripe (green/cream)
 *   2,0 abstract sign, warm blocks  3,0 abstract sign, cool blocks
 *   0,1 road paint, worn white      1,1 road paint, worn yellow
 *   2,1 hazard stripe               3,1 painted wall band (fascia tile)
 *   0,2 cornice/stone band          1,2 tar roof
 *   2,2 dark steel plate            3,2 timber plank
 *   0,3 kerb stone                  1,3 dirt/rubble
 *   2,3 flat black (unused filler)  3,3 grate
 */
function paintSignAtlas(): HTMLCanvasElement {
  const p = pad(SMALL);
  const rng = new Rng(0x9c37);
  const s = SMALL / 4;
  fill(p, rgb(40, 40, 44));
  const at = (col: number, row: number) => ({ x: col * s, y: row * s });

  const stripes = (x: number, y: number, a: string, b: string) => {
    for (let i = 0; i < 8; i++) {
      p.ctx.fillStyle = i % 2 ? a : b;
      p.ctx.fillRect(x + i * 4, y, 4, s);
    }
  };

  let c = at(0, 0);
  stripes(c.x, c.y, rgb(168, 72, 60), rgb(196, 186, 164));
  c = at(1, 0);
  stripes(c.x, c.y, rgb(78, 118, 84), rgb(196, 186, 164));

  c = at(2, 0); // abstract warm sign: colour blocks only, never lettering
  p.ctx.fillStyle = rgb(178, 62, 46);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 9; i++) {
    p.ctx.fillStyle = [rgb(226, 196, 120), rgb(210, 152, 60), rgb(240, 226, 190)][rng.int(3)];
    p.ctx.fillRect(c.x + 3 + rng.int(s - 12), c.y + 6 + rng.int(s - 16), 3 + rng.int(7), 3 + rng.int(4));
  }

  c = at(3, 0); // abstract cool sign
  p.ctx.fillStyle = rgb(46, 66, 120);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 8; i++) {
    p.ctx.fillStyle = [rgb(190, 206, 226), rgb(124, 160, 200)][rng.int(2)];
    p.ctx.fillRect(c.x + 3 + rng.int(s - 12), c.y + 6 + rng.int(s - 16), 3 + rng.int(8), 3 + rng.int(4));
  }

  c = at(0, 1); // worn white road paint
  p.ctx.fillStyle = rgb(178, 178, 172);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 40; i++) {
    p.ctx.fillStyle = rgba(96, 98, 104, 0.5 + rng.next() * 0.4);
    p.ctx.fillRect(c.x + rng.int(s), c.y + rng.int(s), 1 + rng.int(3), 1 + rng.int(3));
  }

  c = at(1, 1); // worn yellow road paint
  p.ctx.fillStyle = rgb(184, 158, 78);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 44; i++) {
    p.ctx.fillStyle = rgba(100, 96, 84, 0.5 + rng.next() * 0.4);
    p.ctx.fillRect(c.x + rng.int(s), c.y + rng.int(s), 1 + rng.int(3), 1 + rng.int(3));
  }

  c = at(2, 1); // hazard stripe
  for (let i = 0; i < 8; i++) {
    p.ctx.fillStyle = i % 2 ? rgb(196, 160, 52) : rgb(48, 46, 44);
    p.ctx.fillRect(c.x + i * 4, c.y, 4, s);
  }

  c = at(3, 1); // painted fascia band, glazed-tile green (Warriors storefronts)
  p.ctx.fillStyle = rgb(74, 106, 84);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      p.ctx.fillStyle = rgba(40, 62, 48, 0.5 + rng.next() * 0.3);
      p.ctx.fillRect(c.x + i * 8, c.y + j * 8, 8, 1);
      p.ctx.fillRect(c.x + i * 8, c.y + j * 8, 1, 8);
    }

  c = at(0, 2); // cornice / cut stone band
  p.ctx.fillStyle = rgb(136, 132, 124);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 4; i++) {
    p.ctx.fillStyle = rgba(88, 86, 82, 0.7);
    p.ctx.fillRect(c.x, c.y + i * 8 + 7, s, 1);
  }

  c = at(1, 2); // tar roof
  p.ctx.fillStyle = rgb(92, 92, 96);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 60; i++) {
    p.ctx.fillStyle = rgba(60, 60, 66, 0.5);
    p.ctx.fillRect(c.x + rng.int(s), c.y + rng.int(s), 1 + rng.int(3), 1 + rng.int(3));
  }

  c = at(2, 2); // dark steel plate (viaduct girders)
  p.ctx.fillStyle = rgb(104, 100, 96);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 5; i++) {
    p.ctx.fillStyle = rgba(150, 108, 66, 0.35);
    p.ctx.fillRect(c.x + rng.int(s), c.y + rng.int(s), 3 + rng.int(8), 2 + rng.int(6));
  }
  p.ctx.fillStyle = rgba(60, 58, 56, 0.8);
  p.ctx.fillRect(c.x, c.y + s - 2, s, 2);

  c = at(3, 2); // timber plank
  p.ctx.fillStyle = rgb(128, 104, 76);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 6; i++) {
    p.ctx.fillStyle = rgba(84, 66, 48, 0.55);
    p.ctx.fillRect(c.x, c.y + i * 6 + 4, s, 1);
  }

  c = at(0, 3); // kerb stone
  p.ctx.fillStyle = rgb(132, 130, 126);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 30; i++) {
    p.ctx.fillStyle = rgba(96, 94, 92, 0.5);
    p.ctx.fillRect(c.x + rng.int(s), c.y + rng.int(s), 1 + rng.int(3), 1 + rng.int(2));
  }

  c = at(1, 3); // dirt / rubble
  p.ctx.fillStyle = rgb(110, 100, 88);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 90; i++) {
    const v = 70 + rng.next() * 70;
    p.ctx.fillStyle = rgba(v, v - 8, v - 18, 0.6);
    p.ctx.fillRect(c.x + rng.int(s), c.y + rng.int(s), 1 + rng.int(3), 1 + rng.int(3));
  }

  c = at(2, 3); // plain mid grey, used where a surface wants no pattern at all
  p.ctx.fillStyle = rgb(118, 118, 120);
  p.ctx.fillRect(c.x, c.y, s, s);

  c = at(3, 3); // grate
  p.ctx.fillStyle = rgb(70, 70, 74);
  p.ctx.fillRect(c.x, c.y, s, s);
  for (let i = 0; i < 7; i++) {
    p.ctx.fillStyle = rgb(128, 128, 130);
    p.ctx.fillRect(c.x + 2, c.y + 2 + i * 4, s - 4, 2);
  }

  return p.canvas;
}

function paintChainLink(): HTMLCanvasElement {
  const p = pad(SMALL);
  p.ctx.clearRect(0, 0, p.w, p.h);
  const cell = 16;
  p.ctx.lineWidth = 2.4;
  p.ctx.lineCap = "butt";
  for (let i = -1; i <= p.w / cell + 1; i++) {
    p.ctx.strokeStyle = rgba(150, 152, 150, 0.95);
    p.ctx.beginPath();
    p.ctx.moveTo(i * cell, 0);
    p.ctx.lineTo(i * cell + p.h, p.h);
    p.ctx.stroke();
    p.ctx.strokeStyle = rgba(112, 114, 112, 0.95);
    p.ctx.beginPath();
    p.ctx.moveTo(i * cell, 0);
    p.ctx.lineTo(i * cell - p.h, p.h);
    p.ctx.stroke();
  }
  return p.canvas;
}

function paintGlow(): HTMLCanvasElement {
  const p = pad(64);
  p.ctx.clearRect(0, 0, p.w, p.h);
  const g = p.ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.22, "rgba(255,236,200,0.72)");
  g.addColorStop(0.55, "rgba(255,214,150,0.24)");
  g.addColorStop(1.0, "rgba(255,200,120,0)");
  p.ctx.fillStyle = g;
  p.ctx.fillRect(0, 0, 64, 64);
  return p.canvas;
}

function paintPuddle(): HTMLCanvasElement {
  const p = pad(SMALL);
  const rng = new Rng(0x2211);
  p.ctx.clearRect(0, 0, p.w, p.h);
  // Irregular blotch built from overlapping soft discs, so no two puddles read
  // as the same stamp once they are scaled differently.
  for (let i = 0; i < 9; i++) {
    const cx = 40 + rng.next() * 48;
    const cy = 40 + rng.next() * 48;
    const r = 18 + rng.next() * 26;
    const g = p.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(190,206,232,0.62)");
    g.addColorStop(0.6, "rgba(140,160,196,0.34)");
    g.addColorStop(1, "rgba(120,140,180,0)");
    p.ctx.fillStyle = g;
    p.ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  return p.canvas;
}

function paintSky(): HTMLCanvasElement {
  const p = pad(BIG, 128);
  const rng = new Rng(0x77e1);
  // Bottom of the canvas is the horizon once mapped onto a sphere with flipY.
  const g = p.ctx.createLinearGradient(0, 0, 0, p.h);
  g.addColorStop(0.0, rgb(16, 17, 40)); // zenith
  g.addColorStop(0.55, rgb(29, 25, 58));
  g.addColorStop(0.85, rgb(46, 36, 70)); // sodium haze lifting off the city
  g.addColorStop(1.0, rgb(58, 44, 74));
  p.ctx.fillStyle = g;
  p.ctx.fillRect(0, 0, p.w, p.h);
  // Cloud banding — soft horizontal smears, purple over navy.
  for (let i = 0; i < 26; i++) {
    const y = rng.next() * p.h;
    const h = 4 + rng.next() * 18;
    const x = rng.next() * p.w;
    const w = 40 + rng.next() * 150;
    const cg = p.ctx.createLinearGradient(x, 0, x + w, 0);
    const a = 0.05 + rng.next() * 0.12;
    cg.addColorStop(0, rgba(70, 56, 96, 0));
    cg.addColorStop(0.5, rgba(70, 56, 96, a));
    cg.addColorStop(1, rgba(70, 56, 96, 0));
    p.ctx.fillStyle = cg;
    p.ctx.fillRect(x, y, w, h);
    if (x + w > p.w) p.ctx.fillRect(x - p.w, y, w, h);
  }
  return p.canvas;
}

/* ------------------------------------------------------------------ */
/* assembly                                                             */
/* ------------------------------------------------------------------ */

function tiling(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  // Nearest magnification is the whole PS2 read. Minification keeps mipmaps:
  // a 220 m street of nearest-minified asphalt is a shimmering noise field, not
  // texture crawl, and it fights the fog rather than helping it.
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function atlas(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  // No mipmaps: a mip chain bleeds neighbouring cells together and a lit window
  // starts leaking into the dark one beside it.
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function soft(canvas: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Build the whole set. Called once per neighbourhood build. */
export function createTextures(): TextureSet {
  return {
    brick: tiling(paintBrick()),
    concrete: tiling(paintConcrete()),
    pavement: tiling(paintPavement()),
    asphalt: tiling(paintAsphalt()),
    gravel: tiling(paintGravel()),
    siding: tiling(paintSiding()),
    metal: tiling(paintMetal()),
    windows: atlas(paintWindowAtlas()),
    signs: atlas(paintSignAtlas()),
    chainLink: soft(paintChainLink(), true),
    glow: soft(paintGlow(), false),
    puddle: soft(paintPuddle(), false),
    sky: soft(paintSky(), true),
  };
}

export function disposeTextures(set: TextureSet): void {
  for (const key of Object.keys(set) as (keyof TextureSet)[]) set[key].dispose();
}

/**
 * UV rect for one cell of a square atlas. `row` counts from the TOP of the
 * canvas; the flip into texture space happens here so callers can read the cell
 * table above literally. Insetting by one texel stops nearest sampling from
 * grabbing the neighbouring cell along a shared edge.
 */
export function atlasCell(
  col: number,
  row: number,
  cols: number,
  pixels: number
): { u0: number; v0: number; u1: number; v1: number } {
  const step = 1 / cols;
  const inset = 1 / pixels;
  return {
    u0: col * step + inset,
    u1: (col + 1) * step - inset,
    v0: 1 - (row + 1) * step + inset,
    v1: 1 - row * step - inset,
  };
}

/** Cell helpers for the two atlases, so callers never juggle raw indices. */
export const WINDOW_CELL = {
  dark: () => atlasCell(0, 0, 4, BIG),
  curtain: () => atlasCell(1, 0, 4, BIG),
  blinds: () => atlasCell(2, 0, 4, BIG),
  tv: () => atlasCell(3, 0, 4, BIG),
  boarded: () => atlasCell(0, 1, 4, BIG),
  grimy: () => atlasCell(1, 1, 4, BIG),
  dim: () => atlasCell(2, 1, 4, BIG),
  halfLit: () => atlasCell(3, 1, 4, BIG),
  doorSteel: () => atlasCell(0, 2, 4, BIG),
  doorGreen: () => atlasCell(1, 2, 4, BIG),
  doorWood: () => atlasCell(2, 2, 4, BIG),
  shutter: () => atlasCell(3, 2, 4, BIG),
  shopA: () => atlasCell(0, 3, 4, BIG),
  shopB: () => atlasCell(1, 3, 4, BIG),
  laundry: () => atlasCell(2, 3, 4, BIG),
  vent: () => atlasCell(3, 3, 4, BIG),
} as const;

export const SIGN_CELL = {
  awningRed: () => atlasCell(0, 0, 4, SMALL),
  awningGreen: () => atlasCell(1, 0, 4, SMALL),
  signWarm: () => atlasCell(2, 0, 4, SMALL),
  signCool: () => atlasCell(3, 0, 4, SMALL),
  paintWhite: () => atlasCell(0, 1, 4, SMALL),
  paintYellow: () => atlasCell(1, 1, 4, SMALL),
  hazard: () => atlasCell(2, 1, 4, SMALL),
  fascia: () => atlasCell(3, 1, 4, SMALL),
  cornice: () => atlasCell(0, 2, 4, SMALL),
  tarRoof: () => atlasCell(1, 2, 4, SMALL),
  steel: () => atlasCell(2, 2, 4, SMALL),
  timber: () => atlasCell(3, 2, 4, SMALL),
  kerb: () => atlasCell(0, 3, 4, SMALL),
  rubble: () => atlasCell(1, 3, 4, SMALL),
  plain: () => atlasCell(2, 3, 4, SMALL),
  grate: () => atlasCell(3, 3, 4, SMALL),
} as const;
