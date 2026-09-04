import { RunConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import type { NavTarget } from "@/core/types";
import { Minimap } from "@/ui/Minimap";
import type { BoxCollider } from "@/world/types";
import type { Vector3 } from "three";

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
  private readonly toastLayer: HTMLDivElement;
  private readonly minimap: Minimap;

  private navTarget: NavTarget | null = null;
  private unsubscribes: Array<() => void> = [];
  private toastTimers: number[] = [];

  constructor(parent: HTMLElement, colliders: readonly BoxCollider[]) {
    const left = el("div", "hud-left", this.root);
    this.timerEl = el("div", "hud-timer", left);
    this.cashEl = el("div", "hud-cash", left);
    this.streakEl = el("div", "hud-streak", left);

    this.objectiveEl = el("div", "hud-objective", this.root);
    this.objectiveLabel = el("div", "hud-objective-label", this.objectiveEl);
    this.objectiveDist = el("div", "hud-objective-dist", this.objectiveEl);

    this.minimap = new Minimap(colliders);
    this.root.appendChild(this.minimap.element);
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
        this.minimap.setTarget(target);
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
   * Distance and local map state. Direction now lives in the rotating minimap
   * and in the world-space arrow directly over the objective.
   */
  update(playerPosition: Vector3, facingRad: number): void {
    if (!this.navTarget) {
      this.minimap.update(playerPosition, facingRad);
      return;
    }

    const distance = playerPosition.distanceTo(this.navTarget.position);
    this.objectiveDist.textContent = `${Math.round(distance)}m`;
    this.minimap.update(playerPosition, facingRad);
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
    this.minimap.reset();
    this.timerEl.classList.remove("is-urgent");
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.reset();
    this.root.remove();
  }
}
