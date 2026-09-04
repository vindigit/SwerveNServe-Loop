import * as THREE from "three";
import { CoronaConfig, JobConfig, ScoreConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import { Rng } from "@/core/rng";
import type { ActiveJob, PayoutBreakdown } from "@/core/types";
import { computeBaseCash, computePayout } from "@/modules/ScoreSystem";
import { PickupMarker } from "@/modules/PickupMarker";
import type { CollisionWorld } from "@/world/CollisionWorld";
import type { WorldLocation } from "@/world/types";

/**
 * JobDirector
 *
 * PICK UP → CHOOSE A ROUTE → DELIVER → NEXT JOB, with no dead air between them.
 * Owns the job lifecycle and the two markers that show it. Everything it draws
 * from is seeded, so a run replays identically from its seed.
 *
 * Collection is proximity-based — run through the corona and it is yours. This
 * is a speed game; stopping to press a button to accept a parcel is a tax on
 * the only thing the player is here to do.
 *
 * The one rule that must never bend: a job completes exactly once. Re-entering
 * a trigger after the drop is inert. Getting that wrong is not a glitch, it is
 * an infinite money exploit standing in the middle of the map.
 */

/**
 * Vertical slack on a trigger. The map has back stairs and roof runs — a marker
 * in the alley must not be collectable from the fire escape directly above it.
 */
const TRIGGER_VERTICAL_TOLERANCE = 3.0;

/** Planar distance. Elevation is scenery; a courier's route is measured on the map. */
function planarDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export interface JobPair {
  pickup: WorldLocation;
  delivery: WorldLocation;
}

/**
 * Draw the next pickup/delivery pair.
 *
 * Guarantees, in order of how hard they are held:
 *   1. pickup !== delivery. Absolute — there is no fallback that breaks this.
 *   2. At least `minPairDistance` apart, so a job is never a two-step shuffle.
 *   3. Neither endpoint appears in `recentIds` (the last `recentMemory`
 *      locations), so the neighbourhood keeps turning over.
 *
 * 3 relaxes before 2, and 2 relaxes to "the farthest available" before either
 * gives up: a thin location set should still produce a playable run rather than
 * silently stopping the job flow.
 *
 * Free function on purpose — job selection is the part most worth testing, and
 * it should be testable without a scene.
 */
export function selectJobPair(
  locations: readonly WorldLocation[],
  rng: Rng,
  recentIds: readonly string[]
): JobPair | null {
  if (locations.length < 2) return null;

  const fresh = locations.filter((l) => !recentIds.includes(l.id));
  // Need two fresh endpoints to honour the memory at all; otherwise ignore it.
  const pool = fresh.length >= 2 ? fresh : locations;

  const pickup = rng.pick(pool);

  const others = pool.filter((l) => l.id !== pickup.id);
  const farEnough = others.filter(
    (l) => planarDistance(l.position, pickup.position) >= JobConfig.minPairDistance
  );
  if (farEnough.length > 0) return { pickup, delivery: rng.pick(farEnough) };

  // Memory-respecting pool has nothing far enough — widen to the whole map.
  const allOthers = locations.filter((l) => l.id !== pickup.id);
  const allFarEnough = allOthers.filter(
    (l) => planarDistance(l.position, pickup.position) >= JobConfig.minPairDistance
  );
  if (allFarEnough.length > 0) return { pickup, delivery: rng.pick(allFarEnough) };

  // Nothing on the map clears the minimum: take the farthest, deterministically.
  let farthest = allOthers[0];
  let farthestDistance = -1;
  for (const candidate of allOthers) {
    const d = planarDistance(candidate.position, pickup.position);
    if (d > farthestDistance) {
      farthestDistance = d;
      farthest = candidate;
    }
  }
  return farthest ? { pickup, delivery: farthest } : null;
}

/**
 * Par for a job: the whole trip, player → pickup → delivery, at a pace between
 * a jog and a sprint. Par has to cover the run to the pickup because `elapsed`
 * starts the moment the job is accepted — otherwise no drop would ever be fast.
 */
export function computeParSeconds(toPickupMetres: number, pickupToDeliveryMetres: number): number {
  const metres = Math.max(0, toPickupMetres) + Math.max(0, pickupToDeliveryMetres);
  return Math.max(JobConfig.parFloorSeconds, metres * JobConfig.parSecondsPerMetre);
}

export class JobDirector {
  /**
   * Supplies the payout for a completed job. The Game points this at
   * `ScoreSystem.award` so the streak multiplier is applied in one place. Left
   * unset, jobs still pay — at ×1 — rather than paying nothing.
   */
  onComputePayout: ((job: ActiveJob) => PayoutBreakdown) | null = null;

  private readonly locations: WorldLocation[];
  private readonly scene: THREE.Object3D;
  private readonly pickupMarker: PickupMarker;
  private readonly deliveryMarker: PickupMarker;

  private rng = new Rng(1);
  private active: ActiveJob | null = null;
  private readonly recentIds: string[] = [];
  /** Every job that has already paid. The single-completion backstop. */
  private readonly completedIds = new Set<string>();
  private jobCounter = 0;
  private stopped = true;
  private disposed = false;
  private navTargetActive = false;

  constructor(locations: WorldLocation[], collision: CollisionWorld, scene: THREE.Object3D) {
    this.locations = locations;
    this.scene = scene;

    // Two pooled markers, positioned and shown per job — never rebuilt.
    this.pickupMarker = new PickupMarker("job", collision);
    this.deliveryMarker = new PickupMarker("job", collision);
    this.pickupMarker.setVisible(false);
    this.deliveryMarker.setVisible(false);
    this.scene.add(this.pickupMarker.object3d, this.deliveryMarker.object3d);
  }

  /**
   * Begin offering work. The first job is drawn on the first `update()`, once a
   * player position exists to measure par against.
   */
  start(seed: number): void {
    this.reset();
    this.rng = new Rng(seed);
    this.stopped = false;
  }

  update(dt: number, playerPosition: THREE.Vector3, cameraPosition: THREE.Vector3): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    if (!this.stopped) {
      if (!this.active) {
        this.offer(playerPosition);
      } else {
        this.active.elapsed += step;
        this.checkTriggers(playerPosition);
      }
    }

    this.pickupMarker.update(step, cameraPosition);
    this.deliveryMarker.update(step, cameraPosition);
  }

  getActive(): ActiveJob | null {
    return this.active;
  }

  /** Called by the Game when the run ends — stops offering work. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active = null;
    this.pickupMarker.setVisible(false);
    this.deliveryMarker.setVisible(false);
    this.clearNavTarget();
  }

  /** Wipe run state. Markers stay pooled; only what a new run must not inherit goes. */
  reset(): void {
    this.stopped = true;
    this.active = null;
    this.recentIds.length = 0;
    this.completedIds.clear();
    this.jobCounter = 0;
    this.pickupMarker.setVisible(false);
    this.deliveryMarker.setVisible(false);
    this.clearNavTarget();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.active = null;
    this.scene.remove(this.pickupMarker.object3d, this.deliveryMarker.object3d);
    this.pickupMarker.dispose();
    this.deliveryMarker.dispose();
  }

  /* ---------------------------------------------------------------- */

  private offer(playerPosition: THREE.Vector3): void {
    const pair = selectJobPair(this.locations, this.rng, this.recentIds);
    if (!pair) {
      // Nothing to offer (map has fewer than two locations). Don't leave the
      // HUD pointing at a target the player already reached.
      this.clearNavTarget();
      return;
    }

    this.remember(pair.pickup.id);
    this.remember(pair.delivery.id);

    const distance = planarDistance(pair.pickup.position, pair.delivery.position);
    const toPickup = planarDistance(playerPosition, pair.pickup.position);
    const baseCash = computeBaseCash(distance, pair.delivery.reach);

    this.jobCounter += 1;
    const job: ActiveJob = {
      id: `job-${this.jobCounter}`,
      pickup: pair.pickup,
      delivery: pair.delivery,
      stage: "offered",
      distance,
      parSeconds: computeParSeconds(toPickup, distance),
      baseCash: Math.round(baseCash),
      // The most the speed term can pay, for the job card. The actual bonus is
      // computed from `elapsed` at the drop.
      fastBonus: Math.round(baseCash * ScoreConfig.fastBonusFraction),
      elapsed: 0,
    };

    this.active = job;
    this.pickupMarker.setPosition(pair.pickup.position);
    this.deliveryMarker.setPosition(pair.delivery.position);
    this.pickupMarker.setVisible(true);
    this.deliveryMarker.setVisible(false);

    eventBus.emit("job:offered", { job });

    // Acceptance is automatic — the loop is the game, the paperwork is not.
    job.stage = "toPickup";
    eventBus.emit("job:accepted", { job });
    this.pushNavTarget("pickup");
  }

  private checkTriggers(playerPosition: THREE.Vector3): void {
    const job = this.active;
    if (!job) return;

    if (job.stage === "toPickup") {
      if (!this.inTrigger(playerPosition, job.pickup.position)) return;
      job.stage = "toDelivery";
      this.pickupMarker.setVisible(false);
      this.deliveryMarker.setVisible(true);
      eventBus.emit("job:pickedUp", { job });
      this.pushNavTarget("delivery");
      return;
    }

    if (job.stage === "toDelivery") {
      if (!this.inTrigger(playerPosition, job.delivery.position)) return;
      this.completeDelivery(job);
    }
  }

  /**
   * The only place a job pays. Three independent locks, because a double payout
   * is a score exploit rather than a visual glitch:
   *   - the stage gate above (only `toDelivery` reaches here),
   *   - `completedIds`, which survives even a re-entrant call,
   *   - clearing `this.active` before anything is emitted, so a listener that
   *     calls back into the director finds no job to complete.
   */
  private completeDelivery(job: ActiveJob): void {
    if (this.completedIds.has(job.id)) return;
    this.completedIds.add(job.id);

    job.stage = "done";
    this.active = null;
    this.deliveryMarker.setVisible(false);

    const payout = this.onComputePayout?.(job) ?? computePayout(job, 1);
    eventBus.emit("job:delivered", { job, payout });
    // The next job is drawn on the next update(), which keeps offer/complete off
    // the same call stack. The nav target is deliberately left pointing at the
    // drop for that one frame so the HUD indicator doesn't blink.
  }

  private inTrigger(playerPosition: THREE.Vector3, target: THREE.Vector3): boolean {
    if (Math.abs(playerPosition.y - target.y) > TRIGGER_VERTICAL_TOLERANCE) return false;
    return planarDistance(playerPosition, target) <= JobConfig.triggerRadius;
  }

  private remember(id: string): void {
    this.recentIds.push(id);
    while (this.recentIds.length > JobConfig.recentMemory) this.recentIds.shift();
  }

  private pushNavTarget(kind: "pickup" | "delivery"): void {
    const job = this.active;
    if (!job) return;
    const location = kind === "pickup" ? job.pickup : job.delivery;
    // Aim at the corona, not the player's feet, and hand out a copy so the HUD
    // can never write into authored world data.
    const p = location.position;
    eventBus.emit("nav:target", {
      target: {
        position: new THREE.Vector3(p.x, p.y + CoronaConfig.meshFloatHeight, p.z),
        label: location.name,
        kind,
        zone: location.zone,
      },
    });
    this.navTargetActive = true;
  }

  private clearNavTarget(): void {
    if (!this.navTargetActive) return;
    this.navTargetActive = false;
    eventBus.emit("nav:target", { target: null });
  }
}
