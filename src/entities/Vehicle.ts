import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { World } from '../world/World';
import type { Character } from './Character';
import { VehicleModel, type VehicleSpec } from './VehicleModel';

let nextId = 1;

export interface VehicleControls {
  /** -1..1; negative brakes, then reverses. */
  throttle: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
  handbrake: boolean;
}

export type VehicleState = 'ok' | 'burning' | 'wrecked' | 'sinking';

export interface ImpactEvent {
  vehicle: Vehicle;
  speed: number;
  x: number;
  z: number;
}

/**
 * Arcade car physics on the ground plane. The car is modelled as a line of circles for collision,
 * with a simple slip model: forward/lateral velocity are integrated separately and lateral velocity
 * is damped by tyre grip (much less with the handbrake, which gives drifts).
 */
export class Vehicle {
  readonly id = nextId++;
  readonly model: VehicleModel;
  readonly pos = new THREE.Vector3();
  /** Planar velocity (x, z). */
  vx = 0;
  vz = 0;
  /** Vertical velocity (m/s). */
  vy = 0;
  /** Terrain pitch (nose up positive) and roll, radians. */
  pitch = 0;
  roll = 0;
  airborne = false;
  heading = 0;
  angVel = 0;
  steerAngle = 0;
  health: number;
  state: VehicleState = 'ok';
  burnTime = 0;
  sinkTime = 0;
  wreckTime = 0;
  driver: Character | null = null;
  sirenOn = false;
  /** Persistent parked vehicles (e.g. the one at spawn) are not despawned by the population system. */
  persistent = false;
  /**
   * Kinematic vehicles (tram sections) are positioned by their own system: no physics, not pushed
   * by collisions, not enterable and indestructible.
   */
  kinematic = false;
  /** Set when the player has driven this car (police remember stolen cars). */
  stolen = false;
  readonly controls: VehicleControls = { throttle: 0, steer: 0, handbrake: false };
  /** Impacts that happened during the last update (consumed by game systems for damage/sfx). */
  readonly impacts: ImpactEvent[] = [];
  lastDamager: Character | null = null;
  private time = 0;

  constructor(readonly spec: VehicleSpec, color: string) {
    this.model = new VehicleModel(spec, color);
    this.health = spec.health;
  }

  get object(): THREE.Object3D {
    return this.model.root;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  get forwardSpeed(): number {
    return this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading);
  }

  get alive(): boolean {
    return this.state === 'ok' || this.state === 'burning';
  }

  /** Collision circles along the car's axis (world positions), radius = half width. */
  circles(): { x: number; z: number; r: number; offset: number }[] {
    const r = this.spec.width / 2;
    const half = this.spec.length / 2 - r;
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    const out = [];
    const n = Math.max(3, Math.ceil(this.spec.length / this.spec.width) + 1);
    for (let i = 0; i < n; i++) {
      const off = -half + (2 * half * i) / (n - 1);
      out.push({ x: this.pos.x + s * off, z: this.pos.z + c * off, r, offset: off });
    }
    return out;
  }

  /** Position just outside the driver's door (left side; Sweden drives on the right). */
  doorPosition(side: -1 | 1 = 1): { x: number; z: number } {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    // Left of forward (s, c) is (c, -s).
    const d = this.spec.width / 2 + 0.6;
    return { x: this.pos.x + c * d * side, z: this.pos.z - s * d * side };
  }

  damage(amount: number, by: Character | null) {
    if (!this.alive || this.kinematic) return;
    if (by) this.lastDamager = by;
    this.health -= amount;
    if (this.health <= 0 && this.state === 'ok') {
      this.state = 'burning';
      this.burnTime = 0;
    }
  }

