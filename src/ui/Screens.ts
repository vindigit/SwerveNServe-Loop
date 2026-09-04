import { LOOK_OPTIONS, type LookPreset } from "@/character/Courier";
import type { InputManager } from "@/core/InputManager";
import type { RunSummary } from "@/core/types";

/**
 * Title, Choose Your Look, and Results.
 *
 * All three are DOM overlays drawn over the live 3D view — the world stays
 * visible behind every screen, which is what stops the game feeling like a
 * menu with a game attached. Navigation goes through InputManager actions, so
 * keyboard and gamepad reach every control with no duplicated bindings.
 */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
};

/** Shared vertical menu behaviour: wraps, repeats, works on both input paths. */
class Menu {
  index = 0;
  constructor(private readonly items: HTMLElement[]) {
    this.render();
  }
  move(delta: number): void {
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
  }
  set(index: number): void {
    this.index = Math.min(this.items.length - 1, Math.max(0, index));
    this.render();
  }
  private render(): void {
    this.items.forEach((item, i) => item.classList.toggle("is-selected", i === this.index));
  }
}

/* ------------------------------------------------------------------ */

export class TitleScreen {
  readonly root: HTMLDivElement;
  private readonly menu: Menu;
  /** Set by the Game; called with the chosen menu index. */
  onChoose: ((choice: "start" | "look" | "options") => void) | null = null;
  private optionsOpen = false;
  private readonly optionsEl: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = el("div", "screen screen-title", parent);
    const brand = el("div", "title-brand", this.root);
    const logo = el("div", "title-logo", brand);
    logo.innerHTML = `SWERVE<span class="title-n">N</span>SERVE`;
    el("div", "title-tag", brand).textContent = "ONE NIGHT. MOVE FAST.";

    const list = el("div", "title-menu", this.root);
    const items = ["START RUN", "CHOOSE LOOK", "OPTIONS"].map((label) => {
      const item = el("div", "title-item", list);
      item.textContent = label;
      return item;
    });
    this.menu = new Menu(items);

    this.optionsEl = el("div", "title-options", this.root);
    this.optionsEl.innerHTML = `
      <div class="opt-row"><span>MOVE</span><span>WASD / Left Stick</span></div>
      <div class="opt-row"><span>SPRINT</span><span>Shift / RT</span></div>
      <div class="opt-row"><span>JUMP</span><span>Space / A</span></div>
      <div class="opt-row"><span>LOOK</span><span>Mouse / Right Stick</span></div>
      <div class="opt-row"><span>ACCEPT</span><span>E / Enter / A</span></div>
      <div class="opt-row"><span>BACK</span><span>Esc / B</span></div>`;
    this.optionsEl.style.display = "none";

    el("div", "screen-hints", this.root).innerHTML =
      `<span>&#9650;&#9660; SELECT</span><span>ENTER / A — CONFIRM</span>`;
  }

  update(input: InputManager): void {
    if (this.optionsOpen) {
      if (input.wasPressed("back") || input.wasPressed("accept")) {
        this.optionsOpen = false;
        this.optionsEl.style.display = "none";
      }
      return;
    }
    if (input.wasPressed("up")) this.menu.move(-1);
    if (input.wasPressed("down")) this.menu.move(1);
    if (input.wasPressed("accept")) {
      const choice = (["start", "look", "options"] as const)[this.menu.index];
      if (choice === "options") {
        this.optionsOpen = true;
        this.optionsEl.style.display = "";
      } else {
        this.onChoose?.(choice);
      }
    }
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
    if (visible) {
      this.menu.set(0);
      this.optionsOpen = false;
      this.optionsEl.style.display = "none";
    }
  }
}

/* ------------------------------------------------------------------ */

type LookCategory = keyof LookPreset;
const CATEGORIES: LookCategory[] = ["head", "shirt", "pants", "shoes"];
const CATEGORY_LABEL: Record<LookCategory, string> = {
  head: "HEAD",
  shirt: "SHIRT",
  pants: "PANTS",
  shoes: "SHOES",
};

/**
 * Choose Your Look. Four preset rows plus a locked accessory slot — a picker,
 * not a creator. No sliders, no stats, no unlock economy.
 */
export class LookScreen {
  readonly root: HTMLDivElement;
  private readonly rows: HTMLDivElement[] = [];
  private readonly swatchRows: HTMLDivElement[][] = [];
  private readonly menu: Menu;
  private look: LookPreset = { head: 0, shirt: 0, pants: 0, shoes: 0 };

  onChange: ((look: LookPreset) => void) | null = null;
  onConfirm: (() => void) | null = null;
  onBack: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el("div", "screen screen-look", parent);
    const panel = el("div", "look-panel", this.root);
    const logo = el("div", "title-logo is-small", panel);
    logo.innerHTML = `SWERVE<span class="title-n">N</span>SERVE`;
    el("div", "look-heading", panel).textContent = "CHOOSE YOUR LOOK";

