import * as THREE from "three";
import { PlayerConfig, RunConfig } from "@/config/gameConfig";
import type { MoveInput } from "@/core/InputManager";
import type { CollisionWorld } from "@/world/CollisionWorld";

/**
 * PlayerController
 *
 * Owns the courier's body: where it is, how fast it is going, which way it is
 * pointing. It reads intent (a MoveInput plus the camera yaw) and pushes a
 * vertical capsule through CollisionWorld. It does not own the camera, the
 * mesh, or any animation — those read `getState()` / `getLocomotion()`.
 *
 * Yaw convention, shared with ThirdPersonCamera and with anything that renders
 * the player: `facingRad` is the value you assign to `mesh.rotation.y` for a
 * model whose forward is -Z (the glTF default). So forward is
 * `(-sin(facingRad), 0, -cos(facingRad))`, and a camera sitting *behind* the
 * player is at `+(sin, cos) * distance`.
 *
 * Feel notes, because these numbers are the game:
 *  - Speed is an exponential approach, never `v += a * dt`, so the ramp is
 *    identical at 30 fps and 144 fps. `accelSeconds` / `decelSeconds` are read
 *    as "time to reach 90% of the target", which puts full jog about 0.14 s
 *    after the key goes down — quick enough to dodge, slow enough to feel like
 *    a body.
 *  - Velocity is steered directly by input, not by facing. The body swings
 *    around to catch up. That is what lets a hard reversal in an alley change
 *    direction now instead of arcing like a car.
 *  - There is no wall friction. Per-axis resolution in CollisionWorld already
 *    slides, and keeping the velocity intact means clearing a corner pops you
 *    back to full speed — the thing route mastery is supposed to pay for.
 */

export interface PlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  facingRad: number;
  grounded: boolean;
  speed: number;
  sprinting: boolean;
}

/** ln(10): an exponential approach covers 90% of the gap in one `seconds`. */
const APPROACH_90 = Math.LN10;
const ACCEL_RATE = APPROACH_90 / PlayerConfig.accelSeconds;
const DECEL_RATE = APPROACH_90 / PlayerConfig.decelSeconds;

/** Below this the residual exponential tail is snapped away so idle is idle. */
const STOP_EPSILON = 0.06;
/** Deflection that counts as "the player is asking to move". */
const INPUT_EPSILON = 0.02;
/** Falling faster than this is pointless and makes the respawn test noisy. */
const TERMINAL_VELOCITY = -55;
/** A jump pressed this long before landing still fires on touchdown. */
const JUMP_BUFFER_SECONDS = 0.12;
/** Ignore a jump edge while already rising — no double hops. */
const JUMP_RISE_LOCKOUT = PlayerConfig.jumpSpeed * 0.5;

export class PlayerController {
  private readonly collision: CollisionWorld;