  update(dt: number, world: World) {
    this.time += dt;
    this.impacts.length = 0;
    if (this.kinematic) {
      this.object.position.copy(this.pos);
      this.object.rotation.y = this.heading;
      return;
    }
    const spec = this.spec;
    const ctl = this.controls;
    const drivable = this.state === 'ok' || this.state === 'burning';
    const hasDriver = !!this.driver && drivable;

    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    let vF = this.vx * s + this.vz * c;
    // Gravity along the slope.
    if (!this.airborne) vF -= 9.81 * Math.sin(this.pitch) * dt;
    // Right of forward (s, c) is (-c, s).
    let vR = this.vx * -c + this.vz * s;

    const throttle = hasDriver ? ctl.throttle : 0;
    const handbrake = hasDriver ? ctl.handbrake : !this.driver;
    let braking = false;
    if (throttle > 0) {
      if (vF < -0.5) {
        vF = Math.min(0, vF + spec.brake * dt);
        braking = true;
      } else {
        vF += spec.accel * throttle * dt * clamp(1.15 - vF / spec.maxSpeed, 0, 1);
      }
    } else if (throttle < 0) {
      if (vF > 0.5) {
        vF = Math.max(0, vF - spec.brake * -throttle * dt);
        braking = true;
      } else {
        vF = Math.max(-spec.maxSpeed * 0.3, vF + spec.accel * 0.7 * throttle * dt);
      }
    } else {
      // Rolling resistance / engine braking.
      const roll = (this.driver ? 1.2 : 4) * dt;
      vF = Math.abs(vF) <= roll ? 0 : vF - Math.sign(vF) * roll;
    }
    if (handbrake) {
      const hb = 7 * dt;
      vF = Math.abs(vF) <= hb ? 0 : vF - Math.sign(vF) * hb;
      braking = braking || this.driver !== null;
    }
    // Aerodynamic drag, roughly balancing the tapered engine force at top speed.
    vF -= vF * Math.abs(vF) * 0.0006 * dt;

    // Tyre grip: kill lateral slip (less with the handbrake).
    const grip = handbrake && this.driver ? 1.6 : spec.grip;
    vR *= Math.exp(-grip * dt);

    // Steering (speed-sensitive, bicycle model).
    const targetSteer = hasDriver ? ctl.steer : 0;
    this.steerAngle += (targetSteer - this.steerAngle) * damp(8, dt);
    const steerLimit = spec.steer / (1 + Math.abs(vF) / 28);
    const wheelBase = spec.length * 0.62;
    // Positive steer turns right, which is a decreasing heading (heading h faces (sin h, cos h)).
    let yawRate = -(vF * Math.tan(this.steerAngle * steerLimit)) / wheelBase;
    if (handbrake && this.driver) yawRate *= 1.35;

    this.angVel *= Math.exp(-5 * dt);
    this.heading += (yawRate + this.angVel) * dt;

    this.vx = s * vF - c * vR;
    this.vz = c * vF + s * vR;

    // Water: stall and sink.
    if (this.state !== 'sinking' && this.state !== 'wrecked' && !this.airborne && world.surfaceAt(this.pos.x, this.pos.z, this.pos.y) === 'water') {
      this.state = 'sinking';
      this.sinkTime = 0;
    }
    if (this.state === 'sinking') {
      this.sinkTime += dt;
      this.vx *= Math.exp(-2.5 * dt);
      this.vz *= Math.exp(-2.5 * dt);
      const level = world.waterLevelAt(this.pos.x, this.pos.z) ?? world.groundHeight(this.pos.x, this.pos.z);
      this.pos.y = level - Math.min(2.5, this.sinkTime * 0.7);
    }
    if (this.state === 'burning') this.burnTime += dt;
    if (this.state === 'wrecked') {
      this.wreckTime += dt;
      this.vx *= Math.exp(-3 * dt);
      this.vz *= Math.exp(-3 * dt);
    }

    // Integrate in two substeps to avoid tunnelling through thin walls at speed.
    const steps = this.speed * dt > 0.5 ? 3 : 1;
    for (let i = 0; i < steps; i++) {
      this.pos.x += (this.vx * dt) / steps;
      this.pos.z += (this.vz * dt) / steps;
      this.collideStatic(world);
    }

    if (this.state !== 'sinking') this.followSurface(dt, world);

    this.object.position.copy(this.pos);
    this.object.rotation.set(-this.pitch, this.heading, this.roll, 'YXZ');
    // Body roll/pitch for a bit of weight.
    const bg = this.model.bodyGroup;
    bg.rotation.z += (clamp(-yawRate * vF * 0.004, -0.06, 0.06) - bg.rotation.z) * damp(6, dt);
    bg.rotation.x += (clamp((braking ? 1 : 0) * vF * 0.002 - throttle * 0.01, -0.05, 0.05) - bg.rotation.x) * damp(6, dt);
    this.model.animate(dt, vF, this.steerAngle, braking, this.sirenOn && this.alive, this.time);
  }

