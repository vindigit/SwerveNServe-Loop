import * as THREE from "three";
import { Courier, LOOK_COUNTS, type LookPreset } from "@/character/Courier";
import { RenderConfig, RunConfig } from "@/config/gameConfig";
import { eventBus } from "@/core/EventBus";
import { resolveFrameTiming } from "@/core/frameTiming";
import { InputManager } from "@/core/InputManager";
import { loadBest, loadLook, saveBest, saveLook } from "@/core/storage";
import type { GamePhase, RunSummary } from "@/core/types";
import { JobDirector } from "@/modules/JobDirector";
import { ObjectiveArrow } from "@/modules/ObjectiveArrow";
import { PlayerController } from "@/modules/PlayerController";
import { RunTimer } from "@/modules/RunTimer";
import { ScoreSystem } from "@/modules/ScoreSystem";
import { StreakSystem } from "@/modules/StreakSystem";
import { ThirdPersonCamera, resolveObstructedCameraPosition } from "@/modules/ThirdPersonCamera";
import { HUD } from "@/ui/HUD";
import { LookScreen, ResultsScreen, TitleScreen } from "@/ui/Screens";
import { CollisionWorld } from "@/world/CollisionWorld";
import { buildNeighborhood } from "@/world/Neighborhood";
import type { NeighborhoodBuild } from "@/world/types";

/**
 * Game — the assembly point and the only owner of the animation loop.
 *
 * The single rule this file exists to enforce: **one loop, one world, one of
 * everything**. A restart resets run-owned state; it never rebuilds the
 * neighbourhood, never re-subscribes a listener, and never starts a second
 * `requestAnimationFrame` chain. That is what makes "Run It Back" instant and
 * what stops five consecutive runs leaking a scene graph.
 */

