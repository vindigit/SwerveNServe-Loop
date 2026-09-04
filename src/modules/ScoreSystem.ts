import { ScoreConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import type { ActiveJob, PayoutBreakdown } from "@/core/types";
import type { WorldLocation } from "@/world/types";

/**
 * ScoreSystem
 *
 * The cash rules, kept small enough to hold in your head while running:
 *
 *   base      = max(minBaseCash, distance × cashPerMetre) × reachMultiplier
 *   speed     = base × fastBonusFraction × clamp01((2·par − elapsed) / par)
 *   payout    = (base + speed) × streakMultiplier
 *
 * The speed term pays in full at or under par and decays linearly to nothing at
 * twice par — the same point at which the streak breaks. Miss par badly and you
 * lose the bonus and the multiplier in one go, which is the pressure the run is
 * built on.
 *
 * The maths lives in free functions so it can be unit-tested without a scene, a
 * renderer or a DOM. The class is only a running total plus an event.
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Base cash for a route, before speed and streak.
 * `reach` is the drop-off's authored difficulty: the awkward roof-stair and
 * back-fence destinations are the ones worth learning, so they pay more.
 */
export function computeBaseCash(distance: number, reach: WorldLocation["reach"]): number {
  const metres = Math.max(0, finite(distance, 0));
  const multiplier = ScoreConfig.reachMultiplier[reach] ?? 1;
  return Math.max(ScoreConfig.minBaseCash, metres * ScoreConfig.cashPerMetre) * multiplier;
}

/**
 * Fraction of the fast bonus earned: 1 at or under par, 0 at 2× par and beyond.
 */
export function computeSpeedFraction(elapsed: number, parSeconds: number): number {
  const par = finite(parSeconds, 0);
  if (par <= 0) return 0;
  const time = Math.max(0, finite(elapsed, 0));
  return clamp01((2 * par - time) / par);
}

/** Streak multipliers are clamped to [1, maxStreakMultiplier] before they pay. */
export function clampStreakMultiplier(multiplier: number): number {
  const m = finite(multiplier, 1);
  return Math.min(ScoreConfig.maxStreakMultiplier, Math.max(1, m));
}

/**
 * The whole payout, in whole dollars. Pure — same job in, same cash out.
 *
 * `base`, `speed` and `streak` are all cash and always sum to `total`, so the
 * results screen can show the breakdown without it failing to add up. `streak`
 * is the extra the multiplier bought, not the multiplier itself.
 */
export function computePayout(job: ActiveJob, streakMultiplier: number): PayoutBreakdown {
  const authoredBase = finite(job.baseCash, NaN);
  const base =
    Number.isFinite(authoredBase) && authoredBase > 0
      ? authoredBase
      : computeBaseCash(job.distance, job.delivery?.reach ?? "easy");

  const speedFraction = computeSpeedFraction(job.elapsed, job.parSeconds);
  const speed = base * ScoreConfig.fastBonusFraction * speedFraction;

  const baseCash = Math.max(0, Math.round(base));
  const speedCash = Math.max(0, Math.round(speed));
  const subtotal = baseCash + speedCash;

  const multiplier = clampStreakMultiplier(streakMultiplier);
  // Rounding the subtotal first keeps base + speed + streak === total exactly,
  // and because the subtotal is an integer this is still round(subtotal × mult).
  const streakCash = Math.max(0, Math.round(subtotal * (multiplier - 1)));
  const total = subtotal + streakCash;

  // Under par is the whole point of learning the shortcuts — name it.
  const beatPar = Number.isFinite(job.parSeconds) && job.parSeconds > 0 && job.elapsed <= job.parSeconds;

  return {
    base: baseCash,
    speed: speedCash,
    streak: streakCash,
    total,
    label: beatPar ? "FAST DROP" : "DELIVERED",
  };
}

export class ScoreSystem {
  private total = 0;
  private deliveries = 0;
  private readonly getStreakMultiplier: () => number;

  constructor(getStreakMultiplier: () => number) {
    this.getStreakMultiplier = getStreakMultiplier;
  }

  /**
   * Price a completed job at the CURRENT streak multiplier and bank it. Called
   * by JobDirector at the moment of delivery, before `job:delivered` goes out —
   * so the delivery that builds the streak is paid at the multiplier it had
   * when it started, and the next one gets the benefit.
   */
  award(job: ActiveJob): PayoutBreakdown {
    const payout = this.computePayout(job);
    this.total += payout.total;
    this.deliveries += 1;
    eventBus.emit("score:changed", {
      total: this.total,
      delta: payout.total,
      label: payout.label,
    });
    return payout;
  }

  /** Price a job without banking it — for previews and tests. */
  computePayout(job: ActiveJob): PayoutBreakdown {
    return computePayout(job, this.getStreakMultiplier());
  }

  /** Off-job cash (street pickups). Kept separate from delivery counting. */
  addCash(amount: number, label = "CASH"): number {
    const cash = Math.max(0, Math.round(finite(amount, 0)));
    if (cash <= 0) return 0;
    this.total += cash;
    eventBus.emit("score:changed", { total: this.total, delta: cash, label });
    return cash;
  }

  reset(): void {
    this.total = 0;
    this.deliveries = 0;
  }

  getTotal(): number {
    return this.total;
  }

  getDeliveries(): number {
    return this.deliveries;
  }
}
