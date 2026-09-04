import * as THREE from "three";
import { CameraConfig, PlayerConfig, RunConfig } from "@/config/gameConfig";
import type { PlayerState } from "@/modules/PlayerController";
import type { CollisionWorld } from "@/world/CollisionWorld";

/**
 * ThirdPersonCamera
 *
 * A boom camera on a smoothed pivot. Close, shoulder-height, aimed at the
 * player's chest (docs/BAR.md §7). It never reads input hardware — the
 * assembler hands it InputManager's look delta.
 *
 * Yaw convention matches PlayerController: the camera sits at
 * `pivot + (sin(yaw), _, cos(yaw)) * distance` and looks back along
 * `(-sin(yaw), _, -cos(yaw))`, so `snapTo()` can simply copy `facingRad`.
 * Pitch is the camera's elevation above the pivot: positive looks down.
 *
 * The three things that decide whether this feels good:
 *
 *  1. **Asymmetric obstruction.** Blocked, the boom collapses *this frame*.
 *     Clear, it grows back eased at `recoverSpeedPerSecond`. Symmetric
 *     handling is what makes a camera strobe as you sprint past doorways,
 *     fence posts and downpipes — each one would push out and snap back at the
 *     same speed, several times a second.
 *  2. **Props do not occlude.** `segmentHit` skips `prop` boxes by default, so
 *     dumpsters, parked cars and fences never yank the view. Walls do.
 *  3. **Auto-align is a drift, not a snap.** It only engages after the player
 *     has left the look control alone, ramps in with speed, and backs off hard
 *     on near-reversals so doubling back down an alley does not spin the world.
 */

/** Any look delta above this counts as the player actively steering. */
const LOOK_EPSILON = 1e-4;
/** Hands-off time before auto-align starts helping. */
const AUTO_ALIGN_DELAY = 0.55;
/** ...and how long it takes to reach full strength once it does. */
const AUTO_ALIGN_RAMP = 0.9;
/**
 * Fraction of `yawLerpPerSecond` auto-align is allowed to use. The config rate
 * is a hard follow (~0.14 s); at full strength it would whip behind the player
 * every time the mouse paused. 0.18 gives a ~0.8 s drift you feel but never
 * fight. Raise `yawLerpPerSecond` to make it keener.
 */
const AUTO_ALIGN_FRACTION = 0.18;
/** Above this offset the player is doubling back — stop chasing them. */
const REVERSE_ANGLE = 1.92; // ~110 degrees
/** Player must be moving at least this fraction of a jog before we align. */
const AUTO_ALIGN_MIN_SPEED = PlayerConfig.jogSpeed * 0.3;
/** Vertical follow is slacker on the ground so kerbs and stoops do not bob. */
const GROUND_Y_FOLLOW = 0.6;
/** ...and keener in the air so a fall stays in frame. */
const AIR_Y_FOLLOW = 1.4;
/** Pivot jumps further than this are a teleport, not motion. */
const TELEPORT_SNAP = 6;

export class ThirdPersonCamera {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly collision: CollisionWorld;

  private yaw = 0;
  private pitch = 0;
  private boom: number = CameraConfig.followDistance;
  private lookIdle = 0;

