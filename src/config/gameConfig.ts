/**
 * Central typed configuration. Tunables live here, not scattered through logic.
 * Values are chosen for the bar in docs/BAR.md — change them there first if the
 * look or feel needs to move, so the reasoning stays with the number.
 */

export const RenderConfig = {
  /** Internal render height before nearest-neighbour upscale. PS2 target. */
  internalHeight: 540,
  /** Hard cap on important real-time lights in view (aesthetic pledge). */
  maxDynamicLights: 3,
  /** Muted purple-navy — must read lighter than shadowed ground, never black. */
  fogColor: 0x131426,
  skyColor: 0x171a30,
  /** Haze, not soup: signage readable at 30 m, landmarks at 70 m. */
  fogNear: 22,
  fogFar: 105,
  cameraFovDeg: 60,
  cameraNear: 0.1,
  cameraFar: 200,
  /** Texture budget from the aesthetic pledge. */
  maxTextureSize: 256,
  propTextureSize: 128,
} as const;

export const RunConfig = {
  /** Run length. 12 minutes sits mid-range of the 10–15 minute target. */
  durationSeconds: 12 * 60,
  /** Below this the HUD timer goes urgent. */
  countdownWarningSeconds: 45,
  /**
   * Focus-loss policy: the run clock PAUSES when the tab is hidden. A courier
   * score attack is about route decisions, not about punishing an alt-tab, and
   * an unpaused clock plus a clamped delta silently steals time.
   */
  pauseOnBlur: true,
  /** Delta clamp — a tab-out must never produce one enormous physics step. */
  maxDeltaSeconds: 1 / 15,
} as const;

export const PlayerConfig = {
  jogSpeed: 5.2,
  sprintSpeed: 9.0,
  /** Time to reach full speed from standing. Low = responsive, not floaty. */
  accelSeconds: 0.14,
  /** Time to stop from full speed. Slightly longer than accel for weight. */
  decelSeconds: 0.11,
  /** How fast the body turns to face the movement direction. */
  turnSpeedRadPerSec: Math.PI * 3.4,
  radius: 0.38,
  height: 1.75,
  /** Anything this tall or shorter is walked onto, not bumped into. */
  stepHeight: 0.42,
  gravity: -26,
  /**
   * A readable one-metre hop. Holding jump gives a rounder arc; releasing it
   * early trims the rise, and falling is deliberately quicker than rising.
   */
  jumpSpeed: 6.8,
  jumpHoldGravityMultiplier: 0.82,
  jumpCutGravityMultiplier: 1.75,
  fallGravityMultiplier: 1.22,
  /** Grace period after leaving ground where a jump still registers. */
  coyoteSeconds: 0.12,
  respawnFadeSeconds: 0.35,
} as const;

export const CameraConfig = {
  followDistance: 5.0,
  followHeight: 2.15,
  lookAtHeight: 1.35,
  /** Higher = snappier follow. Tuned so hard turns stay readable in alleys. */
  positionLerpPerSecond: 9.5,
  yawLerpPerSecond: 7.0,
  /** Camera is pulled in to this much of the wall distance when obstructed. */
  obstructionPadding: 0.42,
  minDistance: 1.15,
  /** Retraction is instant, recovery is eased — prevents obstruction jitter. */
  recoverSpeedPerSecond: 3.2,
  mouseSensitivity: 0.0026,
  stickSensitivity: 2.6,
  pitchMinRad: -0.55,
  pitchMaxRad: 0.62,
} as const;

export const ScoreConfig = {
  /** Payout = (base + speed) × streak multiplier. Kept legible on purpose. */
  cashPerMetre: 1.6,
  minBaseCash: 120,
  /** Reach difficulty multiplies the base. */
  reachMultiplier: { easy: 1, medium: 1.25, risky: 1.55 } as const,
  /** Full fast bonus if delivered at/under par; decays to zero at 2× par. */
  fastBonusFraction: 0.6,
  streakMultiplierStep: 0.15,
  maxStreakMultiplier: 2.5,
  /** Streak breaks if the player dawdles this far past par. */
  streakBreakParMultiple: 2.0,
} as const;

export const JobConfig = {
  /** Metres. Stops the director offering a pickup next to its own drop-off. */
  minPairDistance: 55,
  /** How many recent locations are excluded from the next draw. */
  recentMemory: 3,
  /** Seconds of walking distance allowed per metre when setting par. */
  parSecondsPerMetre: 1 / 6.4,
  parFloorSeconds: 14,
  /** Radius at which a pickup/delivery trigger fires. */
  triggerRadius: 2.2,
} as const;

export const CoronaConfig = {
  /** Two objects at one location: a rotating mesh, and a flat billboard. */
  meshFloatHeight: 0.95,
  meshRotationRadPerSec: 1.9,
  meshBobAmplitude: 0.07,
  meshBobRadPerSec: 2.4,
  spriteWorldSize: 2.35,
  /** Conservative distance scaling so it stays readable but never blooms. */
  spriteMinScale: 0.85,
  spriteMaxScale: 1.35,
  spriteFadeStart: 70,
  spriteFadeEnd: 100,
  colors: {
    /** Courier jobs, mission objects, deliveries. */
    job: 0xffb02e,
    /** Cash. */
    cash: 0x4dff62,
    /** Reserved — no weapon or health system is in scope. */
    weapon: 0xd6e6ff,
    health: 0xff4d4d,
  },
} as const;

export const WorldConfig = {
  /** Roughly three interconnected blocks. */
  extentX: 220,
  extentZ: 180,
  streetLevelY: 0,
} as const;