    const selectable: HTMLElement[] = [];
    CATEGORIES.forEach((category, categoryIndex) => {
      const row = el("div", "look-row", panel);
      el("div", "look-label", row).textContent = CATEGORY_LABEL[category];
      const strip = el("div", "look-strip", row);
      el("div", "look-caret", strip).textContent = "◀";
      const swatches: HTMLDivElement[] = [];
      const options = LOOK_OPTIONS[category] as ReadonlyArray<{ name: string }>;
      options.forEach((option, i) => {
        const swatch = el("div", "look-swatch", strip);
        swatch.textContent = option.name;
        swatch.dataset.index = String(i);
        swatches.push(swatch);
      });
      el("div", "look-caret", strip).textContent = "▶";
      this.swatchRows[categoryIndex] = swatches;
      this.rows.push(row);
      selectable.push(row);
    });

    const chain = el("div", "look-row is-locked", panel);
    el("div", "look-label", chain).textContent = "CHAIN";
    el("div", "look-locked", chain).textContent = "LOCKED";

    const start = el("div", "look-start", panel);
    start.textContent = "START RUN";
    selectable.push(start);

    this.menu = new Menu(selectable);
    el("div", "screen-hints", this.root).innerHTML =
      `<span>&#9650;&#9660; ROW</span><span>&#9668;&#9658; CHANGE</span><span>ENTER — CONFIRM</span><span>ESC — BACK</span>`;

    this.renderSwatches();
  }

  setLook(look: LookPreset): void {
    this.look = { ...look };
    this.renderSwatches();
  }

  update(input: InputManager): void {
    if (input.wasPressed("up")) this.menu.move(-1);
    if (input.wasPressed("down")) this.menu.move(1);

    const row = this.menu.index;
    if (row < CATEGORIES.length) {
      const category = CATEGORIES[row];
      const count = (LOOK_OPTIONS[category] as ReadonlyArray<unknown>).length;
      let changed = false;
      if (input.wasPressed("left")) {
        this.look[category] = (this.look[category] - 1 + count) % count;
        changed = true;
      }
      if (input.wasPressed("right")) {
        this.look[category] = (this.look[category] + 1) % count;
        changed = true;
      }
      if (changed) {
        this.renderSwatches();
        this.onChange?.({ ...this.look });
      }
    }

    if (input.wasPressed("accept")) this.onConfirm?.();
    if (input.wasPressed("back")) this.onBack?.();
  }

  private renderSwatches(): void {
    CATEGORIES.forEach((category, categoryIndex) => {
      const selected = this.look[category];
      this.swatchRows[categoryIndex].forEach((swatch, i) =>
        swatch.classList.toggle("is-active", i === selected)
      );
    });
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
    if (visible) this.menu.set(0);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Results. The whole screen exists to make "RUN IT BACK" the obvious next
 * action, so it is the only bright element and it takes the default focus.
 */
export class ResultsScreen {
  readonly root: HTMLDivElement;
  private readonly cashEl: HTMLDivElement;
  private readonly deliveriesEl: HTMLDivElement;
  private readonly streakEl: HTMLDivElement;
  private readonly newBestEl: HTMLDivElement;
  private readonly bestEl: HTMLDivElement;
  private readonly menu: Menu;

  onChoose: ((choice: "again" | "quit") => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el("div", "screen screen-results", parent);
    const card = el("div", "results-card", this.root);
    el("div", "results-heading", card).textContent = "NIGHT OVER";

    const cashBlock = el("div", "results-cash-block", card);
    el("div", "results-caption", cashBlock).textContent = "CASH EARNED";
    this.cashEl = el("div", "results-cash", cashBlock);

    const stats = el("div", "results-stats", card);
    const deliveriesRow = el("div", "results-row", stats);
    el("span", "", deliveriesRow).textContent = "DELIVERIES";
    this.deliveriesEl = el("div", "results-value", deliveriesRow);
    const streakRow = el("div", "results-row", stats);
    el("span", "", streakRow).textContent = "BEST STREAK";
    this.streakEl = el("div", "results-value", streakRow);

    this.newBestEl = el("div", "results-newbest", card);
    this.newBestEl.textContent = "NEW BEST!";

    const bestBlock = el("div", "results-best", card);
    el("div", "results-caption", bestBlock).textContent = "PERSONAL BEST";
    this.bestEl = el("div", "results-best-value", bestBlock);

    const again = el("div", "results-action is-primary", card);
    again.textContent = "RUN IT BACK";
    const quit = el("div", "results-action", card);
    quit.textContent = "QUIT";
    this.menu = new Menu([again, quit]);

    el("div", "screen-hints", this.root).innerHTML =
      `<span>&#9650;&#9660; SELECT</span><span>ENTER / A — CONFIRM</span>`;
  }

  show(summary: RunSummary): void {
    this.cashEl.textContent = `$${summary.cash.toLocaleString("en-US")}`;
    this.deliveriesEl.textContent = String(summary.deliveries);
    this.streakEl.textContent = String(summary.bestStreak);
    this.newBestEl.style.display = summary.isNewBest ? "" : "none";
    const best = Math.max(summary.cash, summary.previousBest);
    this.bestEl.textContent = `$${best.toLocaleString("en-US")}`;
    this.menu.set(0);
  }

  update(input: InputManager): void {
    if (input.wasPressed("up")) this.menu.move(-1);
    if (input.wasPressed("down")) this.menu.move(1);
    if (input.wasPressed("accept") || input.wasPressed("restart")) {
      this.onChoose?.(this.menu.index === 0 ? "again" : "quit");
    }
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
  }
}
