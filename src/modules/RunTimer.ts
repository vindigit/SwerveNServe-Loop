import { RunConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";

/**
 * RunTimer
 *
 * The clock the whole run is played against. One job: count down honestly.
 *
 * Two rules earn their keep:
 *   - It never goes negative and it fires expiry EXACTLY ONCE, no matter how
 *     many times it is updated afterwards.
 *   - It does not emit `run:ended`. It raises `onExpire` and reports
 *     `isExpired()`; the Game owns the transition so the run summary is
 *     assembled in one place from one set of numbers.
 *
 * `RunConfig.pauseOnBlur` is true, so main.ts drives `setPaused()` from
 * visibilitychange: a courier score attack is about route decisions, not about
 * punishing an alt-tab.
 */

/**
 * Tick cadence. The countdown is read as mm:ss, so ~12 Hz is smoother than the
 * eye needs while keeping a per-frame allocation out of the render loop.
 */
const TICK_INTERVAL_SECONDS = 1 / 12;

export class RunTimer {
  /** Raised once, on the update that takes the clock to zero. Set by the Game. */
  onExpire: (() => void) | null = null;

  private readonly duration: number;
  private remainingSeconds: number;
  private running = false;
  private paused = false;
  private expired = false;
  private expireFired = false;
  private tickAccumulator = 0;

  constructor(durationSeconds: number = RunConfig.durationSeconds) {
    this.duration = durationSeconds > 0 ? durationSeconds : RunConfig.durationSeconds;
    this.remainingSeconds = this.duration;
  }

  /** Begin a fresh countdown. Safe to call again for a restart. */
  start(): void {
    this.remainingSeconds = this.duration;
    this.running = true;
    this.paused = false;
    this.expired = false;
    this.expireFired = false;
    this.tickAccumulator = 0;
    this.emitTick();
  }

  /**
   * Advance the clock. Frame-rate independent: `dt` is wall seconds, never a
   * fixed per-frame decrement, and it is not clamped here — clamping the clock
   * would quietly hand the player extra time on a slow frame. Tab-out is
   * covered by `setPaused()` instead.
   */
  update(dt: number): void {
    if (!this.running || this.paused) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    if (step > 0) {
      this.remainingSeconds = Math.max(0, this.remainingSeconds - step);
      this.tickAccumulator += step;
    }

    if (this.remainingSeconds <= 0) {
      this.remainingSeconds = 0;
      this.expired = true;
      this.running = false;
      this.emitTick();
      if (!this.expireFired) {
        this.expireFired = true;
        this.onExpire?.();
      }
      return;
    }

    if (this.tickAccumulator >= TICK_INTERVAL_SECONDS) {
      this.tickAccumulator = 0;
      this.emitTick();
    }
  }

  /** Freeze the clock without ending the run (tab hidden, results screen). */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Bonus time. Cannot push the clock past the run's authored duration. */
  addTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0 || this.expired) return;
    this.remainingSeconds = Math.min(this.duration, this.remainingSeconds + seconds);
    this.emitTick();
  }

  /** Penalty time. Floors at zero; expiry is still owned by `update()`. */
  subtractTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.remainingSeconds = Math.max(0, this.remainingSeconds - seconds);
    this.emitTick();
  }

  /** Stop the clock where it stands, without raising expiry. */
  stop(): void {
    this.running = false;
  }

  /** Back to a full, unstarted clock. */
  reset(): void {
    this.remainingSeconds = this.duration;
    this.running = false;
    this.paused = false;
    this.expired = false;
    this.expireFired = false;
    this.tickAccumulator = 0;
  }

  getRemainingSeconds(): number {
    return this.remainingSeconds;
  }

  getElapsedSeconds(): number {
    return this.duration - this.remainingSeconds;
  }

  getDurationSeconds(): number {
    return this.duration;
  }

  /** 1 at the start of the run, 0 at the end. Drives the HUD countdown bar. */
  getFraction(): number {
    return this.duration > 0 ? this.remainingSeconds / this.duration : 0;
  }

  isRunning(): boolean {
    return this.running && !this.paused;
  }

  /** True once the clock has hit zero, until the next start()/reset(). */
  isExpired(): boolean {
    return this.expired;
  }

  /** True inside the final stretch — the HUD turns the timer urgent here. */
  isUrgent(): boolean {
    return this.remainingSeconds <= RunConfig.countdownWarningSeconds;
  }

  private emitTick(): void {
    eventBus.emit("run:tick", {
      remainingSeconds: this.remainingSeconds,
      fraction: this.getFraction(),
    });
  }
}
