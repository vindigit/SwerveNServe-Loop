// @vitest-environment jsdom

import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";

import { Courier } from "@/character/Courier";
import { PlayerConfig } from "@/config/gameConfig";
import { PlayerController } from "@/modules/PlayerController";
import { resolveObstructedCameraPosition } from "@/modules/ThirdPersonCamera";
import { CollisionWorld } from "@/world/CollisionWorld";
import { createProps } from "@/world/props";
import type { LightRig } from "@/world/build";

beforeAll(() => {
  // Courier's painted face only needs fillStyle and fillRect. jsdom has a
  // canvas element but intentionally ships without a 2D rendering backend.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ fillStyle: "", fillRect: () => undefined }),
  });
});

function emptyCollision(): CollisionWorld {
  return new CollisionWorld([], { minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
}

describe("courier presentation", () => {
  it("rests its shoe soles on the actor root instead of below the floor", () => {
    const courier = new Courier();
    courier.object3d.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(courier.object3d);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    courier.dispose();
  });

  it("shows a parcel immediately while carrying and hides it on delivery", () => {
    const courier = new Courier();
    const parcel = courier.object3d.getObjectByName("carried-parcel");
    expect(parcel).toBeDefined();
    expect(parcel!.visible).toBe(false);

    courier.setCarrying(true);
    expect(parcel!.visible).toBe(true);
    courier.setCarrying(false);
    expect(parcel!.visible).toBe(false);
    courier.dispose();
  });
});

describe("jump feel", () => {
  function jump(holdFrames: number): { apex: number; seconds: number } {
    const player = new PlayerController(emptyCollision());
    player.reset(new THREE.Vector3(0, 0, 0), 0);
    let apex = 0;
    let frames = 0;
    do {
      const held = frames < holdFrames;
      player.update(1 / 60, { x: 0, z: 0, sprint: false, jump: held }, 0);
      apex = Math.max(apex, player.getState().position.y);
      frames++;
    } while ((!player.getState().grounded || frames === 1) && frames < 120);
    return { apex, seconds: frames / 60 };
  }

  it("gives held jumps a readable arc and lets a tap cut the jump short", () => {
    const held = jump(120);
    const tapped = jump(1);
    expect(held.apex).toBeGreaterThan(0.9);
    expect(held.apex).toBeLessThan(1.3);
    expect(tapped.apex).toBeLessThan(held.apex - 0.25);
    expect(held.seconds).toBeLessThan(0.8);
    expect(PlayerConfig.jumpSpeed).toBeGreaterThan(6.2);
  });
});

describe("camera and environment support", () => {
  it("clamps a cinematic camera in front of a blocking building", () => {
    const collision = new CollisionWorld(
      [{ minX: -4, maxX: 4, minY: 0, maxY: 8, minZ: 4, maxZ: 6, kind: "wall" }],
      { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }
    );
    const out = new THREE.Vector3();
    resolveObstructedCameraPosition(
      collision,
      new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(0, 2, 10),
      0.75,
      out
    );
    expect(out.z).toBeCloseTo(3.25, 5);
  });

  it("does not build a ladder above the fire escape's top landing", () => {
    const rig: LightRig = {
      ambientTop: new THREE.Color(0.2, 0.2, 0.2),
      ambientSide: new THREE.Color(0.1, 0.1, 0.1),
      lamps: [],
    };
    const built = createProps(rig, { fireEscape: [{ x: 0, z: 0 }] });
    const mesh = built.meshes[0] as THREE.InstancedMesh;
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.y).toBeLessThan(11);
    built.dispose();
  });
});