  /** Smoothed aim point; the boom hangs off this, not off the raw player. */
  private readonly pivot = new THREE.Vector3();
  // Scratch — update() must not allocate.
  private readonly offset = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, collision: CollisionWorld) {
    this.camera = camera;
    this.collision = collision;
  }

  update(dt: number, target: Readonly<PlayerState>, look: { yaw: number; pitch: number }): void {
    if (!(dt > 0)) dt = 0;
    if (dt > RunConfig.maxDeltaSeconds) dt = RunConfig.maxDeltaSeconds;

    // --- Player look --------------------------------------------------------
    const steering = Math.abs(look.yaw) > LOOK_EPSILON || Math.abs(look.pitch) > LOOK_EPSILON;
    this.yaw = wrapPi(this.yaw + look.yaw);
    this.pitch = clamp(this.pitch + look.pitch, CameraConfig.pitchMinRad, CameraConfig.pitchMaxRad);
    this.lookIdle = steering ? 0 : this.lookIdle + dt;

    // --- Soft auto-align ----------------------------------------------------
    if (this.lookIdle > AUTO_ALIGN_DELAY && target.grounded && target.speed > AUTO_ALIGN_MIN_SPEED) {
      const vx = target.velocity.x;
      const vz = target.velocity.z;
      const planar = Math.sqrt(vx * vx + vz * vz);
      if (planar > AUTO_ALIGN_MIN_SPEED) {
        const travelYaw = Math.atan2(-vx, -vz);
        const diff = wrapPi(travelYaw - this.yaw);
        const absDiff = Math.abs(diff);
        const idleRamp = Math.min(1, (this.lookIdle - AUTO_ALIGN_DELAY) / AUTO_ALIGN_RAMP);
        const speedRamp = Math.min(1, planar / PlayerConfig.sprintSpeed);
        // Near-reversal damping: a hard double-back is a deliberate move, and
        // swinging 180 degrees behind the player mid-alley loses them entirely.
        const reverse =
          absDiff > REVERSE_ANGLE
            ? Math.max(0, 1 - (absDiff - REVERSE_ANGLE) / (Math.PI - REVERSE_ANGLE))
            : 1;
        const rate = CameraConfig.yawLerpPerSecond * AUTO_ALIGN_FRACTION * idleRamp * speedRamp * reverse;
        if (rate > 0) this.yaw = wrapPi(this.yaw + diff * (1 - Math.exp(-rate * dt)));
      }
    }

    // --- Pivot follow -------------------------------------------------------
    const px = target.position.x;
    const py = target.position.y + CameraConfig.lookAtHeight;
    const pz = target.position.z;
    const dx = px - this.pivot.x;
    const dy = py - this.pivot.y;
    const dz = pz - this.pivot.z;
    if (dx * dx + dy * dy + dz * dz > TELEPORT_SNAP * TELEPORT_SNAP) {
      this.pivot.set(px, py, pz);
    } else {
      const planarBlend = 1 - Math.exp(-CameraConfig.positionLerpPerSecond * dt);
      const yRate =
        CameraConfig.positionLerpPerSecond * (target.grounded ? GROUND_Y_FOLLOW : AIR_Y_FOLLOW);
      const yBlend = 1 - Math.exp(-yRate * dt);
      this.pivot.x += dx * planarBlend;
      this.pivot.z += dz * planarBlend;
      this.pivot.y += dy * yBlend;
    }

    this.applyBoom(dt, false);
  }

  getYaw(): number {
    return this.yaw;
  }

  /** Snap instantly behind the player — used on run start and respawn. */
  snapTo(target: Readonly<PlayerState>): void {
    this.yaw = wrapPi(target.facingRad);
    this.pitch = 0;
    this.lookIdle = 0;
    this.pivot.set(
      target.position.x,
      target.position.y + CameraConfig.lookAtHeight,
      target.position.z
    );
    this.boom = CameraConfig.followDistance;
    this.applyBoom(0, true);
  }

  /**
   * Build the desired boom, test it against the world, and place the camera.
   * `snap` skips the eased recovery so a respawn starts already resolved
   * instead of telescoping outward over the first half second.
   */
  private applyBoom(dt: number, snap: boolean): void {
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const horizontal = CameraConfig.followDistance * cosP;
    // At pitch 0 this reproduces the config exactly: 5.0 m back, 2.15 m up.
    const vertical =
      CameraConfig.followHeight - CameraConfig.lookAtHeight + CameraConfig.followDistance * sinP;
    this.offset.set(Math.sin(this.yaw) * horizontal, vertical, Math.cos(this.yaw) * horizontal);

    const boomLength = this.offset.length();
    if (boomLength < 1e-5) {
      this.camera.position.copy(this.pivot);
      return;
    }
    this.desired.copy(this.pivot).add(this.offset);

    // Walls only — `segmentHit` skips props by default, which is exactly the
    // behaviour we want: a dumpster must never pull the camera in.
    const clearFraction = this.collision.segmentHit(
      this.pivot,
      this.desired,
      CameraConfig.obstructionPadding
    );
    let allowed = boomLength * clearFraction;
    if (allowed < CameraConfig.minDistance) allowed = CameraConfig.minDistance;
    if (allowed > boomLength) allowed = boomLength;

    if (snap || allowed < this.boom) {
      this.boom = allowed; // blocked: collapse now, this frame, no easing
    } else {
      this.boom += (allowed - this.boom) * (1 - Math.exp(-CameraConfig.recoverSpeedPerSecond * dt));
    }
    if (this.boom > boomLength) this.boom = boomLength;
    if (this.boom < CameraConfig.minDistance) this.boom = CameraConfig.minDistance;

    const scale = this.boom / boomLength;
    this.camera.position.set(
      this.pivot.x + this.offset.x * scale,
      this.pivot.y + this.offset.y * scale,
      this.pivot.z + this.offset.z * scale
    );
    this.camera.lookAt(this.pivot.x, this.pivot.y, this.pivot.z);
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Shortest signed representation of an angle, in (-pi, pi]. */
function wrapPi(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
