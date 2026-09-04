import { RunConfig } from "@/config/gameConfig";

/**
 * Split one browser frame into safe simulation time and honest run time.
 *
 * Physics must be capped after a hitch so collision and camera recovery never
 * take a giant step. The score attack clock must not be capped: if the game is
 * visibly running for 300 ms, it must cost 300 ms. When the run is paused (for
 * example because the tab is hidden), both values are zero.
 */
export function resolveFrameTiming(
  rawDeltaSeconds: number,
  runClockActive: boolean
): { physicsDt: number; runDt: number } {
  const raw = Number.isFinite(rawDeltaSeconds) && rawDeltaSeconds > 0 ? rawDeltaSeconds : 0;
  if (!runClockActive) return { physicsDt: 0, runDt: 0 };
  return {
    physicsDt: Math.min(raw, RunConfig.maxDeltaSeconds),
    runDt: raw,
  };
}
