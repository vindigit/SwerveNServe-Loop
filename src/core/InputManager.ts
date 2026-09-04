import { CameraConfig, RunConfig } from "@/config/gameConfig";

/**
 * InputManager
 *
 * The only place in the game that touches keyboard, mouse or gamepad hardware.
 * Everything else asks this module what the player wants, so no gameplay system
 * ever branches on input source and no second module ever adds a key listener.
 *
 * Polled, not event-driven: call `update()` exactly once per frame *before*
 * anything reads state. Edge triggers are latched for the whole frame, so two
 * readers of `wasPressed("accept")` in the same frame both see it — there is no
 * consume-on-read footgun.
 *
 * Frame-of-reference note for `getMove()`: x/z are *screen* intent relative to
 * the camera — `x` positive is right, `z` negative is away from the camera
 * (which is the sign a gamepad stick already produces, and what `W` produces).
 * PlayerController rotates them by the camera yaw. That keeps the whole
 * camera-relative transform in one place instead of two.
 */

export interface MoveInput {
  x: number;
  z: number;
  sprint: boolean;
  jump: boolean;
}

export type ActionName =
  | "interact"
  | "accept"
  | "back"
  | "restart"
  | "up"
  | "down"
  | "left"
  | "right"
  | "pause";

/** One bit per action. Nine actions fit comfortably in a JS number. */
const ACTION_BIT: Record<ActionName, number> = {
  interact: 1 << 0,
  accept: 1 << 1,
  back: 1 << 2,
  restart: 1 << 3,
  up: 1 << 4,
  down: 1 << 5,
  left: 1 << 6,
  right: 1 << 7,
  pause: 1 << 8,
};

/**
 * Keyboard bindings, by `KeyboardEvent.code` so layout never matters.
 * WASD and the arrow keys are both movement *and* menu navigation — a menu
 * simply reads up/down/left/right instead of getMove().
 */
const KEY_BITS: Record<string, number> = {
  KeyE: ACTION_BIT.interact | ACTION_BIT.accept,
  Enter: ACTION_BIT.interact | ACTION_BIT.accept | ACTION_BIT.restart,
  NumpadEnter: ACTION_BIT.interact | ACTION_BIT.accept | ACTION_BIT.restart,
  Space: ACTION_BIT.accept,
  Escape: ACTION_BIT.back,
  Backspace: ACTION_BIT.back,
  KeyR: ACTION_BIT.restart,
  KeyP: ACTION_BIT.pause,
  KeyW: ACTION_BIT.up,
  ArrowUp: ACTION_BIT.up,
  KeyS: ACTION_BIT.down,
  ArrowDown: ACTION_BIT.down,
  KeyA: ACTION_BIT.left,
  ArrowLeft: ACTION_BIT.left,
  KeyD: ACTION_BIT.right,
  ArrowRight: ACTION_BIT.right,
};

/** Keys the browser would otherwise use to scroll the page out from under us. */
const SWALLOW_DEFAULT = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Standard-mapping gamepad buttons.
 * 0 = A/Cross is confirm *and* the jump hop: A being "do the obvious thing" is
 * the strongest console convention there is, and a stray kerb hop while
 * accepting a job costs the player nothing.
 */
const PAD_ACTION_BUTTONS: ReadonlyArray<readonly [number, number]> = [
  [0, ACTION_BIT.interact | ACTION_BIT.accept | ACTION_BIT.restart],
  [1, ACTION_BIT.back],
  [9, ACTION_BIT.pause],
  [12, ACTION_BIT.up],
  [13, ACTION_BIT.down],
  [14, ACTION_BIT.left],
  [15, ACTION_BIT.right],
];

/** Radial dead zone. Output ramps from 0 at the edge — never a clipped step. */
const STICK_DEAD_ZONE = 0.18;
/** Left-stick deflection that counts as a menu "press" in a direction. */
const STICK_MENU_THRESHOLD = 0.6;
/** Right-trigger pull that counts as sprint. */
const SPRINT_TRIGGER_THRESHOLD = 0.3;
const PAD_SPRINT_BUTTON = 7;
const PAD_JUMP_BUTTONS = [0, 2] as const;

