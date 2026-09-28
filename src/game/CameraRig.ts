import * as THREE from 'three';
import { angleDiff, clamp, damp, lerp } from '../core/math';
import type { Character } from '../entities/Character';
import type { Input } from '../core/Input';
import type { World } from '../world/World';

const MOUSE_SENSITIVITY = 0.0024;

/**
 * Third-person camera. On foot: free orbit with mouse, over-the-shoulder when aiming.
 * In a vehicle: chase camera that recenters behind the car after mouse look.
 * Pulls in when a building is between the camera and the target.
 */
export class CameraRig {
  yaw = Math.PI;
  pitch = 0.25;
  private aimBlend = 0;
  private distance = 5;
  private lastMouseLook = -10;
  private time = 0;
  private readonly pivot = new THREE.Vector3();
  private readonly smoothPivot = new THREE.Vector3();
  private initialized = false;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Forward direction of the camera on the ground plane. */
  get forwardX() {
    return Math.sin(this.yaw);
  }

  get forwardZ() {
    return Math.cos(this.yaw);
  }

  snapBehind(heading: number) {
    this.yaw = heading;
    this.pitch = 0.22;
    this.initialized = false;
  }

  update(dt: number, input: Input, player: Character, world: World, shake: number) {
    this.time += dt;
    const v = player.vehicle;
    if (input.mouseDX || input.mouseDY) this.lastMouseLook = this.time;
    this.yaw -= input.mouseDX * MOUSE_SENSITIVITY;
    this.pitch = clamp(this.pitch + input.mouseDY * MOUSE_SENSITIVITY, -0.9, 1.2);

    let targetDist: number;
    let height: number;
    let shoulder = 0;
    let fov = 65;
    if (v) {
      // Recenter behind the car when the player isn't looking around.
      const speed = v.speed;
      const moving = speed > 2;
      if (moving && this.time - this.lastMouseLook > 1.2) {
        const travel = v.forwardSpeed < -2 ? v.heading + Math.PI : v.heading;
        this.yaw += angleDiff(this.yaw, travel) * damp(2.5, dt);
        this.pitch += (0.22 - this.pitch) * damp(2, dt);
      }
      targetDist = v.spec.length * 1.25 + 3 + Math.min(speed, 40) * 0.05;
      height = v.spec.height + 0.4;
      fov = 65 + clamp(speed - 15, 0, 30) * 0.4;
      this.aimBlend = 0;
      this.pivot.set(v.pos.x, v.pos.y + height, v.pos.z);
    } else {
      const aiming = player.aiming;
      this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * damp(12, dt);
      targetDist = lerp(4.2, 2.4, this.aimBlend);
      shoulder = lerp(0.35, 0.95, this.aimBlend);
      height = lerp(1.65, 1.75, this.aimBlend);
      fov = lerp(65, 50, this.aimBlend);
      const y = player.alive ? player.pos.y : 0;
      this.pivot.set(player.pos.x, y + height, player.pos.z);
    }

    if (!this.initialized) {
      this.smoothPivot.copy(this.pivot);
      this.distance = targetDist;
      this.initialized = true;
    }
    // Vehicles move fast; follow tightly so the car stays framed.
    this.smoothPivot.lerp(this.pivot, damp(v ? 18 : 25, dt));

    // Offset: behind the pivot along -forward, raised by pitch, plus shoulder offset to the right.
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const bx = -Math.sin(this.yaw) * cp;
    const bz = -Math.cos(this.yaw) * cp;
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    const origin = this.smoothPivot.clone();
    origin.x += rx * shoulder;
    origin.z += rz * shoulder;

    // Collision: shorten the boom if a wall is in the way.
    let dist = targetDist;
    const hit = world.collision.raycast(origin.x, origin.z, bx, bz, targetDist * cp + 0.5, origin.y, cp > 0.05 ? sp / cp : 0);
    if (hit) dist = Math.max(0.8, Math.min(targetDist, hit.distance / Math.max(cp, 0.05) - 0.4));
    this.distance = dist < this.distance ? dist : this.distance + (dist - this.distance) * damp(3, dt);

    const cam = this.camera;
    cam.position.set(origin.x + bx * this.distance, Math.max(0.4, origin.y + sp * this.distance), origin.z + bz * this.distance);
    if (shake > 0) {
      const s = shake * 0.25;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
    }
    // Look slightly above the pivot so the character sits low in frame.
    cam.lookAt(origin.x - bx * 10, origin.y - sp * 10 + 0.3, origin.z - bz * 10);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * damp(6, dt);
      cam.updateProjectionMatrix();
    }
  }

  /** World-space ray from the camera through the screen center (the crosshair). */
  aimRay(origin: THREE.Vector3, dir: THREE.Vector3) {
    origin.copy(this.camera.position);
    this.camera.getWorldDirection(dir);
  }
}
