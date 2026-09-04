import * as THREE from "three";
import { eventBus } from "@/core/EventBus";
import type { NavTarget } from "@/core/types";

/**
 * Crazy-Taxi-style navigation arrow: it floats over the courier and points in
 * a straight world-space direction. It deliberately does not bend around
 * corners; route knowledge remains the player's advantage.
 */
export class ObjectiveArrow {
  readonly object3d = new THREE.Group();

  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xffb02e,
    fog: false,
    toneMapped: false,
  });
  private readonly geometries: THREE.BufferGeometry[];
  private readonly unsubscribe: () => void;
  private target: NavTarget | null = null;
  private time = 0;

  constructor(scene: THREE.Object3D) {
    const shaftGeometry = new THREE.BoxGeometry(0.62, 0.24, 1.45);
    const headGeometry = new THREE.ConeGeometry(0.82, 1.25, 4);
    this.geometries = [shaftGeometry, headGeometry];

    const shaft = new THREE.Mesh(shaftGeometry, this.material);
    shaft.position.z = 0.36;
    const head = new THREE.Mesh(headGeometry, this.material);
    head.rotation.x = -Math.PI / 2;
    head.position.z = -0.72;
    this.object3d.add(shaft, head);
    this.object3d.scale.set(1.15, 1.15, 1.15);
    this.object3d.visible = false;
    this.object3d.name = "objective-arrow";
    scene.add(this.object3d);

    this.unsubscribe = eventBus.on("nav:target", ({ target }) => {
      this.target = target;
      this.object3d.visible = target !== null;
      if (target) {
        this.material.color.setHex(target.kind === "delivery" ? 0x9fd0ff : 0xffb02e);
      }
    });
  }

  update(dt: number, playerPosition: THREE.Vector3): void {
    if (!this.target) return;
    this.time += dt;
    this.object3d.position.set(
      playerPosition.x,
      playerPosition.y + 3.25 + Math.sin(this.time * 3.6) * 0.12,
      playerPosition.z
    );

    const dx = this.target.position.x - playerPosition.x;
    const dz = this.target.position.z - playerPosition.z;
    if (dx * dx + dz * dz > 0.01) this.object3d.rotation.y = Math.atan2(-dx, -dz);
  }

  reset(): void {
    this.target = null;
    this.time = 0;
    this.object3d.visible = false;
  }

  dispose(): void {
    this.unsubscribe();
    this.object3d.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    this.material.dispose();
  }
}