  /**
   * Keeps the car on the terrain / bridge decks: height from the ground under the axles, pitch and roll
   * from the slope. When the ground drops away faster than the car follows (a crest at speed), it
   * becomes airborne and flies ballistically until it lands.
   */
  private followSurface(dt: number, world: World) {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    const hl = this.spec.length * 0.36;
    const hw = this.spec.width * 0.4;
    const y = this.pos.y;
    const hF = world.surfaceHeight(this.pos.x + s * hl, this.pos.z + c * hl, y + 0.5);
    const hB = world.surfaceHeight(this.pos.x - s * hl, this.pos.z - c * hl, y + 0.5);
    const hL = world.surfaceHeight(this.pos.x + c * hw, this.pos.z - s * hw, y + 0.5);
    const hR = world.surfaceHeight(this.pos.x - c * hw, this.pos.z + s * hw, y + 0.5);
    const ground = (hF + hB + hL + hR) / 4;
    const pitch = Math.atan2(hF - hB, hl * 2);
    const roll = Math.atan2(hL - hR, hw * 2);

    if (this.airborne) {
      this.vy -= 20 * dt;
      this.pos.y += this.vy * dt;
      // Nose drops a little in flight.
      this.pitch += (-0.15 - this.pitch) * damp(0.8, dt);
      if (this.pos.y <= ground) {
        if (this.vy < -9) this.impacts.push({ vehicle: this, speed: (-this.vy - 9) * 1.5, x: this.pos.x, z: this.pos.z });
        this.pos.y = ground;
        this.vy = 0;
        this.airborne = false;
      }
    } else {
      const followVy = (ground - y) / Math.max(dt, 1e-3);
      if (ground < y - 0.3 && this.vy > -1) {
        // The ground fell away beneath us: take off with the current vertical speed.
        this.airborne = true;
      } else {
        this.vy += (followVy - this.vy) * 0.5;
        this.pos.y = ground;
        this.pitch += (pitch - this.pitch) * damp(12, dt);
        this.roll += (roll - this.roll) * damp(12, dt);
      }
    }
  }

  private collideStatic(world: World) {
    for (const circle of this.circles()) {
      const p = { x: circle.x, z: circle.z };
      const push = world.collision.resolveCircle(p, circle.r, this.pos.y + 0.4, this.pos.y + 1.4);
      if (!push) continue;
      const dx = p.x - circle.x;
      const dz = p.z - circle.z;
      this.pos.x += dx;
      this.pos.z += dz;
      const vn = this.vx * push.nx + this.vz * push.nz;
      if (vn < 0) {
        const restitution = 0.25;
        this.vx -= (1 + restitution) * vn * push.nx;
        this.vz -= (1 + restitution) * vn * push.nz;
        // Friction along the wall.
        this.vx *= 0.92;
        this.vz *= 0.92;
        // Off-center hits spin the car.
        const s = Math.sin(this.heading);
        const c = Math.cos(this.heading);
        const cross = circle.offset * (s * push.nz - c * push.nx);
        this.angVel += clamp(cross * -vn * 0.08, -3, 3);
        if (-vn > 2) this.impacts.push({ vehicle: this, speed: -vn, x: circle.x - push.nx * circle.r, z: circle.z - push.nz * circle.r });
      }
    }
  }
}
