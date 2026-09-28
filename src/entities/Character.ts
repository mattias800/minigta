import * as THREE from 'three';
import { angleDiff, clamp, damp } from '../core/math';
import { Inventory } from '../game/weapons';
import type { World } from '../world/World';
import { CharacterModel, type CharacterLook, type Pose } from './CharacterModel';
import type { Vehicle } from './Vehicle';

export type CharacterRole = 'player' | 'civilian' | 'cop';

let nextId = 1;

const GRAVITY = 22;

/**
 * A person in the world (player, pedestrian or police officer). Controllers and AI brains write the
 * intent fields each frame; `update` turns intent into movement with collision and animation.
 */
export class Character {
  readonly id = nextId++;
  readonly model: CharacterModel;
  readonly inventory = new Inventory();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  heading = 0;
  health = 100;
  maxHealth = 100;
  armor = 0;
  alive = true;
  radius = 0.3;
  vehicle: Vehicle | null = null;
  /** Seconds since death (bodies are cleaned up after a while). */
  deadTime = 0;
  /** Knocked down (e.g. by a car); can't act while > 0. */
  downTime = 0;
  swimming = false;
  onGround = true;
  /** Who damaged this character last (for crime attribution and AI reactions). */
  lastAttacker: Character | null = null;

  // --- Intent (written by controllers) ---
  /** Desired movement direction in world space; length 0..1. */
  moveX = 0;
  moveZ = 0;
  /** Target walking speed at full input (m/s). */
  moveSpeed = 1.5;
  /** If set, the character faces this heading instead of its movement direction (aiming). */
  faceHeading: number | null = null;
  aiming = false;
  aimPitch = 0;
  wantJump = false;

  constructor(
    readonly role: CharacterRole,
    look: CharacterLook,
  ) {
    this.model = new CharacterModel(look);
  }

  get object(): THREE.Object3D {
    return this.model.root;
  }

  get canAct(): boolean {
    return this.alive && this.downTime <= 0 && !this.vehicle;
  }

  /** Point at chest height, used for aiming and line-of-sight checks. */
  chest(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + 1.3, this.pos.z);
  }

  damage(amount: number, attacker: Character | null) {
    if (!this.alive) return;
    if (attacker) this.lastAttacker = attacker;
    const absorbed = Math.min(this.armor, amount * 0.7);
    this.armor -= absorbed;
    this.health -= amount - absorbed;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deadTime = 0;
    }
  }

  /** Throws the character (car impact, explosion). */
  knock(vx: number, vy: number, vz: number, downSeconds: number) {
    this.vel.set(vx, vy, vz);
    this.onGround = false;
    this.downTime = Math.max(this.downTime, downSeconds);
  }

  update(dt: number, world: World) {
    if (this.vehicle) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.inventory.update(dt);
    if (!this.alive) this.deadTime += dt;
    if (this.downTime > 0 && this.onGround) this.downTime -= dt;

    const surface = world.surfaceAt(this.pos.x, this.pos.z, this.pos.y);
    this.swimming = surface === 'water' && this.onGround;

    // Horizontal movement: accelerate towards the desired velocity.
    const active = this.alive && this.downTime <= 0;
    let speed = this.moveSpeed * (this.swimming ? 0.45 : 1);
    if (!active) speed = 0;
    const mlen = Math.hypot(this.moveX, this.moveZ);
    const mx = mlen > 1 ? this.moveX / mlen : this.moveX;
    const mz = mlen > 1 ? this.moveZ / mlen : this.moveZ;
    if (this.onGround) {
      const k = damp(active ? 10 : 4, dt);
      this.vel.x += (mx * speed - this.vel.x) * k;
      this.vel.z += (mz * speed - this.vel.z) * k;
      if (active && this.wantJump && !this.swimming) {
        this.vel.y = 6.5;
        this.onGround = false;
      }
    }
    this.wantJump = false;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Vertical: follow the terrain / bridge decks; fall when walking off an edge.
    const ground = world.surfaceHeight(this.pos.x, this.pos.z, this.pos.y);
    if (this.onGround) {
      if (ground < this.pos.y - 0.7) {
        this.onGround = false;
        this.vel.y = 0;
      } else {
        this.pos.y = ground;
        this.vel.y = 0;
      }
    }
    if (!this.onGround) {
      this.vel.y -= GRAVITY * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= ground) {
        if (this.vel.y < -14) this.damage((-this.vel.y - 14) * 4, null);
        this.pos.y = ground;
        this.vel.y = 0;
        this.onGround = true;
      }
    }

    // Static collision against obstacles at body height.
    const push = world.collision.resolveCircle(this.pos, this.radius, this.pos.y + 0.4, this.pos.y + 1.8);
    if (push) {
      const vn = this.vel.x * push.nx + this.vel.z * push.nz;
      if (vn < 0) {
        this.vel.x -= vn * push.nx;
        this.vel.z -= vn * push.nz;
      }
    }

    // Facing.
    const groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (active) {
      let target: number | null = this.faceHeading;
      if (target === null && mlen > 0.1) target = Math.atan2(mx, mz);
      if (target !== null) this.heading += angleDiff(this.heading, target) * damp(14, dt);
    }

    this.object.position.copy(this.pos);
    this.object.rotation.y = this.heading;
    let pose: Pose = 'stand';
    if (!this.alive) pose = 'dead';
    else if (this.downTime > 0) pose = 'down';
    else if (this.swimming) pose = 'swim';
    else if (this.aiming) pose = 'aim';
    this.model.setGun(this.aiming || this.role === 'cop' ? this.inventory.def.model : 'none');
    this.model.animate(dt, active ? groundSpeed : 0, pose, clamp(this.aimPitch, -1, 1));
  }
}