  private readonly state: PlayerState = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    facingRad: 0,
    grounded: false,
    speed: 0,
    sprinting: false,
  };

  private locomotion = 0;
  private coyoteTimer = 0;
  private jumpBuffer = 0;
  private prevJumpHeld = false;
  private hitWall = false;

  /** Last position that was grounded, clear of walls and inside the map. */
  private readonly safePosition = new THREE.Vector3();
  private safeFacing = 0;

  // Scratch — update() must not allocate.
  private readonly delta = new THREE.Vector3();
  private prevX = 0;
  private prevZ = 0;

  constructor(collision: CollisionWorld) {
    this.collision = collision;
  }

  setTransform(position: THREE.Vector3, facingRad: number): void {
    this.state.position.copy(position);
    this.state.facingRad = wrapPi(facingRad);
    this.state.velocity.set(0, 0, 0);
    this.state.speed = 0;
    this.state.sprinting = false;

    // Settle onto the surface underfoot so a spawn point authored at street
    // level on top of a stoop does not start the run mid-air or inside a kerb.
    const ground = this.collision.groundHeightAt(
      this.state.position.x,
      this.state.position.z,
      this.state.position.y + PlayerConfig.stepHeight
    );
    if (ground > this.state.position.y) this.state.position.y = ground;
    this.state.grounded = this.state.position.y <= ground + 1e-4;

    this.safePosition.copy(this.state.position);
    this.safeFacing = this.state.facingRad;
    this.prevX = this.state.position.x;
    this.prevZ = this.state.position.z;
  }

  /** Full reset for a new run: transform plus every latch and timer. */
  reset(position: THREE.Vector3, facingRad: number): void {
    this.setTransform(position, facingRad);
    this.locomotion = 0;
    this.coyoteTimer = 0;
    this.jumpBuffer = 0;
    this.prevJumpHeld = false;
    this.hitWall = false;
  }

  /** `cameraYaw` makes movement camera-relative — required, this is third person. */
  update(dt: number, move: MoveInput, cameraYaw: number): void {
    if (!(dt > 0)) return;
    if (dt > RunConfig.maxDeltaSeconds) dt = RunConfig.maxDeltaSeconds;

    const position = this.state.position;
    const velocity = this.state.velocity;
    this.prevX = position.x;
    this.prevZ = position.z;

    // --- Intent, rotated into world space by the camera ---------------------
    let ix = move.x;
    let iz = move.z;
    let mag = Math.sqrt(ix * ix + iz * iz);
    if (mag > 1) {
      ix /= mag;
      iz /= mag;
      mag = 1;
    }
    // Camera forward is (-sin, 0, -cos); camera right is (cos, 0, -sin).
    // Input z is negative-forward (W and a pushed stick both give -1).
    const sy = Math.sin(cameraYaw);
    const cy = Math.cos(cameraYaw);
    const wx = cy * ix + sy * iz;
    const wz = cy * iz - sy * ix;

    // --- Horizontal speed ---------------------------------------------------
    const wantsMove = mag > INPUT_EPSILON;
    const sprinting = move.sprint && wantsMove;
    const topSpeed = sprinting ? PlayerConfig.sprintSpeed : PlayerConfig.jogSpeed;
    const targetVX = wx * topSpeed;
    const targetVZ = wz * topSpeed;

    const targetSq = targetVX * targetVX + targetVZ * targetVZ;
    const currentSq = velocity.x * velocity.x + velocity.z * velocity.z;
    // Speeding up or holding a hard reversal uses accel; only genuinely
    // shedding speed uses decel, so letting go stops crisply.
    const rate = targetSq >= currentSq ? ACCEL_RATE : DECEL_RATE;
    const blend = 1 - Math.exp(-rate * dt);
    velocity.x += (targetVX - velocity.x) * blend;
    velocity.z += (targetVZ - velocity.z) * blend;
    if (!wantsMove && velocity.x * velocity.x + velocity.z * velocity.z < STOP_EPSILON * STOP_EPSILON) {
      velocity.x = 0;
      velocity.z = 0;
    }

    // --- Facing: constant angular rate, so a 180 takes a fixed 0.29 s -------
    // (An exponential turn would sprint the first 90 degrees then crawl the
    // rest, which reads as a long arc exactly when you need a hard reversal.)
    if (wantsMove) {
      const targetFacing = Math.atan2(-wx, -wz);
      const diff = wrapPi(targetFacing - this.state.facingRad);
      const step = PlayerConfig.turnSpeedRadPerSec * dt;
      this.state.facingRad = wrapPi(
        this.state.facingRad + (diff > step ? step : diff < -step ? -step : diff)
      );
    }

    // --- Jump: coyote time out, buffer in ----------------------------------
    if (this.state.grounded) this.coyoteTimer = PlayerConfig.coyoteSeconds;
    else this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);

    if (move.jump && !this.prevJumpHeld) this.jumpBuffer = JUMP_BUFFER_SECONDS;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.prevJumpHeld = move.jump;

    let jumpedThisFrame = false;
    if (this.jumpBuffer > 0 && this.coyoteTimer > 0 && velocity.y < JUMP_RISE_LOCKOUT) {
      velocity.y = PlayerConfig.jumpSpeed;
      this.coyoteTimer = 0;
      this.jumpBuffer = 0;
      this.state.grounded = false;
      jumpedThisFrame = true;
    }

    // --- Gravity ------------------------------------------------------------
    velocity.y += PlayerConfig.gravity * dt;
    if (velocity.y < TERMINAL_VELOCITY) velocity.y = TERMINAL_VELOCITY;

    // --- Move the capsule. All collision, sliding and step-up lives there. --
    const wasGrounded = this.state.grounded;
    this.delta.set(velocity.x * dt, velocity.y * dt, velocity.z * dt);
    const result = this.collision.moveCapsule(
      position,
      this.delta,
      PlayerConfig.radius,
      PlayerConfig.height,
      PlayerConfig.stepHeight
    );
    this.state.grounded = result.grounded;
    this.hitWall = result.hitWall;

    // Step-down snap: walking off a kerb should stay planted rather than pop
    // into a one-frame fall. Only for drops within a step, and never a jump.
    if (!this.state.grounded && wasGrounded && !jumpedThisFrame && velocity.y <= 0) {
      const drop = position.y - result.groundY;
      if (drop > 0 && drop <= PlayerConfig.stepHeight) {
        position.y = result.groundY;
        this.state.grounded = true;
      }
    }
    if (this.state.grounded && velocity.y < 0) velocity.y = 0;

    // --- Actual displacement, not intended velocity -------------------------
    // Pressed into a wall this reads 0, which is what audio, scoring and the
    // camera's auto-align want. Animation uses getLocomotion() instead, so the
    // run cycle keeps playing while you scrape along a fence.
    const movedX = position.x - this.prevX;
    const movedZ = position.z - this.prevZ;
    this.state.speed = Math.sqrt(movedX * movedX + movedZ * movedZ) / dt;
    this.state.sprinting = sprinting;

    // --- Out of world: put them back on the last good tile ------------------
    if (this.collision.isOutOfWorld(position)) {
      position.copy(this.safePosition);
      velocity.set(0, 0, 0);
      this.state.facingRad = this.safeFacing;
      this.state.grounded = true;
      this.state.speed = 0;
      this.coyoteTimer = PlayerConfig.coyoteSeconds;
      this.jumpBuffer = 0;
      this.locomotion = 0;
      return;
    }

    // Rolling safe spot: grounded, not scraping a wall. Recording a
    // wall-contact frame is how you end up respawned inside the geometry that
    // threw you out in the first place.
    if (this.state.grounded && !this.hitWall) {
      this.safePosition.copy(position);
      this.safeFacing = this.state.facingRad;
    }

    const planar = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    this.locomotion = Math.min(1, planar / PlayerConfig.sprintSpeed);
  }

  getState(): Readonly<PlayerState> {
    return this.state;
  }

  /** 0..1 for animation blending. Intent-based, so it holds against a wall. */
  getLocomotion(): number {
    return this.locomotion;
  }

  /** True on any frame lateral motion was blocked — scuff audio / anim hook. */
  isTouchingWall(): boolean {
    return this.hitWall;
  }
}

/** Shortest signed representation of an angle, in (-pi, pi]. */
function wrapPi(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