export class InputManager {
  private readonly target: HTMLElement | null;

  // --- Keyboard -----------------------------------------------------------
  private readonly heldKeys = new Set<string>();
  private keyMask = 0;
  /** Actions that saw a fresh keydown since the last update(). Catches taps
   *  shorter than one frame, which pure held-state edge detection would miss. */
  private tapMask = 0;

  // --- Resolved per-frame action state ------------------------------------
  private heldMask = 0;
  private prevHeldMask = 0;
  private pressedMask = 0;

  // --- Look ---------------------------------------------------------------
  private pendingMouseX = 0;
  private pendingMouseY = 0;
  private pointerLocked = false;
  private pointerLockWanted = true;

  // --- Gamepad ------------------------------------------------------------
  private padIndex: number | null = null;
  private padConnected = false;
  private padSprint = false;
  private padJump = false;

  // --- Internal clock (stick look is rad/second, and update() takes no dt) --
  private lastUpdateMs = 0;

  // Reused outputs. Do not retain these objects — they are rewritten each frame.
  private readonly moveOut: MoveInput = { x: 0, z: 0, sprint: false, jump: false };
  private readonly lookOut = { yaw: 0, pitch: 0 };

  // Bound handlers, kept so dispose() can actually remove them.
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Escape") this.releasePointerLock();
    const bits = KEY_BITS[e.code];
    // Only keys the game actually binds are tracked, so the held set stays tiny.
    if (bits === undefined && !InputManager.isModifierKey(e.code)) return;
    if (SWALLOW_DEFAULT.has(e.code)) e.preventDefault();
    if (bits !== undefined && !e.repeat) this.tapMask |= bits;
    if (!this.heldKeys.has(e.code)) {
      this.heldKeys.add(e.code);
      if (bits !== undefined) this.keyMask |= bits;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!this.heldKeys.delete(e.code)) return;
    this.rebuildKeyMask();
  };

  private readonly onBlur = (): void => this.clear();

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.clear();
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.pendingMouseX += e.movementX;
    this.pendingMouseY += e.movementY;
  };

  private readonly onPointerDown = (): void => {
    if (!this.pointerLockWanted || !this.target || this.pointerLocked) return;
    try {
      const request: unknown = this.target.requestPointerLock();
      if (request && typeof (request as Promise<void>).catch === "function") {
        (request as Promise<void>).catch(() => {
          /* user gesture rejected or already locked — mouse look simply stays off */
        });
      }
    } catch {
      /* pointer lock unavailable; gamepad look and keyboard still work */
    }
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = !!this.target && document.pointerLockElement === this.target;
    // Dropping lock mid-swipe must not leave a stale delta to apply next frame.
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
  };

  private readonly onPadConnected = (e: GamepadEvent): void => {
    this.padIndex = e.gamepad.index;
    this.padConnected = true;
  };

  private readonly onPadDisconnected = (e: GamepadEvent): void => {
    if (this.padIndex === e.gamepad.index) this.padIndex = null;
    this.padConnected = false;
    // Pad-derived bits are recomputed from scratch every frame, so a pad that
    // vanishes mid-hold cannot leave an action stuck on.
    this.padSprint = false;
    this.padJump = false;
  };

  constructor(target?: HTMLElement) {
    const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
    this.target = target ?? (hasDom ? document.body : null);
    this.lastUpdateMs = InputManager.now();
    if (!hasDom) return;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    window.addEventListener("gamepadconnected", this.onPadConnected);
    window.addEventListener("gamepaddisconnected", this.onPadDisconnected);
    if (this.target) this.target.addEventListener("pointerdown", this.onPointerDown);
  }

  /**
   * Whether a canvas click should grab the pointer. The assembler should set
   * this false outside the `playing` phase so menus keep a visible cursor.
   */
  setPointerLockEnabled(enabled: boolean): void {
    this.pointerLockWanted = enabled;
    if (!enabled) this.releasePointerLock();
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /** Call once per frame, before anything reads state. */
  update(): void {
    const now = InputManager.now();
    let dt = (now - this.lastUpdateMs) / 1000;
    this.lastUpdateMs = now;
    if (!(dt > 0)) dt = 0;
    if (dt > RunConfig.maxDeltaSeconds) dt = RunConfig.maxDeltaSeconds;

    const pad = this.pollPad();

    // --- Movement: keyboard and stick both resolved, larger magnitude wins.
    // A pad resting at centre must never veto the keyboard, and vice versa.
    let kx = 0;
    let kz = 0;
    if (this.heldKeys.has("KeyD") || this.heldKeys.has("ArrowRight")) kx += 1;
    if (this.heldKeys.has("KeyA") || this.heldKeys.has("ArrowLeft")) kx -= 1;
    if (this.heldKeys.has("KeyS") || this.heldKeys.has("ArrowDown")) kz += 1;
    if (this.heldKeys.has("KeyW") || this.heldKeys.has("ArrowUp")) kz -= 1;
    const kMag = Math.hypot(kx, kz);
    if (kMag > 1) {
      kx /= kMag;
      kz /= kMag;
    }

    let gx = 0;
    let gz = 0;
    if (pad) {
      gx = pad.axes[0] ?? 0;
      gz = pad.axes[1] ?? 0;
      const mag = Math.hypot(gx, gz);
      if (mag <= STICK_DEAD_ZONE) {
        gx = 0;
        gz = 0;
      } else {
        // Rescale so the very first millimetre past the dead zone is a real 0,
        // ramping to 1 at full deflection. Clipping here is what makes a pad
        // feel like it snaps to a walk instead of easing into one.
        const ramp = Math.min(1, (mag - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE));
        gx = (gx / mag) * ramp;
        gz = (gz / mag) * ramp;
      }
    }

    if (Math.hypot(gx, gz) > Math.hypot(kx, kz)) {
      this.moveOut.x = gx;
      this.moveOut.z = gz;
    } else {
      this.moveOut.x = kx;
      this.moveOut.z = kz;
    }
    this.moveOut.sprint =
      this.padSprint || this.heldKeys.has("ShiftLeft") || this.heldKeys.has("ShiftRight");
    this.moveOut.jump = this.padJump || this.heldKeys.has("Space");

    // --- Look. Mouse is per-pixel and already a delta; the stick is a rate and
    // has to be integrated, which is why this module keeps its own clock.
    this.lookOut.yaw = -this.pendingMouseX * CameraConfig.mouseSensitivity;
    this.lookOut.pitch = this.pendingMouseY * CameraConfig.mouseSensitivity;
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    if (pad) {
      let rx = pad.axes[2] ?? 0;
      let ry = pad.axes[3] ?? 0;
      const mag = Math.hypot(rx, ry);
      if (mag <= STICK_DEAD_ZONE) {
        rx = 0;
        ry = 0;
      } else {
        const ramp = Math.min(1, (mag - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE));
        rx = (rx / mag) * ramp;
        ry = (ry / mag) * ramp;
      }
      this.lookOut.yaw -= rx * CameraConfig.stickSensitivity * dt;
      this.lookOut.pitch += ry * CameraConfig.stickSensitivity * dt;
    }

    // --- Actions. Held state is rebuilt from source every frame; the edge is
    // taken against last frame, plus any sub-frame taps the DOM reported.
    let held = this.keyMask;
    if (pad) held |= this.padActionMask(pad);
    this.pressedMask = (held & ~this.prevHeldMask) | this.tapMask;
    this.heldMask = held;
    this.prevHeldMask = held;
    this.tapMask = 0;
  }

  /** Camera-relative intent, already dead-zoned and normalised (length ≤ 1). */
  getMove(): MoveInput {
    return this.moveOut;
  }

  /** Look delta *this frame*, in radians (mouse when locked, right stick otherwise). */
  getLook(): { yaw: number; pitch: number } {
    return this.lookOut;
  }

  /** Edge-triggered: true on the frame the action went down. */
  wasPressed(action: ActionName): boolean {
    return (this.pressedMask & ACTION_BIT[action]) !== 0;
  }

  isHeld(action: ActionName): boolean {
    return (this.heldMask & ACTION_BIT[action]) !== 0;
  }

  hasGamepad(): boolean {
    return this.padConnected;
  }

  /** Drops all held state — call on focus loss and on phase change. */
  clear(): void {
    this.heldKeys.clear();
    this.keyMask = 0;
    this.tapMask = 0;
    this.heldMask = 0;
    // Zeroing the previous mask too: a key that is still physically down when
    // focus returns produces no keydown, so it must read as released, and it
    // must not fire a phantom edge either.
    this.prevHeldMask = 0;
    this.pressedMask = 0;
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    this.padSprint = false;
    this.padJump = false;
    this.moveOut.x = 0;
    this.moveOut.z = 0;
    this.moveOut.sprint = false;
    this.moveOut.jump = false;
    this.lookOut.yaw = 0;
    this.lookOut.pitch = 0;
    this.lastUpdateMs = InputManager.now();
  }

  dispose(): void {
    this.clear();
    if (typeof window === "undefined" || typeof document === "undefined") return;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("gamepadconnected", this.onPadConnected);
    window.removeEventListener("gamepaddisconnected", this.onPadDisconnected);
    if (this.target) this.target.removeEventListener("pointerdown", this.onPointerDown);
    this.releasePointerLock();
  }

  // --- internals ----------------------------------------------------------

  private static now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** Sprint has no action bit — it lives on MoveInput — so it is tracked here. */
  private static isModifierKey(code: string): boolean {
    return code === "ShiftLeft" || code === "ShiftRight";
  }

  private rebuildKeyMask(): void {
    let mask = 0;
    for (const code of this.heldKeys) {
      const bits = KEY_BITS[code];
      if (bits !== undefined) mask |= bits;
    }
    this.keyMask = mask;
  }

  private releasePointerLock(): void {
    if (typeof document === "undefined") return;
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch {
        /* already unlocked */
      }
    }
  }

  /**
   * Find a live pad. The connect event is not enough on its own — Chrome only
   * surfaces a pad after the first button press, and a pad can be yanked
   * between frames — so we re-resolve from the live array every frame and fall
   * back to the first connected pad if our index went away.
   */
  private pollPad(): Gamepad | null {
    if (typeof navigator === "undefined" || !navigator.getGamepads) {
      this.padConnected = false;
      return null;
    }
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (this.padIndex !== null) pad = pads[this.padIndex] ?? null;
    if (!pad || !pad.connected) {
      pad = null;
      for (let i = 0; i < pads.length; i++) {
        const candidate = pads[i];
        if (candidate && candidate.connected) {
          pad = candidate;
          this.padIndex = i;
          break;
        }
      }
    }
    this.padConnected = pad !== null;
    if (!pad) {
      this.padSprint = false;
      this.padJump = false;
      return null;
    }

    this.padSprint = (pad.buttons[PAD_SPRINT_BUTTON]?.value ?? 0) > SPRINT_TRIGGER_THRESHOLD;
    this.padJump = false;
    for (const b of PAD_JUMP_BUTTONS) {
      if (pad.buttons[b]?.pressed) this.padJump = true;
    }
    return pad;
  }

  /** Held-state mask from the pad, including left-stick flicks for menus. */
  private padActionMask(pad: Gamepad): number {
    let mask = 0;
    for (const [index, bits] of PAD_ACTION_BUTTONS) {
      if (pad.buttons[index]?.pressed) mask |= bits;
    }
    const ax = pad.axes[0] ?? 0;
    const az = pad.axes[1] ?? 0;
    if (ax > STICK_MENU_THRESHOLD) mask |= ACTION_BIT.right;
    else if (ax < -STICK_MENU_THRESHOLD) mask |= ACTION_BIT.left;
    if (az > STICK_MENU_THRESHOLD) mask |= ACTION_BIT.down;
    else if (az < -STICK_MENU_THRESHOLD) mask |= ACTION_BIT.up;
    return mask;
  }
}
