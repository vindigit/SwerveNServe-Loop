import * as THREE from "three";
import type { NavTarget } from "@/core/types";
import type { BoxCollider } from "@/world/types";

const SIZE = 192;
const CENTRE = SIZE / 2;
const METRES_TO_PIXELS = 1.55;

/** Convert a world-space offset into the player-up rotating map plane. */
export function worldOffsetToMinimap(
  dx: number,
  dz: number,
  facingRad: number,
  scale = METRES_TO_PIXELS
): { x: number; y: number } {
  const sin = Math.sin(facingRad);
  const cos = Math.cos(facingRad);
  return {
    x: (dx * cos + dz * sin) * scale,
    y: (-dx * sin + dz * cos) * scale,
  };
}

/**
 * GTA-era local map: collision geometry becomes the building footprint, empty
 * space becomes the route. It rotates under a fixed player chevron, so the
 * direction the courier faces is always up and a glance is enough at speed.
 */
export class Minimap {
  readonly element: HTMLDivElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly colliders: readonly BoxCollider[];
  private readonly north: HTMLDivElement;
  private target: NavTarget | null = null;

  constructor(colliders: readonly BoxCollider[]) {
    this.colliders = colliders;
    this.element = document.createElement("div");
    this.element.className = "minimap";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "minimap-canvas";
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.element.appendChild(this.canvas);

    const player = document.createElement("div");
    player.className = "minimap-player";
    this.element.appendChild(player);

    this.north = document.createElement("div");
    this.north.className = "minimap-north";
    this.north.textContent = "N";
    this.element.appendChild(this.north);

    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Minimap requires a 2D canvas context");
    this.context = context;
  }

  setTarget(target: NavTarget | null): void {
    this.target = target;
  }

  update(playerPosition: THREE.Vector3, facingRad: number): void {
    const ctx = this.context;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(CENTRE, CENTRE, CENTRE - 3, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#77777d";
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.translate(CENTRE, CENTRE);
    ctx.rotate(-facingRad);
    ctx.translate(-playerPosition.x * METRES_TO_PIXELS, -playerPosition.z * METRES_TO_PIXELS);

    for (const box of this.colliders) {
      if (box.kind === "step") continue;
      ctx.fillStyle = box.kind === "wall" ? "#202127" : "#45474f";
      const x = box.minX * METRES_TO_PIXELS;
      const y = box.minZ * METRES_TO_PIXELS;
      const w = Math.max(1.5, (box.maxX - box.minX) * METRES_TO_PIXELS);
      const h = Math.max(1.5, (box.maxZ - box.minZ) * METRES_TO_PIXELS);
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();

    if (this.target) this.drawTarget(playerPosition, facingRad, this.target);

    // North orbits the rim as the world rotates beneath the player.
    const northRadius = CENTRE - 14;
    const northX = -Math.sin(facingRad) * northRadius;
    const northY = -Math.cos(facingRad) * northRadius;
    this.north.style.transform = `translate(${northX}px, ${northY}px)`;
  }

  private drawTarget(player: THREE.Vector3, facingRad: number, target: NavTarget): void {
    const delta = worldOffsetToMinimap(
      target.position.x - player.x,
      target.position.z - player.z,
      facingRad
    );
    const distance = Math.hypot(delta.x, delta.y);
    const max = CENTRE - 13;
    const scale = distance > max ? max / distance : 1;
    const x = CENTRE + delta.x * scale;
    const y = CENTRE + delta.y * scale;
    const ctx = this.context;

    ctx.save();
    ctx.fillStyle = target.kind === "delivery" ? "#9fd0ff" : "#ffb02e";
    ctx.strokeStyle = "#08090c";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  reset(): void {
    this.target = null;
    this.context.clearRect(0, 0, SIZE, SIZE);
  }
}
