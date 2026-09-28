import * as THREE from 'three';
import { angleDiff, clamp, rand } from '../core/math';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import type { GameContext } from '../game/GameContext';
import type { RoadNode } from '../world/RoadNetwork';
import { CopDriverBrain } from './CopDriverBrain';
import { PedBrain } from './PedBrain';

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/**
 * Police officer on foot. Patrols like a pedestrian when the player isn't wanted; otherwise chases
 * the player, tries to arrest at low wanted levels and shoots at higher ones. Returns to their car
 * if the player drives off.
 */
export class CopBrain extends PedBrain {
  override readonly kind = 'cop';
  private losTimer = 0;
  private hasLos = false;
  private aimTime = 0;
  private burst = 0;
  private burstPause = 0;
  private path: RoadNode[] | null = null;
  private pathTimer = 0;

  constructor(
    me: Character,
    private car: Vehicle | null = null,
  ) {
    super(me);
    this.bravery = 1;
  }

  /** Cops don't run away. */
  override flee() {}

  override attacked() {}

  override update(dt: number, ctx: GameContext) {
    const me = this.me;
    const stars = ctx.wanted();
    if (stars === 0 || !ctx.player.alive) {
      super.update(dt, ctx);
      return;
    }
    me.faceHeading = null;
    me.aiming = false;
    if (!me.canAct) {
      me.moveX = me.moveZ = 0;
      return;
    }
    const player = ctx.player;
    const target = player.vehicle ? player.vehicle.pos : player.pos;
    const dx = target.x - me.pos.x;
    const dz = target.z - me.pos.z;
    const dist = Math.hypot(dx, dz);

    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.25;
      const eye = me.chest(tmpA);
      const aim = player.vehicle ? tmpB.set(target.x, 1.1, target.z) : player.chest(tmpB);
      this.hasLos = dist < 70 && ctx.world.collision.lineOfSight(eye.x, eye.y, eye.z, aim.x, aim.y, aim.z);
    }

    // Player drove away: get back in the car and give chase.
    if (player.vehicle && dist > 28 && this.car && this.car.alive && !this.car.driver) {
      const door = this.car.doorPosition(1);
      const cd = Math.hypot(door.x - me.pos.x, door.z - me.pos.z);
      if (cd < 45) {
        if (cd < 2.2) {
          this.car.driver = me;
          me.vehicle = this.car;
          ctx.entities.setBrain(me, new CopDriverBrain(me));
          return;
        }
        this.moveTowards(ctx, door.x, door.z, 5.6);
        return;
      }
    }

    const shooting = stars >= 2 && this.hasLos && dist < 38;
    if (shooting) {
      me.faceHeading = Math.atan2(dx, dz);
      me.aiming = true;
      this.aimTime += dt;
      const eye = me.chest(tmpA);
      const aimPoint = player.vehicle ? tmpB.set(target.x, 1.1, target.z) : player.chest(tmpB);
      me.aimPitch = Math.atan2(aimPoint.y - eye.y, dist);
      // Keep a working distance while shooting.
      if (dist > 20) this.moveTowards(ctx, target.x, target.z, 2.5);
      else if (dist < 5) this.moveTowards(ctx, me.pos.x - dx, me.pos.z - dz, 2);
      else me.moveX = me.moveZ = 0;

      this.burstPause -= dt;
      if (this.aimTime > 0.9 && this.burstPause <= 0 && Math.abs(angleDiff(me.heading, me.faceHeading)) < 0.3) {
        // Accuracy drops with distance and target speed.
        const tSpeed = player.vehicle ? player.vehicle.speed : Math.hypot(player.vel.x, player.vel.z);
        const accuracy = clamp(0.9 - dist / 60 - tSpeed / 25, 0.15, 0.8);
        const miss = new THREE.Vector3(rand(-1, 1), rand(-0.5, 0.5), rand(-1, 1)).multiplyScalar((1 - accuracy) * 1.6);
        if (ctx.combat.fire(me, eye.clone().add(new THREE.Vector3(Math.sin(me.heading) * 0.4, 0, Math.cos(me.heading) * 0.4)), aimPoint.clone().add(miss), 1, 0.32)) {
          this.burst++;
          if (this.burst >= 3) {
            this.burst = 0;
            this.burstPause = rand(1.2, 2.2);
          }
        }
      }
      return;
    }
    this.aimTime = 0;

    // Chase (to arrest at 1 star, or to regain line of sight).
    if (this.hasLos || dist < 12) {
      this.path = null;
      if (dist > 0.9) this.moveTowards(ctx, target.x, target.z, 5.6);
      else me.moveX = me.moveZ = 0;
      me.faceHeading = Math.atan2(dx, dz);
    } else {
      this.followPath(ctx, dt, target.x, target.z);
    }
  }

  private moveTowards(ctx: GameContext, x: number, z: number, speed: number) {
    const me = this.me;
    me.moveSpeed = speed;
    let dir = Math.atan2(x - me.pos.x, z - me.pos.z);
    const col = ctx.world.collision;
    for (const off of [0, 0.4, -0.4, 0.9, -0.9, 1.5, -1.5]) {
      const a = dir + off;
      if (!col.raycast(me.pos.x, me.pos.z, Math.sin(a), Math.cos(a), 2, 1)) {
        dir = a;
        break;
      }
    }
    me.moveX = Math.sin(dir);
    me.moveZ = Math.cos(dir);
  }

  /** Walks the street network towards the target when there is no direct line. */
  private followPath(ctx: GameContext, dt: number, tx: number, tz: number) {
    const me = this.me;
    const net = ctx.world.roads;
    this.pathTimer -= dt;
    if (!this.path || this.pathTimer <= 0) {
      this.pathTimer = 2;
      const a = net.nearestNode(me.pos.x, me.pos.z, 40);
      const b = net.nearestNode(tx, tz, 40);
      this.path = a && b ? net.findPath(a, b, { respectOneway: false, drivableOnly: false }, 2500) : null;
    }
    const path = this.path;
    if (!path || !path.length) {
      this.moveTowards(ctx, tx, tz, 5.6);
      return;
    }
    while (path.length > 1 && Math.hypot(path[0].x - me.pos.x, path[0].z - me.pos.z) < 2) path.shift();
    this.moveTowards(ctx, path[0].x, path[0].z, 5.6);
  }
}
