import { ScoreConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import type { ActiveJob } from "@/core/types";

/**
 * StreakSystem
 *
 * Consecutive deliveries buy a cash multiplier. Dawdle — take longer than
 * `streakBreakParMultiple × par`, the same point at which the fast bonus has
 * decayed to nothing — and the streak is gone, not merely paused.
 *
 * It listens for `job:delivered` rather than being called directly, so the
 * ordering is guaranteed: JobDirector prices the job through ScoreSystem, THEN
 * announces the delivery, so the run that built the streak is paid at the
 * multiplier it started with and the next one collects the raise.
 */
export class StreakSystem {
  private count = 0;
  private best = 0;
  private lastJobId: string | null = null;
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = eventBus.on("job:delivered", ({ job }) => this.registerDelivery(job));
  }

  /**
   * Fold one completed delivery into the streak. Idempotent per job id, so a
   * duplicated event can never inflate the multiplier.
   */
  registerDelivery(job: ActiveJob): void {
    if (job.id && job.id === this.lastJobId) return;
    this.lastJobId = job.id ?? null;

    const par = Number.isFinite(job.parSeconds) ? job.parSeconds : 0;
    const elapsed = Number.isFinite(job.elapsed) ? job.elapsed : 0;
    const tooSlow = par > 0 && elapsed > par * ScoreConfig.streakBreakParMultiple;

    if (tooSlow) {
      this.count = 0;
    } else {
      this.count += 1;
      if (this.count > this.best) this.best = this.count;
    }
    this.emit();
  }

  /** Drop the streak for any other reason (a fail, a hazard, a bust). */
  break(): void {
    if (this.count === 0) return;
    this.count = 0;
    this.emit();
  }

  getCount(): number {
    return this.count;
  }

  /** Highest streak reached this run — goes onto the results screen. */
  getBest(): number {
    return this.best;
  }

  getMultiplier(): number {
    const multiplier = 1 + this.count * ScoreConfig.streakMultiplierStep;
    return Math.min(ScoreConfig.maxStreakMultiplier, multiplier);
  }

  /** Full reset for a new run — count, best and the duplicate guard. */
  reset(): void {
    this.count = 0;
    this.best = 0;
    this.lastJobId = null;
    this.emit();
  }

  /** Drop the bus subscription so a restart cannot stack a second listener. */
  dispose(): void {
    this.unsubscribe();
  }

  private emit(): void {
    eventBus.emit("streak:changed", { count: this.count, multiplier: this.getMultiplier() });
  }
}
