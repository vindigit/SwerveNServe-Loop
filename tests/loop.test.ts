import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoronaConfig, JobConfig, RunConfig, ScoreConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import { resolveFrameTiming } from "@/core/frameTiming";
import { Rng } from "@/core/rng";
import { loadBest, loadLook } from "@/core/storage";
import type { ActiveJob, PayoutBreakdown } from "@/core/types";
import { JobDirector, computeParSeconds, selectJobPair } from "@/modules/JobDirector";
import { ObjectiveArrow } from "@/modules/ObjectiveArrow";
import { RunTimer } from "@/modules/RunTimer";
import {
  ScoreSystem,
  clampStreakMultiplier,
  computeBaseCash,
  computePayout,
  computeSpeedFraction,
} from "@/modules/ScoreSystem";
import { PickupMarker, disposeSharedPickupAssets } from "@/modules/PickupMarker";
import { StreakSystem } from "@/modules/StreakSystem";
import { worldOffsetToMinimap } from "@/ui/Minimap";
import { CollisionWorld } from "@/world/CollisionWorld";
import type { WorldLocation } from "@/world/types";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeLocation(
  id: string,
  x: number,
  z: number,
  reach: WorldLocation["reach"] = "easy"
): WorldLocation {
  return {
    id,
    name: id.toUpperCase(),
    zone: "avenue",
    position: new THREE.Vector3(x, 0, z),
    facingRad: 0,
    reach,
  };
}

