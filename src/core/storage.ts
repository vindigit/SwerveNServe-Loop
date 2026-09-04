/**
 * Local persistence for the best score and the chosen look.
 *
 * Every read is defensive: localStorage can be unavailable (private mode,
 * blocked site data), absent, malformed, or written by an older build. A bad
 * value must degrade to the default, never throw and never corrupt a run.
 */

const BEST_KEY = "sns.best.v1";
const LOOK_KEY = "sns.look.v1";

export interface BestRecord {
  cash: number;
  deliveries: number;
  bestStreak: number;
}

export interface LookRecord {
  head: number;
  shirt: number;
  pants: number;
  shoes: number;
}

const DEFAULT_BEST: BestRecord = { cash: 0, deliveries: 0, bestStreak: 0 };
const DEFAULT_LOOK: LookRecord = { head: 0, shirt: 0, pants: 0, shoes: 0 };

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the run is still valid, it just won't persist */
  }
}

function finiteInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadBest(): BestRecord {
  const raw = readJson(BEST_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_BEST };
  const r = raw as Record<string, unknown>;
  return {
    cash: finiteInt(r.cash, 0, 0, 1e9),
    deliveries: finiteInt(r.deliveries, 0, 0, 1e6),
    bestStreak: finiteInt(r.bestStreak, 0, 0, 1e6),
  };
}

export function saveBest(record: BestRecord): void {
  writeJson(BEST_KEY, record);
}

export function loadLook(counts: LookRecord): LookRecord {
  const raw = readJson(LOOK_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LOOK };
  const r = raw as Record<string, unknown>;
  return {
    head: finiteInt(r.head, 0, 0, Math.max(0, counts.head - 1)),
    shirt: finiteInt(r.shirt, 0, 0, Math.max(0, counts.shirt - 1)),
    pants: finiteInt(r.pants, 0, 0, Math.max(0, counts.pants - 1)),
    shoes: finiteInt(r.shoes, 0, 0, Math.max(0, counts.shoes - 1)),
  };
}

export function saveLook(look: LookRecord): void {
  writeJson(LOOK_KEY, look);
}
