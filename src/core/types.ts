import type * as THREE from "three";
import type { WorldLocation, ZoneId } from "@/world/types";

/**
 * Cross-module vocabulary. Anything two systems need to agree on lives here so
 * neither has to import the other. Data only — no behaviour.
 */

/** Top-level screen the game is on. Exactly one is active at a time. */
export type GamePhase = "title" | "look" | "playing" | "results";

/** Where an active job currently is in its lifecycle. */
export type JobStage = "offered" | "toPickup" | "toDelivery" | "done";

export interface ActiveJob {
  id: string;
  pickup: WorldLocation;
  delivery: WorldLocation;
  stage: JobStage;
  /** Straight-line metres pickup→delivery, used for the base payout. */
  distance: number;
  /** Seconds allowed for a full-speed bonus. Beat it and the fast bonus pays out. */
  parSeconds: number;
  baseCash: number;
  fastBonus: number;
  /** Seconds since the job was accepted. */
  elapsed: number;
}

export interface PayoutBreakdown {
  base: number;
  speed: number;
  streak: number;
  total: number;
  /** Short label shown in the world toast, e.g. "FAST DROP". */
  label: string;
}

export interface RunSummary {
  cash: number;
  deliveries: number;
  bestStreak: number;
  isNewBest: boolean;
  previousBest: number;
}

/** What the HUD needs to draw the off-screen direction indicator. */
export interface NavTarget {
  position: THREE.Vector3;
  label: string;
  kind: "pickup" | "delivery";
  zone: ZoneId;
}