/** Eight endpoints spread wide enough that every pair clears minPairDistance. */
function makeLocationRing(count = 8, radius = 80): WorldLocation[] {
  const out: WorldLocation[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push(makeLocation(`loc-${i}`, Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return out;
}

function makeJob(overrides: Partial<ActiveJob> = {}): ActiveJob {
  const pickup = makeLocation("p", 0, 0);
  const delivery = makeLocation("d", 100, 0);
  return {
    id: "job-test",
    pickup,
    delivery,
    stage: "toDelivery",
    distance: 100,
    parSeconds: 20,
    baseCash: 1000,
    fastBonus: 600,
    elapsed: 0,
    ...overrides,
  };
}

function emptyCollision(): CollisionWorld {
  return new CollisionWorld([], { minX: -200, maxX: 200, minZ: -200, maxZ: 200 });
}

describe("minimap projection", () => {
  it("keeps forward targets above the player marker", () => {
    expect(worldOffsetToMinimap(0, -10, 0, 1)).toEqual({ x: 0, y: -10 });
  });

  it("rotates the world beneath the fixed player marker", () => {
    const projected = worldOffsetToMinimap(10, 0, Math.PI / 2, 1);
    expect(projected.x).toBeCloseTo(0, 8);
    expect(projected.y).toBeCloseTo(-10, 8);
  });
});

describe("ObjectiveArrow", () => {
  it("appears over the courier and points toward the active target", () => {
    const scene = new THREE.Scene();
    const arrow = new ObjectiveArrow(scene);
    const target = makeLocation("target", 10, 0);
    eventBus.emit("nav:target", {
      target: { position: target.position, label: target.name, kind: "pickup", zone: target.zone },
    });
    arrow.update(0, new THREE.Vector3(0, 0, 0));

    expect(arrow.object3d.visible).toBe(true);
    expect(arrow.object3d.position.y).toBeCloseTo(3.25, 6);
    expect(arrow.object3d.rotation.y).toBeCloseTo(-Math.PI / 2, 6);

    eventBus.emit("nav:target", { target: null });
    expect(arrow.object3d.visible).toBe(false);
    arrow.dispose();
  });
});

beforeEach(() => {
  eventBus.reset();
});

/* ------------------------------------------------------------------ *
 * Payout maths
 * ------------------------------------------------------------------ */

describe("payout maths", () => {
  it("bases cash on distance, floors it, and applies the reach multiplier", () => {
    expect(computeBaseCash(100, "easy")).toBeCloseTo(100 * ScoreConfig.cashPerMetre, 6);
    expect(computeBaseCash(100, "medium")).toBeCloseTo(
      100 * ScoreConfig.cashPerMetre * ScoreConfig.reachMultiplier.medium,
      6
    );
    expect(computeBaseCash(100, "risky")).toBeCloseTo(
      100 * ScoreConfig.cashPerMetre * ScoreConfig.reachMultiplier.risky,
      6
    );
    // Below the floor, minBaseCash takes over (then still gets the multiplier).
    expect(computeBaseCash(1, "easy")).toBe(ScoreConfig.minBaseCash);
    expect(computeBaseCash(0, "risky")).toBeCloseTo(
      ScoreConfig.minBaseCash * ScoreConfig.reachMultiplier.risky,
      6
    );
  });

  it("pays the speed bonus in full under par", () => {
    const payout = computePayout(makeJob({ elapsed: 5, parSeconds: 20 }), 1);
    expect(computeSpeedFraction(5, 20)).toBe(1);
    expect(payout.base).toBe(1000);
    expect(payout.speed).toBe(Math.round(1000 * ScoreConfig.fastBonusFraction));
    expect(payout.label).toBe("FAST DROP");
  });

  it("pays the speed bonus in full exactly at par", () => {
    const payout = computePayout(makeJob({ elapsed: 20, parSeconds: 20 }), 1);
    expect(computeSpeedFraction(20, 20)).toBe(1);
    expect(payout.speed).toBe(Math.round(1000 * ScoreConfig.fastBonusFraction));
    expect(payout.label).toBe("FAST DROP");
  });

  it("decays the speed bonus linearly past par", () => {
    // Halfway between par and 2x par -> half the bonus, and no longer "fast".
    expect(computeSpeedFraction(30, 20)).toBeCloseTo(0.5, 6);
    const payout = computePayout(makeJob({ elapsed: 30, parSeconds: 20 }), 1);
    expect(payout.speed).toBe(Math.round(1000 * ScoreConfig.fastBonusFraction * 0.5));
    expect(payout.label).toBe("DELIVERED");
  });

  it("pays no speed bonus at exactly 2x par", () => {
    expect(computeSpeedFraction(40, 20)).toBe(0);
    const payout = computePayout(makeJob({ elapsed: 40, parSeconds: 20 }), 1);
    expect(payout.speed).toBe(0);
    expect(payout.total).toBe(payout.base);
    expect(payout.label).toBe("DELIVERED");
  });

  it("never goes negative beyond 2x par", () => {
    for (const elapsed of [41, 100, 10_000]) {
      const payout = computePayout(makeJob({ elapsed, parSeconds: 20 }), 1);
      expect(computeSpeedFraction(elapsed, 20)).toBe(0);
      expect(payout.speed).toBe(0);
      expect(payout.total).toBeGreaterThan(0);
      expect(payout.total).toBe(payout.base);
    }
  });

  it("applies the streak multiplier and caps it", () => {
    const job = makeJob({ elapsed: 40, parSeconds: 20 }); // base only, easy to read
    expect(computePayout(job, 1).total).toBe(1000);
    expect(computePayout(job, 1.15).total).toBe(1150);
    expect(computePayout(job, 2).total).toBe(2000);

    // Above the cap it pays the cap, not the number it was handed.
    expect(clampStreakMultiplier(99)).toBe(ScoreConfig.maxStreakMultiplier);
    expect(computePayout(job, 99).total).toBe(1000 * ScoreConfig.maxStreakMultiplier);
    // Below 1 it is clamped up — a multiplier can never cost the player cash.
    expect(clampStreakMultiplier(0)).toBe(1);
    expect(computePayout(job, 0).total).toBe(1000);
  });

  it("keeps the breakdown adding up to the total", () => {
    for (const multiplier of [1, 1.15, 1.3, 2.5]) {
      for (const elapsed of [0, 13, 20, 27, 40, 90]) {
        const payout = computePayout(makeJob({ elapsed, parSeconds: 20 }), multiplier);
        expect(payout.base + payout.speed + payout.streak).toBe(payout.total);
        expect(Number.isInteger(payout.total)).toBe(true);
      }
    }
  });

  it("never returns NaN or a negative payout for malformed jobs", () => {
    const malformed: ActiveJob[] = [
      makeJob({ parSeconds: 0 }),
      makeJob({ parSeconds: Number.NaN }),
      makeJob({ elapsed: Number.NaN }),
      makeJob({ baseCash: Number.NaN }),
      makeJob({ baseCash: -500 }),
      makeJob({ distance: Number.NaN, baseCash: Number.NaN }),
      makeJob({ distance: -100, baseCash: 0 }),
    ];
    for (const job of malformed) {
      const payout = computePayout(job, Number.NaN);
      for (const value of [payout.base, payout.speed, payout.streak, payout.total]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("banks payouts and reports the running total", () => {
    let multiplier = 1;
    const score = new ScoreSystem(() => multiplier);
    const changes: Array<{ total: number; delta: number }> = [];
    eventBus.on("score:changed", (e) => changes.push({ total: e.total, delta: e.delta }));

    const first = score.award(makeJob({ id: "a", elapsed: 40, parSeconds: 20 }));
    expect(first.total).toBe(1000);
    multiplier = 1.5;
    const second = score.award(makeJob({ id: "b", elapsed: 40, parSeconds: 20 }));
    expect(second.total).toBe(1500);

    expect(score.getTotal()).toBe(2500);
    expect(score.getDeliveries()).toBe(2);
    expect(changes).toEqual([
      { total: 1000, delta: 1000 },
      { total: 2500, delta: 1500 },
    ]);

    score.reset();
    expect(score.getTotal()).toBe(0);
    expect(score.getDeliveries()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Streak
 * ------------------------------------------------------------------ */

describe("StreakSystem", () => {
  let streak: StreakSystem;

  beforeEach(() => {
    streak = new StreakSystem();
  });

  afterEach(() => {
    streak.dispose();
  });

  it("increments on delivery and steps the multiplier", () => {
    expect(streak.getCount()).toBe(0);
    expect(streak.getMultiplier()).toBe(1);

    streak.registerDelivery(makeJob({ id: "a", elapsed: 10, parSeconds: 20 }));
    expect(streak.getCount()).toBe(1);
    expect(streak.getMultiplier()).toBeCloseTo(1 + ScoreConfig.streakMultiplierStep, 6);

    streak.registerDelivery(makeJob({ id: "b", elapsed: 10, parSeconds: 20 }));
    expect(streak.getCount()).toBe(2);
    expect(streak.getMultiplier()).toBeCloseTo(1 + 2 * ScoreConfig.streakMultiplierStep, 6);
  });

  it("caps the multiplier", () => {
    for (let i = 0; i < 60; i++) {
      streak.registerDelivery(makeJob({ id: `j${i}`, elapsed: 1, parSeconds: 20 }));
    }
    expect(streak.getCount()).toBe(60);
    expect(streak.getMultiplier()).toBe(ScoreConfig.maxStreakMultiplier);
  });

  it("breaks when a delivery runs past the par multiple", () => {
    streak.registerDelivery(makeJob({ id: "a", elapsed: 10, parSeconds: 20 }));
    streak.registerDelivery(makeJob({ id: "b", elapsed: 10, parSeconds: 20 }));
    expect(streak.getCount()).toBe(2);

    // Exactly at the multiple still counts; a hair past it does not.
    const limit = 20 * ScoreConfig.streakBreakParMultiple;
    streak.registerDelivery(makeJob({ id: "c", elapsed: limit, parSeconds: 20 }));
    expect(streak.getCount()).toBe(3);

    streak.registerDelivery(makeJob({ id: "d", elapsed: limit + 0.1, parSeconds: 20 }));
    expect(streak.getCount()).toBe(0);
    expect(streak.getMultiplier()).toBe(1);
  });

  it("remembers the best streak of the run and resets everything", () => {
    for (const id of ["a", "b", "c", "d"]) {
      streak.registerDelivery(makeJob({ id, elapsed: 5, parSeconds: 20 }));
    }
    expect(streak.getCount()).toBe(4);
    expect(streak.getBest()).toBe(4);

    streak.break();
    expect(streak.getCount()).toBe(0);
    expect(streak.getBest()).toBe(4);

    streak.reset();
    expect(streak.getCount()).toBe(0);
    expect(streak.getBest()).toBe(0);
    expect(streak.getMultiplier()).toBe(1);
  });

  it("ignores a duplicated delivery event for the same job", () => {
    const job = makeJob({ id: "same", elapsed: 5, parSeconds: 20 });
    streak.registerDelivery(job);
    streak.registerDelivery(job);
    streak.registerDelivery(job);
    expect(streak.getCount()).toBe(1);
  });

  it("emits streak:changed and follows the bus", () => {
    const seen: number[] = [];
    eventBus.on("streak:changed", (e) => seen.push(e.count));
    // Constructed after the reset in the outer beforeEach, so it is subscribed.
    eventBus.emit("job:delivered", {
      job: makeJob({ id: "bus", elapsed: 5, parSeconds: 20 }),
      payout: { base: 1, speed: 0, streak: 0, total: 1, label: "DELIVERED" } as PayoutBreakdown,
    });
    expect(streak.getCount()).toBe(1);
    expect(seen).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ *
 * Timer
 * ------------------------------------------------------------------ */

describe("RunTimer", () => {
  it("counts down frame-rate independently", () => {
    const timer = new RunTimer(10);
    timer.start();
    expect(timer.getRemainingSeconds()).toBe(10);

    for (let i = 0; i < 60; i++) timer.update(1 / 60);
    expect(timer.getRemainingSeconds()).toBeCloseTo(9, 5);

    const coarse = new RunTimer(10);
    coarse.start();
    for (let i = 0; i < 6; i++) coarse.update(1 / 6);
    expect(coarse.getRemainingSeconds()).toBeCloseTo(9, 5);
  });

  it("expires exactly once no matter how long it is updated afterwards", () => {
    let expiries = 0;
    const timer = new RunTimer(2);
    timer.onExpire = () => {
      expiries += 1;
    };
    timer.start();

    for (let i = 0; i < 100; i++) timer.update(0.1);
    expect(expiries).toBe(1);
    expect(timer.isExpired()).toBe(true);
    expect(timer.isRunning()).toBe(false);

    // A restart re-arms it, and it fires once more — not twice.
    timer.start();
    expect(timer.isExpired()).toBe(false);
    for (let i = 0; i < 100; i++) timer.update(0.1);
    expect(expiries).toBe(2);
  });

  it("never goes negative", () => {
    const timer = new RunTimer(1);
    timer.start();
    timer.update(500);
    expect(timer.getRemainingSeconds()).toBe(0);
    expect(timer.getFraction()).toBe(0);
    timer.update(500);
    expect(timer.getRemainingSeconds()).toBe(0);

    const drained = new RunTimer(5);
    drained.start();
    drained.subtractTime(9999);
    expect(drained.getRemainingSeconds()).toBe(0);
  });

  it("pauses and resumes without losing or gaining time", () => {
    const timer = new RunTimer(10);
    timer.start();
    timer.update(1);
    timer.setPaused(true);
    for (let i = 0; i < 100; i++) timer.update(1);
    expect(timer.getRemainingSeconds()).toBeCloseTo(9, 5);
    expect(timer.isRunning()).toBe(false);

    timer.setPaused(false);
    expect(timer.isRunning()).toBe(true);
    timer.update(1);
    expect(timer.getRemainingSeconds()).toBeCloseTo(8, 5);
  });

  it("emits run:tick with a remaining time and a fraction", () => {
    const ticks: Array<{ remainingSeconds: number; fraction: number }> = [];
    eventBus.on("run:tick", (e) => ticks.push(e));

    const timer = new RunTimer(10);
    timer.start();
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toEqual({ remainingSeconds: 10, fraction: 1 });

    for (let i = 0; i < 60; i++) timer.update(1 / 60);
    const last = ticks[ticks.length - 1];
    expect(last.remainingSeconds).toBeCloseTo(9, 2);
    expect(last.fraction).toBeCloseTo(0.9, 2);
  });

  it("ignores junk deltas and caps bonus time at the run length", () => {
    const timer = new RunTimer(10);
    timer.start();
    timer.update(Number.NaN);
    timer.update(-5);
    timer.update(Number.POSITIVE_INFINITY);
    expect(timer.getRemainingSeconds()).toBe(10);

    timer.update(4);
    timer.addTime(100);
    expect(timer.getRemainingSeconds()).toBe(10);
  });

  it("defaults to the configured run length", () => {
    const timer = new RunTimer();
    timer.start();
    expect(timer.getRemainingSeconds()).toBe(RunConfig.durationSeconds);
    expect(timer.isUrgent()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Frame timing
 * ------------------------------------------------------------------ */

describe("frame timing", () => {
  it("caps physics after a hitch without gifting the active run clock time", () => {
    const timing = resolveFrameTiming(0.3, true);
    expect(timing.physicsDt).toBe(RunConfig.maxDeltaSeconds);
    expect(timing.runDt).toBeCloseTo(0.3, 6);
  });

  it("advances neither simulation nor the run clock while paused", () => {
    expect(resolveFrameTiming(10, false)).toEqual({ physicsDt: 0, runDt: 0 });
  });

  it("rejects invalid frame deltas", () => {
    expect(resolveFrameTiming(Number.NaN, true)).toEqual({ physicsDt: 0, runDt: 0 });
    expect(resolveFrameTiming(-1, true)).toEqual({ physicsDt: 0, runDt: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * Job selection
 * ------------------------------------------------------------------ */

describe("job selection", () => {
  it("never pairs a location with itself", () => {
    const locations = makeLocationRing(8, 80);
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const pair = selectJobPair(locations, rng, []);
      expect(pair).not.toBeNull();
      expect(pair!.pickup.id).not.toBe(pair!.delivery.id);
    }
  });

  it("never pairs a location with itself even when the map is cramped", () => {
    // Every pair is far below minPairDistance: the fallback still must not
    // return the same location twice.
    const cramped = [makeLocation("a", 0, 0), makeLocation("b", 3, 0), makeLocation("c", 0, 3)];
    const rng = new Rng(11);
    for (let i = 0; i < 200; i++) {
      const pair = selectJobPair(cramped, rng, []);
      expect(pair!.pickup.id).not.toBe(pair!.delivery.id);
    }
  });

  it("respects the minimum pair distance when the map allows it", () => {
    const locations = makeLocationRing(10, 90);
    const rng = new Rng(3);
    for (let i = 0; i < 500; i++) {
      const pair = selectJobPair(locations, rng, [])!;
      const dx = pair.pickup.position.x - pair.delivery.position.x;
      const dz = pair.pickup.position.z - pair.delivery.position.z;
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(JobConfig.minPairDistance);
    }
  });

  it("excludes the last recentMemory locations from the next draw", () => {
    const locations = makeLocationRing(9, 100);
    const rng = new Rng(21);
    const recent: string[] = [];

    for (let job = 0; job < 60; job++) {
      const pair = selectJobPair(locations, rng, recent)!;
      expect(recent).not.toContain(pair.pickup.id);
      expect(recent).not.toContain(pair.delivery.id);

      recent.push(pair.pickup.id, pair.delivery.id);
      while (recent.length > JobConfig.recentMemory) recent.shift();
      // Two endpoints are remembered per job, trimmed to the memory window.
      expect(recent.length).toBe(Math.min(2 * (job + 1), JobConfig.recentMemory));
    }
  });

  it("is reproducible under the same seed and varies with a different one", () => {
    const locations = makeLocationRing(8, 80);
    const sequence = (seed: number): string[] => {
      const rng = new Rng(seed);
      const recent: string[] = [];
      const out: string[] = [];
      for (let i = 0; i < 25; i++) {
        const pair = selectJobPair(locations, rng, recent)!;
        out.push(`${pair.pickup.id}>${pair.delivery.id}`);
        recent.push(pair.pickup.id, pair.delivery.id);
        while (recent.length > JobConfig.recentMemory) recent.shift();
      }
      return out;
    };

    expect(sequence(1234)).toEqual(sequence(1234));
    expect(sequence(1234)).not.toEqual(sequence(9999));
  });

  it("returns null when there is nothing to pair", () => {
    expect(selectJobPair([], new Rng(1), [])).toBeNull();
    expect(selectJobPair([makeLocation("only", 0, 0)], new Rng(1), [])).toBeNull();
  });

  it("sets par from the whole trip, with a floor", () => {
    expect(computeParSeconds(0, 0)).toBe(JobConfig.parFloorSeconds);
    expect(computeParSeconds(320, 320)).toBeCloseTo(640 * JobConfig.parSecondsPerMetre, 6);
    expect(computeParSeconds(-50, 320)).toBeCloseTo(320 * JobConfig.parSecondsPerMetre, 6);
  });
});

/* ------------------------------------------------------------------ *
 * The loop, end to end
 * ------------------------------------------------------------------ */

describe("JobDirector", () => {
  const camera = new THREE.Vector3(0, 2, 12);

  function runDirector(locations = makeLocationRing(8, 80)) {
    const scene = new THREE.Group();
    const director = new JobDirector(locations, emptyCollision(), scene);
    return { director, scene };
  }

  /** Teleport onto a target and tick until the trigger fires. */
  function walkTo(director: JobDirector, target: THREE.Vector3, ticks = 2): void {
    const at = target.clone();
    for (let i = 0; i < ticks; i++) director.update(1 / 60, at, camera);
  }

  it("offers exactly one job at a time and points the HUD at it", () => {
    const targets: Array<string | null> = [];
    eventBus.on("nav:target", (e) => targets.push(e.target ? `${e.target.kind}:${e.target.label}` : null));
    const offered: string[] = [];
    eventBus.on("job:offered", (e) => offered.push(e.job.id));

    const { director } = runDirector();
    director.start(42);
    expect(director.getActive()).toBeNull(); // nothing until the first update

    const origin = new THREE.Vector3(0, 0, 0);
    director.update(1 / 60, origin, camera);
    const job = director.getActive();
    expect(job).not.toBeNull();
    expect(job!.stage).toBe("toPickup");
    expect(job!.pickup.id).not.toBe(job!.delivery.id);
    expect(offered).toEqual([job!.id]);
    expect(targets[0]).toBe(`pickup:${job!.pickup.name}`);

    // Idling does not stack up more jobs.
    for (let i = 0; i < 120; i++) director.update(1 / 60, origin, camera);
    expect(offered).toEqual([job!.id]);
    expect(director.getActive()!.id).toBe(job!.id);
    expect(director.getActive()!.elapsed).toBeGreaterThan(1.5);

    director.dispose();
  });

  it("runs pickup -> delivery -> next job, paying exactly once", () => {
    const delivered: Array<{ id: string; total: number }> = [];
    eventBus.on("job:delivered", (e) => delivered.push({ id: e.job.id, total: e.payout.total }));
    const pickedUp: string[] = [];
    eventBus.on("job:pickedUp", (e) => pickedUp.push(e.job.id));

    const { director } = runDirector();
    const streak = new StreakSystem();
    const score = new ScoreSystem(() => streak.getMultiplier());
    director.onComputePayout = (job) => score.award(job);

    director.start(2024);
    director.update(1 / 60, new THREE.Vector3(0, 0, 0), camera);
    const job = director.getActive()!;

    walkTo(director, job.pickup.position);
    expect(pickedUp).toEqual([job.id]);
    expect(director.getActive()!.stage).toBe("toDelivery");

    walkTo(director, job.delivery.position);
    expect(delivered.length).toBe(1);
    expect(delivered[0].id).toBe(job.id);
    expect(delivered[0].total).toBeGreaterThan(0);
    expect(score.getDeliveries()).toBe(1);
    expect(streak.getCount()).toBe(1);

    // A new job is drawn on the following tick, without a press.
    const next = director.getActive();
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(job.id);

    streak.dispose();
    director.dispose();
  });

  it("cannot be paid twice for the same delivery", () => {
    const delivered: string[] = [];
    eventBus.on("job:delivered", (e) => delivered.push(e.job.id));

    const { director } = runDirector();
    const score = new ScoreSystem(() => 1);
    director.onComputePayout = (job) => score.award(job);

    director.start(5150);
    director.update(1 / 60, new THREE.Vector3(0, 0, 0), camera);
    const job = director.getActive()!;
    const dropPoint = job.delivery.position.clone();

    walkTo(director, job.pickup.position);
    walkTo(director, dropPoint);
    expect(delivered).toEqual([job.id]);
    const bankedOnce = score.getTotal();

    // Stand in the drop-off and grind on it. The completed job must be inert;
    // whatever else happens, it never pays again.
    for (let i = 0; i < 300; i++) director.update(1 / 60, dropPoint, camera);
    expect(delivered.filter((id) => id === job.id).length).toBe(1);
    expect(score.getTotal()).toBeGreaterThanOrEqual(bankedOnce);
    expect(score.getDeliveries()).toBe(delivered.length);

    director.dispose();
  });

  it("does not collect a marker from the roof directly above it", () => {
    const { director } = runDirector();
    director.start(99);
    director.update(1 / 60, new THREE.Vector3(0, 0, 0), camera);
    const job = director.getActive()!;

    const above = job.pickup.position.clone();
    above.y += 8;
    for (let i = 0; i < 30; i++) director.update(1 / 60, above, camera);
    expect(director.getActive()!.stage).toBe("toPickup");

    walkTo(director, job.pickup.position);
    expect(director.getActive()!.stage).toBe("toDelivery");

    director.dispose();
  });

  it("offers no further work after stop()", () => {
    const offered: string[] = [];
    eventBus.on("job:offered", (e) => offered.push(e.job.id));
    const targets: Array<string | null> = [];
    eventBus.on("nav:target", (e) => targets.push(e.target ? e.target.kind : null));

    const { director } = runDirector();
    director.start(7);
    director.update(1 / 60, new THREE.Vector3(0, 0, 0), camera);
    const job = director.getActive()!;
    expect(offered.length).toBe(1);

    director.stop();
    expect(director.getActive()).toBeNull();
    expect(targets[targets.length - 1]).toBeNull();

    // Standing on the old markers, ticking for ten seconds: nothing at all.
    for (let i = 0; i < 300; i++) director.update(1 / 60, job.pickup.position, camera);
    for (let i = 0; i < 300; i++) director.update(1 / 60, job.delivery.position, camera);
    expect(offered.length).toBe(1);
    expect(director.getActive()).toBeNull();

    director.dispose();
  });

  it("replays identically from the same seed and differs on another", () => {
    const trace = (seed: number): string[] => {
      const { director } = runDirector();
      const out: string[] = [];
      const off = eventBus.on("job:delivered", (e) => out.push(`${e.job.pickup.id}>${e.job.delivery.id}`));
      director.start(seed);
      director.update(1 / 60, new THREE.Vector3(0, 0, 0), camera);
      for (let i = 0; i < 6; i++) {
        const job = director.getActive();
        if (!job) break;
        walkTo(director, job.pickup.position);
        walkTo(director, job.delivery.position);
      }
      off();
      director.dispose();
      return out;
    };

    expect(trace(31337)).toEqual(trace(31337));
    expect(trace(31337)).not.toEqual(trace(4242));
  });

  it("resets cleanly for the next run without leaking scene objects", () => {
    const { director, scene } = runDirector();
    const objectsAfterConstruction = scene.children.length;

    for (let run = 0; run < 5; run++) {
      director.start(run + 1);
      director.update(1 / 60, new THREE.Vector3(0, 0, 0), camera);
      const job = director.getActive()!;
      walkTo(director, job.pickup.position);
      walkTo(director, job.delivery.position);
      director.stop();
      director.reset();
      expect(director.getActive()).toBeNull();
      expect(scene.children.length).toBe(objectsAfterConstruction);
    }

    director.dispose();
    expect(scene.children.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Pickup markers — the corona language
 * ------------------------------------------------------------------ */

describe("PickupMarker", () => {
  /** The single additive billboard in a marker's subtree. */
  function coronaOf(marker: PickupMarker): THREE.Mesh {
    const found: THREE.Mesh[] = [];
    marker.object3d.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const material = mesh.material as THREE.Material | undefined;
      if (mesh.isMesh && material && material.blending === THREE.AdditiveBlending) found.push(mesh);
    });
    expect(found.length).toBe(1); // exactly ONE billboard, never a stack of them
    return found[0];
  }

  function coronaAlpha(marker: PickupMarker): number {
    const corona = coronaOf(marker);
    if (!corona.visible) return 0;
    const colors = (corona.geometry as THREE.BufferGeometry).getAttribute("color");
    return (colors.array as Float32Array)[0];
  }

  afterEach(() => {
    disposeSharedPickupAssets();
  });

  it("builds an unlit additive billboard that never writes depth or takes fog", () => {
    const marker = new PickupMarker("cash", emptyCollision());
    const material = coronaOf(marker).material as THREE.MeshBasicMaterial;

    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial); // unlit
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.fog).toBe(false);
    marker.dispose();
  });

  it("paints a near-white core, a category-coloured body and a transparent edge", () => {
    const marker = new PickupMarker("cash", emptyCollision());
    const texture = ((coronaOf(marker).material as THREE.MeshBasicMaterial).map ??
      null) as THREE.DataTexture | null;
    expect(texture).not.toBeNull();

    const data = texture!.image.data as Uint8Array;
    const size = texture!.image.width as number;
    const px = (x: number, y: number): number[] => {
      const i = (y * size + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    const centre = size >> 1;

    const core = px(centre, centre);
    expect(core[3]).toBe(255);
    expect(Math.min(core[0], core[1], core[2])).toBeGreaterThan(200); // near white

    const body = px(centre + Math.round(size * 0.25), centre);
    const [r, g, b] = body;
    expect(g).toBeGreaterThan(r + 60); // the cash green, not white
    expect(g).toBeGreaterThan(b + 60);
    expect(body[3]).toBeGreaterThan(60);

    expect(px(0, 0)[3]).toBe(0); // fully transparent at the edge
    marker.dispose();
  });

  it("contains only the item and billboard — no beam, ring, arrow or light", () => {
    const marker = new PickupMarker("job", emptyCollision());
    let lights = 0;
    let meshes = 0;
    marker.object3d.traverse((o) => {
      if ((o as THREE.Light).isLight) lights += 1;
      if ((o as THREE.Mesh).isMesh) meshes += 1;
      expect((o as THREE.Points).isPoints).toBeFalsy();
      expect((o as THREE.Line).isLine).toBeFalsy();
      expect((o as THREE.Sprite).isSprite).toBeFalsy();
    });
    expect(lights).toBe(0);
    expect(meshes).toBe(3); // parcel body + tape + corona
    marker.dispose();
  });

  it("turns the item continuously about Y and bobs it above the ground", () => {
    const marker = new PickupMarker("job", emptyCollision());
    const camera = new THREE.Vector3(0, 2, 8);
    marker.setPosition(new THREE.Vector3(0, 0, 0));

    const spinner = marker.object3d.children[0] as THREE.Group;
    const startY = spinner.rotation.y;
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let i = 0; i < 120; i++) {
      marker.update(1 / 60, camera);
      minHeight = Math.min(minHeight, spinner.position.y);
      maxHeight = Math.max(maxHeight, spinner.position.y);
    }
    // Two seconds at 1.9 rad/s is more than half a turn, wrapped into 0..2π.
    expect(spinner.rotation.y).not.toBeCloseTo(startY, 3);
    expect(spinner.rotation.y).toBeGreaterThanOrEqual(0);
    expect(spinner.rotation.y).toBeLessThanOrEqual(Math.PI * 2);
    expect(minHeight).toBeGreaterThan(0);
    expect(maxHeight - minHeight).toBeCloseTo(2 * CoronaConfig.meshBobAmplitude, 2);
    marker.dispose();
  });

  it("hides the corona behind a wall and fades it back when the line clears", () => {
    // One building slab across z = 4..6; the marker sits at the origin.
    const collision = new CollisionWorld(
      [{ minX: -20, maxX: 20, minZ: 4, maxZ: 6, minY: 0, maxY: 9, kind: "wall", tag: "rowhouse" }],
      { minX: -40, maxX: 40, minZ: -40, maxZ: 40 }
    );
    const marker = new PickupMarker("job", collision);
    marker.setPosition(new THREE.Vector3(0, 0, 0));

    const blocked = new THREE.Vector3(0, 2, 20); // wall between camera and marker
    const clear = new THREE.Vector3(20, 2, 0); // straight down the street

    marker.update(1 / 60, blocked);
    expect(coronaAlpha(marker)).toBe(0);
    expect(coronaOf(marker).visible).toBe(false);

    // It comes back over a short cross-fade rather than popping on.
    marker.update(1 / 60, clear);
    const firstFrame = coronaAlpha(marker);
    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(1);
    for (let i = 0; i < 60; i++) marker.update(1 / 60, clear);
    expect(coronaAlpha(marker)).toBeCloseTo(1, 3);

    // And goes away again when a wall gets in front of it.
    for (let i = 0; i < 60; i++) marker.update(1 / 60, blocked);
    expect(coronaAlpha(marker)).toBe(0);

    marker.dispose();
  });

  it("scales conservatively with distance and fades out before the far plane", () => {
    const marker = new PickupMarker("cash", emptyCollision());
    marker.setPosition(new THREE.Vector3(0, 0, 0));
    const corona = coronaOf(marker);

    marker.update(1 / 60, new THREE.Vector3(0, 1, 2));
    expect(corona.scale.x).toBeCloseTo(
      CoronaConfig.spriteWorldSize * CoronaConfig.spriteMinScale,
      1
    );
    expect(coronaAlpha(marker)).toBeCloseTo(1, 3);

    marker.update(1 / 60, new THREE.Vector3(0, 1, CoronaConfig.spriteFadeStart + 5));
    expect(corona.scale.x).toBeCloseTo(
      CoronaConfig.spriteWorldSize * CoronaConfig.spriteMaxScale,
      3
    );

    // Halfway through the fade band, and gone past the end of it.
    const mid = (CoronaConfig.spriteFadeStart + CoronaConfig.spriteFadeEnd) / 2;
    marker.update(1 / 60, new THREE.Vector3(0, 1, mid));
    expect(coronaAlpha(marker)).toBeCloseTo(0.5, 1);

    marker.update(1 / 60, new THREE.Vector3(0, 1, CoronaConfig.spriteFadeEnd + 10));
    expect(corona.visible).toBe(false);

    marker.dispose();
  });

  it("shares textures, materials and item geometry between markers", () => {
    const collision = emptyCollision();
    const a = new PickupMarker("job", collision);
    const b = new PickupMarker("job", collision);
    const cash = new PickupMarker("cash", collision);

    const materialOf = (m: PickupMarker) => coronaOf(m).material as THREE.MeshBasicMaterial;
    expect(materialOf(a)).toBe(materialOf(b));
    expect(materialOf(a).map).toBe(materialOf(b).map);
    expect(materialOf(cash)).not.toBe(materialOf(a));

    const itemGeometry = (m: PickupMarker) =>
      ((m.object3d.children[0] as THREE.Group).children[0] as THREE.Mesh).geometry;
    expect(itemGeometry(a)).toBe(itemGeometry(b));
    // Only the billboard quad is per-instance, because it carries the fade.
    expect(coronaOf(a).geometry).not.toBe(coronaOf(b).geometry);

    a.dispose();
    b.dispose();
    cash.dispose();
  });

  it("stops updating once hidden and re-resolves occlusion when shown again", () => {
    const marker = new PickupMarker("job", emptyCollision());
    const camera = new THREE.Vector3(0, 2, 10);
    marker.setPosition(new THREE.Vector3(0, 0, 0));
    marker.update(1 / 60, camera);

    const spinner = marker.object3d.children[0] as THREE.Group;
    marker.setVisible(false);
    const frozen = spinner.rotation.y;
    for (let i = 0; i < 30; i++) marker.update(1 / 60, camera);
    expect(spinner.rotation.y).toBe(frozen);
    expect(marker.isVisible()).toBe(false);

    marker.setVisible(true);
    marker.update(1 / 60, camera);
    expect(coronaAlpha(marker)).toBe(1); // snaps, no fade-in from stale state
    marker.dispose();
  });
});

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

describe("storage fallbacks", () => {
  const store = new Map<string, string>();
  const original = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
  });

  afterEach(() => {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  });

  const counts = { head: 4, shirt: 4, pants: 4, shoes: 4 };

  it("falls back to defaults when nothing is stored", () => {
    expect(loadBest()).toEqual({ cash: 0, deliveries: 0, bestStreak: 0 });
    expect(loadLook(counts)).toEqual({ head: 0, shirt: 0, pants: 0, shoes: 0 });
  });

  it("falls back to defaults on malformed JSON", () => {
    store.set("sns.best.v1", "{not json at all");
    store.set("sns.look.v1", "]]]");
    expect(loadBest()).toEqual({ cash: 0, deliveries: 0, bestStreak: 0 });
    expect(loadLook(counts)).toEqual({ head: 0, shirt: 0, pants: 0, shoes: 0 });
  });

  it("falls back to defaults on the wrong shape or junk values", () => {
    store.set("sns.best.v1", JSON.stringify("a string, not a record"));
    expect(loadBest()).toEqual({ cash: 0, deliveries: 0, bestStreak: 0 });

    store.set("sns.best.v1", JSON.stringify({ cash: "NaN", deliveries: null, bestStreak: -12 }));
    expect(loadBest()).toEqual({ cash: 0, deliveries: 0, bestStreak: 0 });

    store.set("sns.best.v1", JSON.stringify({ cash: 1234.7 }));
    expect(loadBest()).toEqual({ cash: 1235, deliveries: 0, bestStreak: 0 });

    // Out-of-range look indices clamp into the available variant count.
    store.set("sns.look.v1", JSON.stringify({ head: 99, shirt: -3, pants: "x", shoes: 2 }));
    expect(loadLook(counts)).toEqual({ head: 3, shirt: 0, pants: 0, shoes: 2 });
  });

  it("survives localStorage being absent entirely", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(loadBest()).toEqual({ cash: 0, deliveries: 0, bestStreak: 0 });
    expect(loadLook(counts)).toEqual({ head: 0, shirt: 0, pants: 0, shoes: 0 });
  });
});