/** How long a menu camera takes to drift across its arc, in seconds. */
const MENU_ORBIT_PERIOD = 90;
const MENU_CAMERA_PADDING = 0.75;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clock = new THREE.Clock();

  private readonly world: NeighborhoodBuild;
  private readonly collision: CollisionWorld;

  private readonly input: InputManager;
  private readonly player: PlayerController;
  private readonly follow: ThirdPersonCamera;
  private readonly courier: Courier;
  private readonly jobs: JobDirector;
  private readonly objectiveArrow: ObjectiveArrow;
  private readonly timer: RunTimer;
  private readonly score: ScoreSystem;
  private readonly streak: StreakSystem;

  private readonly hud: HUD;
  private readonly title: TitleScreen;
  private readonly lookScreen: LookScreen;
  private readonly results: ResultsScreen;

  private phase: GamePhase = "title";
  private rafHandle = 0;
  private running = false;
  private disposed = false;
  private menuClock = 0;
  private runSeed = 1;
  private look: LookPreset;

  private readonly lightSample = new THREE.Color();
  private readonly menuFocus = new THREE.Vector3(2, 3, -9.4);
  private readonly menuDesired = new THREE.Vector3();
  private readonly onResize = (): void => this.resize();
  private readonly onVisibility = (): void => this.handleVisibility();

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement) {
    /* --- renderer: low internal buffer, CSS does the nearest upscale --- */
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(RenderConfig.fogColor);
    this.renderer.info.autoReset = false;

    this.scene.fog = new THREE.Fog(RenderConfig.fogColor, RenderConfig.fogNear, RenderConfig.fogFar);
    this.camera = new THREE.PerspectiveCamera(
      RenderConfig.cameraFovDeg,
      16 / 9,
      RenderConfig.cameraNear,
      RenderConfig.cameraFar
    );

    /* --- world: built once, for the life of the page ------------------ */
    this.world = buildNeighborhood();
    this.scene.add(this.world.root);
    this.collision = new CollisionWorld(this.world.colliders, this.world.bounds);

    /* --- actors ------------------------------------------------------- */
    this.input = new InputManager();
    this.player = new PlayerController(this.collision);
    this.follow = new ThirdPersonCamera(this.camera, this.collision);
    this.look = loadLook(LOOK_COUNTS);
    this.courier = new Courier(this.look);
    this.scene.add(this.courier.object3d);

    this.timer = new RunTimer();
    this.streak = new StreakSystem();
    this.score = new ScoreSystem(() => this.streak.getMultiplier());
    this.jobs = new JobDirector(this.world.locations, this.collision, this.scene);
    this.objectiveArrow = new ObjectiveArrow(this.scene);
    // One place decides what a delivery is worth: score applies the streak.
    this.jobs.onComputePayout = (job) => this.score.award(job);
    this.timer.onExpire = () => this.endRun();

    /* --- UI ----------------------------------------------------------- */
    this.hud = new HUD(hudRoot, this.world.colliders);
    this.title = new TitleScreen(hudRoot);
    this.lookScreen = new LookScreen(hudRoot);
    this.results = new ResultsScreen(hudRoot);

    this.title.onChoose = (choice) => {
      if (choice === "start") this.startRun();
      else if (choice === "look") this.setPhase("look");
    };
    this.lookScreen.setLook(this.look);
    this.lookScreen.onChange = (look) => {
      this.look = look;
      this.courier.setLook(look);
    };
    this.lookScreen.onConfirm = () => {
      saveLook(this.look);
      this.startRun();
    };
    this.lookScreen.onBack = () => {
      saveLook(this.look);
      this.setPhase("title");
    };
    this.results.onChoose = (choice) => {
      if (choice === "again") this.startRun();
      else this.setPhase("title");
    };

    // Streak breaks feed the HUD, and a delivery bumps the streak. Both are
    // wired here so neither module has to know about the other.
    eventBus.on("job:delivered", ({ job }) => {
      this.streak.registerDelivery(job);
      this.courier.setCarrying(false);
    });
    eventBus.on("job:pickedUp", () => {
      this.courier.setCarrying(true);
      this.hud.toast("PACKAGE SECURED", "info");
    });

    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.resize();
    this.setPhase("title");
    this.exposeDebug();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.getDelta(); // discard the load-time gap
    this.tick();
  }

  /**
   * Begin a run. Everything a run owns is reset here and nowhere else, so the
   * restart path and the first-launch path are literally the same code.
   */
  startRun(seed = Date.now() % 0x7fffffff): void {
    this.runSeed = seed;

    this.player.reset(this.world.spawn.position, this.world.spawn.facingRad);
    this.courier.setCarrying(false);
    this.courier.setLook(this.look);
    this.score.reset();
    this.streak.reset();
    this.timer.reset();
    this.jobs.reset();
    this.objectiveArrow.reset();
    this.hud.reset();

    this.follow.snapTo(this.player.getState());
    this.timer.start();
    this.jobs.start(seed);
    this.setPhase("playing");
    eventBus.emit("run:started", { seed });
  }

  private endRun(): void {
    if (this.phase !== "playing") return;
    this.jobs.stop();
    this.timer.stop();

    const previous = loadBest();
    const cash = this.score.getTotal();
    const deliveries = this.score.getDeliveries();
    const bestStreak = this.streak.getBest();
    const isNewBest = cash > previous.cash;
    if (isNewBest) saveBest({ cash, deliveries, bestStreak });

    const summary: RunSummary = {
      cash,
      deliveries,
      bestStreak,
      isNewBest,
      previousBest: previous.cash,
    };
    this.results.show(summary);
    this.setPhase("results");
    eventBus.emit("run:ended", summary);
  }

  private setPhase(phase: GamePhase): void {
    this.phase = phase;
    const playing = phase === "playing";
    this.hud.setVisible(playing);
    this.title.setVisible(phase === "title");
    this.lookScreen.setVisible(phase === "look");
    this.results.setVisible(phase === "results");
    this.input.setPointerLockEnabled(playing);
    this.timer.setPaused(!playing);
    if (phase === "look") this.lookScreen.setLook(this.look);
    eventBus.emit("phase:changed", { phase });
  }

  /* ------------------------------------------------------------------ */
  /* the one loop                                                        */
  /* ------------------------------------------------------------------ */

  private tick = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    const timing = resolveFrameTiming(this.clock.getDelta(), this.timer.isRunning());

    this.input.update();

    if (this.phase === "playing") this.updatePlaying(timing.physicsDt, timing.runDt);
    else this.updateMenus(timing.physicsDt);

    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
  };

  private updatePlaying(physicsDt: number, runDt: number): void {
    this.player.update(physicsDt, this.input.getMove(), this.follow.getYaw());
    const state = this.player.getState();

    // Out-of-world backstop: a courier who finds a seam gets put back on the
    // pavement instead of falling forever.
    if (this.collision.isOutOfWorld(state.position)) {
      this.player.reset(this.world.spawn.position, this.world.spawn.facingRad);
      this.follow.snapTo(this.player.getState());
      this.hud.toast("RECOVERED", "warn");
      return;
    }

    this.follow.update(physicsDt, state, this.input.getLook());
    this.placeCourier(state.position, state.facingRad);
    this.courier.update(physicsDt, this.player.getLocomotion(), state.grounded, state.velocity.y);
    this.applyCourierLight(state.position);

    this.timer.update(runDt);
    this.jobs.update(physicsDt, state.position, this.camera.position, runDt);
    this.objectiveArrow.update(physicsDt, state.position);
    this.hud.update(state.position, state.facingRad);
  }

  private updateMenus(dt: number): void {
    this.menuClock += dt;

    if (this.phase === "title") {
      this.title.update(this.input);
      this.menuCamera();
    } else if (this.phase === "look") {
      this.lookScreen.update(this.input);
      this.lookCamera(dt);
    } else if (this.phase === "results") {
      this.results.update(this.input);
      this.menuCamera();
    }
  }

  /** Slow drift over the intersection: the world stays alive behind the menu. */
  private menuCamera(): void {
    const t = (this.menuClock / MENU_ORBIT_PERIOD) * Math.PI * 2;
    const radius = 26;
    this.menuDesired.set(-14 + Math.cos(t) * radius, 7.5, 6 + Math.sin(t) * radius * 0.45);

    // The cinematic orbit used to ignore the collision world and travel
    // straight through hollow building shells. Clamp the desired endpoint to
    // the first wall hit, with enough clearance for the near plane.
    resolveObstructedCameraPosition(
      this.collision,
      this.menuFocus,
      this.menuDesired,
      MENU_CAMERA_PADDING,
      this.camera.position
    );
    this.camera.lookAt(this.menuFocus);
    this.placeCourier(this.world.spawn.position, this.world.spawn.facingRad);
    this.courier.update(1 / 60, 0, true);
    this.applyCourierLight(this.world.spawn.position);
  }

  /**
   * Look screen: courier on a turntable under the corner store's light, framed
   * right of centre so the preset panel on the left never covers him.
   */
  private lookCamera(dt: number): void {
    const centre = new THREE.Vector3(2, 0, -9.4);
    this.placeCourier(centre, this.menuClock * 0.55);
    this.courier.update(dt, 0, true);
    this.applyCourierLight(centre);
    this.camera.position.set(centre.x - 2.7, 1.28, centre.z + 3.7);
    this.camera.lookAt(centre.x, 0.92, centre.z);
  }

  private placeCourier(position: THREE.Vector3, facingRad: number): void {
    this.courier.object3d.position.copy(position);
    this.courier.object3d.rotation.y = facingRad;
  }

  /** One sample of the baked rig per frame is the whole character lighting model. */
  private applyCourierLight(position: THREE.Vector3): void {
    this.lightSample.copy(this.world.sampleLight(position.x, position.y + 1.1, position.z));
    // Lift it a little: a body reads darker than the ground it stands on.
    this.lightSample.r = Math.min(1, this.lightSample.r * 1.55 + 0.06);
    this.lightSample.g = Math.min(1, this.lightSample.g * 1.55 + 0.06);
    this.lightSample.b = Math.min(1, this.lightSample.b * 1.55 + 0.08);
    this.courier.applyLight(this.lightSample);
  }

  /* ------------------------------------------------------------------ */
  /* plumbing                                                            */
  /* ------------------------------------------------------------------ */

  private resize(): void {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const height = RenderConfig.internalHeight;
    const width = Math.round(height * aspect);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Tab-out policy, stated once: the run clock pauses, input is flushed so no
   * key stays stuck down, and the delta clamp in `tick` handles the catch-up
   * frame. Coming back should feel like unpausing, not like being robbed.
   */
  private handleVisibility(): void {
    const hidden = document.hidden;
    this.input.clear();
    if (RunConfig.pauseOnBlur && this.phase === "playing") this.timer.setPaused(hidden);
    if (!hidden) this.clock.getDelta();
  }

  /** Diagnostics for the playtest harness. Read-only; no gameplay depends on it. */
  private exposeDebug(): void {
    const debug = {
      snapshot: () => {
        const info = this.renderer.info;
        return {
          phase: this.phase,
          seed: this.runSeed,
          cash: this.score.getTotal(),
          deliveries: this.score.getDeliveries(),
          streak: this.streak.getCount(),
          bestStreak: this.streak.getBest(),
          remaining: Math.round(this.timer.getRemainingSeconds()),
          activeJob: this.jobs.getActive()?.id ?? null,
          jobStage: this.jobs.getActive()?.stage ?? null,
          playerPos: this.player.getState().position.toArray().map((n) => Math.round(n * 10) / 10),
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          sceneObjects: countObjects(this.scene),
          listeners: eventBus.listenerCount(),
          lights: countLights(this.scene),
          locations: this.world.locations.length,
          hasGamepad: this.input.hasGamepad(),
        };
      },
      // The harness drives runs deterministically instead of waiting 12 minutes.
      startRun: (seed?: number) => this.startRun(seed),
      teleport: (x: number, z: number) => {
        this.player.reset(new THREE.Vector3(x, 2, z), this.player.getState().facingRad);
        this.follow.snapTo(this.player.getState());
      },
      setTime: (seconds: number) => {
        this.timer.subtractTime(this.timer.getRemainingSeconds() - seconds);
      },
      endRun: () => this.endRun(),
      phase: () => this.phase,
      /** Where the active job wants the player next — lets the harness play a run. */
      target: () => {
        const job = this.jobs.getActive();
        if (!job) return null;
        const point = job.stage === "toDelivery" ? job.delivery : job.pickup;
        return { id: point.id, name: point.name, x: point.position.x, z: point.position.z, stage: job.stage };
      },
      locations: () => this.world.locations.map((l) => ({ id: l.id, x: l.position.x, z: l.position.z, zone: l.zone })),
      routes: () => this.world.routes.map((r) => r.id),
      /**
       * Every job location must be standable and have room to leave from. An
       * objective buried in a collider is an impossible job, and the player
       * has no way to know it is not their fault.
       */
      checkLocations: () => {
        const probe = new THREE.Vector3();
        return this.world.locations.map((location) => {
          const { x, z } = location.position;
          const groundY = this.collision.groundHeightAt(x, z, 6);
          let openDirections = 0;
          for (let a = 0; a < 8; a++) {
            const angle = (a / 8) * Math.PI * 2;
            probe.set(x, groundY, z);
            const delta = new THREE.Vector3(Math.cos(angle) * 0.9, 0, Math.sin(angle) * 0.9);
            const before = probe.clone();
            this.collision.moveCapsule(probe, delta, 0.38, 1.75, 0.42);
            if (probe.distanceTo(before) > 0.55) openDirections++;
          }
          return { id: location.id, zone: location.zone, groundY: Math.round(groundY * 100) / 100, openDirections };
        });
      },
      /**
       * Actually *run* an authored route with the real controller and the real
       * collision, and report how long it took. Path length alone does not
       * certify a shortcut — a breezeway that is 20% shorter but blocked by a
       * collider is not a shortcut, it is a bug. This is the measurement the
       * bar's route-mastery criterion asks for.
       */
      walkRoute: (routeId: string, which: "safe" | "shortcut") => {
        const route = this.world.routes.find((r) => r.id === routeId);
        if (!route) return null;
        const path = which === "safe" ? route.safePath : route.shortcutPath;
        return simulateWalk(this.player, this.collision, path);
      },
    };
    (window as unknown as Record<string, unknown>).__gameDebug = debug;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    eventBus.reset();
    this.jobs.dispose();
    this.objectiveArrow.dispose();
    this.streak.dispose();
    this.input.dispose();
    this.hud.dispose();
    this.courier.dispose();
    this.world.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}

/**
 * Drive the real PlayerController along a waypoint path at full sprint and
 * report simulated seconds, distance covered, and whether it arrived. Fixed
 * timestep so the answer is reproducible; a generous step budget so a route
 * that stalls against geometry reports `arrived: false` rather than hanging.
 */
function simulateWalk(
  player: PlayerController,
  collision: CollisionWorld,
  path: THREE.Vector3[]
): { seconds: number; distance: number; arrived: boolean; stuckAt: number[] | null } {
  const DT = 1 / 60;
  const MAX_STEPS = 60 * 240; // four simulated minutes is far beyond any route
  const ARRIVE = 1.6;

  const start = path[0];
  const saved = player.getState();
  const savedPos = saved.position.clone();
  const savedFacing = saved.facingRad;

  // Drop in from above and let gravity settle. Spawning at y=0 buries the
  // walker inside any raised volume (the loading dock, a stoop), where it is
  // wedged from every direction and reports a false blockage.
  player.reset(new THREE.Vector3(start.x, 4, start.z), 0);
  for (let i = 0; i < 90; i++) player.update(DT, { x: 0, z: 0, sprint: false, jump: false }, 0);

  let steps = 0;
  let distance = 0;
  const previous = player.getState().position.clone();
  const heading = new THREE.Vector3();

  for (let i = 1; i < path.length; i++) {
    const goal = path[i];
    let stalled = 0;
    // A dumb walker that runs head-on into a lamp post reports the map as
    // blocked; a player just steps around it. So: brief perpendicular strafe
    // after a short stall, alternating side, then resume the line.
    let sidestep = 0;
    let sidestepDir = 1;
    while (steps < MAX_STEPS) {
      const state = player.getState();
      heading.set(goal.x - state.position.x, 0, goal.z - state.position.z);
      if (heading.length() <= ARRIVE) break;
      heading.normalize();
      let ix = heading.x;
      let iz = heading.z;
      if (sidestep > 0) {
        sidestep--;
        // Perpendicular to the heading, blended with a little forward drive.
        ix = -heading.z * sidestepDir * 0.85 + heading.x * 0.35;
        iz = heading.x * sidestepDir * 0.85 + heading.z * 0.35;
      }
      // Camera yaw of 0 means the input axes are world axes.
      player.update(DT, { x: ix, z: iz, sprint: true, jump: false }, 0);
      steps++;

      const now = player.getState().position;
      const moved = now.distanceTo(previous);
      distance += moved;
      previous.copy(now);
      // Wedged against geometry: no progress for a full simulated second.
      stalled = moved < 0.004 ? stalled + 1 : 0;
      if (stalled === 14 && sidestep === 0) {
        sidestep = 30;
        sidestepDir = -sidestepDir;
      }
      if (stalled > 150) {
        const stuck = [Math.round(now.x * 10) / 10, Math.round(now.z * 10) / 10];
        player.reset(savedPos, savedFacing);
        return { seconds: steps * DT, distance, arrived: false, stuckAt: stuck };
      }
      if (collision.isOutOfWorld(now)) break;
    }
  }

  const final = player.getState().position;
  const last = path[path.length - 1];
  const arrived = Math.hypot(final.x - last.x, final.z - last.z) <= ARRIVE * 2;
  player.reset(savedPos, savedFacing);
  return { seconds: Math.round(steps * DT * 100) / 100, distance: Math.round(distance), arrived, stuckAt: null };
}

function countObjects(root: THREE.Object3D): number {
  let n = 0;
  root.traverse(() => n++);
  return n;
}

function countLights(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) n++;
  });
  return n;
}
