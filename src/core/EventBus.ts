import type { ActiveJob, GamePhase, NavTarget, PayoutBreakdown, RunSummary } from "@/core/types";
import type { ZoneId } from "@/world/types";

/**
 * Lightweight typed event bus. Modules publish facts; they never reach into
 * each other. Adding an event here is the only sanctioned way to couple two
 * systems.
 *
 * Every subscription returns an unsubscribe function, and `reset()` drops all
 * listeners — that is what keeps a restart from stacking a second copy of every
 * handler, which is the classic leak in a game with a "Run It Back" button.
 */
export interface GameEvents {
  "phase:changed": { phase: GamePhase };

  "run:started": { seed: number };
  "run:tick": { remainingSeconds: number; fraction: number };
  "run:ended": RunSummary;

  "job:offered": { job: ActiveJob };
  "job:accepted": { job: ActiveJob };
  "job:pickedUp": { job: ActiveJob };
  "job:delivered": { job: ActiveJob; payout: PayoutBreakdown };

  "score:changed": { total: number; delta: number; label: string };
  "streak:changed": { count: number; multiplier: number };

  "nav:target": { target: NavTarget | null };
  "audio:zone": { zone: ZoneId };
  "toast": { text: string; tone: "cash" | "info" | "warn" };
}

type Listener<T> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<keyof GameEvents, Set<Listener<never>>>();

  on<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy before iterating: a handler may unsubscribe itself mid-dispatch.
    for (const listener of Array.from(set)) (listener as Listener<GameEvents[K]>)(payload);
  }

  /** Drop every listener. Called on teardown so restarts cannot stack handlers. */
  reset(): void {
    this.listeners.clear();
  }

  /** Diagnostic: total live listeners, asserted in the restart-stress test. */
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

/** Single shared instance for the demo's scope. */
export const eventBus = new EventBus();
