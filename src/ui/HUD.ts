import * as THREE from "three";
import { RunConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import type { NavTarget } from "@/core/types";

/**
 * In-game HUD. DOM, not canvas — it stays crisp while the 3D buffer is
 * upscaled from 540p, which is exactly the split the bar's HUD plate shows.
 *
 * It reads the world only through events. Nothing here reaches into a gameplay
 * module, and nothing in a gameplay module knows this exists.
 */

const el = (tag: string, className: string, parent?: HTMLElement): HTMLDivElement => {
  const node = document.createElement(tag) as HTMLDivElement;
  node.className = className;
  parent?.appendChild(node);
  return node;
};

export class HUD {
  private readonly root = el("div", "hud");
  private readonly timerEl: HTMLDivElement;
  private readonly cashEl: HTMLDivElement;
  private readonly streakEl: HTMLDivElement;
  private readonly objectiveEl: HTMLDivElement;
  private readonly objectiveLabel: HTMLDivElement;
  private readonly objectiveDist: HTMLDivElement;
  private readonly arrowEl: HTMLDivElement;
  private readonly toastLayer: HTMLDivElement;

  private navTarget: NavTarget | null = null;
  private unsubscribes: Array<() => void> = [];
  private toastTimers: number[] = [];
  private readonly projected = new THREE.Vector3();

  constructor(private readonly parent: HTMLElement) {
    const left = el("div", "hud-left", this.root);
    this.timerEl = el("div", "hud-timer", left);
    this.cashEl = el("div", "hud-cash", left);
    this.streakEl = el("div", "hud-streak", left);

    this.objectiveEl = el("div", "hud-objective", this.root);
    this.objectiveLabel = el("div", "hud-objective-label", this.objectiveEl);
    this.objectiveDist = el("div", "hud-objective-dist", this.objectiveEl);

    this.arrowEl = el("div", "hud-arrow", this.root);
    this.toastLayer = el("div", "hud-toasts", this.root);

    parent.appendChild(this.root);
    this.timerEl.textContent = "12:00";
    this.cashEl.textContent = "$0";
    this.streakEl.textContent = "";
    this.objectiveEl.style.opacity = "0";

    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribes.push(
      eventBus.on("run:tick", ({ remainingSeconds }) => {
        const m = Math.floor(remainingSeconds / 60);
        const s = Math.floor(remainingSeconds % 60);
        this.timerEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
        this.timerEl.classList.toggle(
          "is-urgent",
          remainingSeconds <= RunConfig.countdownWarningSeconds
        );
      }),

      eventBus.on("score:changed", ({ total, delta, label }) => {
        this.cashEl.textContent = `$${total.toLocaleString("en-US")}`;
        if (delta > 0) this.toast(`+$${delta.toLocaleString("en-US")} ${label}`, "cash");
      }),

      eventBus.on("streak:changed", ({ count }) => {
        this.streakEl.textContent = count > 1 ? `STREAK ×${count}` : "";
      }),

      eventBus.on("nav:target", ({ target }) => {
        this.navTarget = target;
        this.objectiveEl.style.opacity = target ? "1" : "0";
        if (target) {
          this.objectiveLabel.textContent = target.kind === "pickup" ? "PICK UP" : "DELIVER";
          this.objectiveEl.classList.toggle("is-delivery", target.kind === "delivery");
        }
      }),

      eventBus.on("toast", ({ text, tone }) => this.toast(text, tone)),

      eventBus.on("job:offered", ({ job }) => {
        this.toast(`${job.pickup.name} → ${job.delivery.name}`, "info");
      })
    );
  }

  /**
   * Direction and distance to the objective. When the target is off-screen the
   * arrow pins to the frame edge and points at it — a minimap is not needed to
   * navigate this map, and the bar's HUD plate does not have one.
   */
  update(camera: THREE.PerspectiveCamera, playerPosition: THREE.Vector3): void {
    if (!this.navTarget) {
      this.arrowEl.style.opacity = "0";
      return;
    }

    const distance = playerPosition.distanceTo(this.navTarget.position);
    this.objectiveDist.textContent = `${Math.round(distance)}m`;

    this.projected.copy(this.navTarget.position);
    this.projected.y += 1.6;
    this.projected.project(camera);

    const behind = this.projected.z > 1;
    const w = this.parent.clientWidth;
    const h = this.parent.clientHeight;
    let x = (this.projected.x * 0.5 + 0.5) * w;
    let y = (-this.projected.y * 0.5 + 0.5) * h;
    if (behind) {
      x = w - x;
      y = h - y;
    }

    const margin = 64;
    const cx = w / 2;
    const cy = h / 2;
    const offscreen = behind || x < margin || x > w - margin || y < margin || y > h - margin;

    if (offscreen) {
      // Clamp to the frame edge along the ray from centre to the target.
      const dx = x - cx;
      const dy = y - cy;
      const scale = Math.min(
        Math.abs((w / 2 - margin) / (dx || 1e-3)),
        Math.abs((h / 2 - margin) / (dy || 1e-3))
      );
      x = cx + dx * scale;
      y = cy + dy * scale;
      this.arrowEl.style.transform = `translate(${x}px, ${y}px) rotate(${Math.atan2(dy, dx) + Math.PI / 2}rad)`;
      this.arrowEl.classList.add("is-edge");
    } else {
      this.arrowEl.style.transform = `translate(${x}px, ${y}px) rotate(180deg)`;
      this.arrowEl.classList.remove("is-edge");
    }
    this.arrowEl.classList.toggle("is-delivery", this.navTarget.kind === "delivery");
    this.arrowEl.style.opacity = "1";
  }

  toast(text: string, tone: "cash" | "info" | "warn" = "info"): void {
    const node = el("div", `hud-toast is-${tone}`, this.toastLayer);
    node.textContent = text;
    // Keep the layer short — a stack of stale toasts hides the route.
    while (this.toastLayer.children.length > 3) this.toastLayer.removeChild(this.toastLayer.firstChild!);
    const timer = window.setTimeout(() => {
      node.classList.add("is-out");
      const inner = window.setTimeout(() => node.remove(), 400);
      this.toastTimers.push(inner);
    }, 1500);
    this.toastTimers.push(timer);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
  }

  /** Full reset for a new run — no stale toast or arrow survives a restart. */
  reset(): void {
    this.navTarget = null;
    this.toastLayer.replaceChildren();
    for (const timer of this.toastTimers) window.clearTimeout(timer);
    this.toastTimers = [];
    this.cashEl.textContent = "$0";
    this.streakEl.textContent = "";
    this.objectiveEl.style.opacity = "0";
    this.arrowEl.style.opacity = "0";
    this.timerEl.classList.remove("is-urgent");
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.reset();
    this.root.remove();
  }
}
