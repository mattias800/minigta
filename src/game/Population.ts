import * as THREE from 'three';
import { CopBrain } from '../ai/CopBrain';
import { DriverBrain } from '../ai/DriverBrain';
import { PedBrain } from '../ai/PedBrain';
import { chance, rand } from '../core/math';
import type { Character } from '../entities/Character';
import type { GameContext } from './GameContext';
import { createCivilian, createCop, createVehicle, edgeHeight, lanePose, parkedPose, randomTrafficType } from './spawn';

const PED_TARGET = 44;
const TRAFFIC_TARGET = 20;
const PARKED_TARGET = 14;
const PED_SPAWN = [35, 100] as const;
const CAR_SPAWN = [80, 170] as const;
const PED_DESPAWN = 150;
const CAR_DESPAWN = 210;

const tmp = new THREE.Vector3();

/**
 * Keeps the streets alive around the player: spawns pedestrians, traffic and parked cars in a ring
 * outside the immediate view and removes them when far away. Also makes crowds react to violence.
 */
export class Population {
  private timer = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();

  constructor(
    private readonly ctx: GameContext,
    private readonly camera: THREE.Camera,
  ) {
    const ev = ctx.events;
    ev.on('gunshot', (e) => {
      for (const c of ctx.entities.charactersNear(e.x, e.z, e.noise * 0.6)) {
        if (c === e.shooter) continue;
        const b = ctx.entities.brainOf(c);
        if (b instanceof PedBrain) b.flee(e.x, e.z);
        if (b instanceof DriverBrain) b.scare();
      }
    });
    ev.on('death', (e) => {
      for (const c of ctx.entities.charactersNear(e.victim.pos.x, e.victim.pos.z, 25)) {
        const b = ctx.entities.brainOf(c);
        if (b instanceof PedBrain) b.flee(e.victim.pos.x, e.victim.pos.z);
      }
    });
    ev.on('injure', (e) => {
      const b = ctx.entities.brainOf(e.victim);
      if (b instanceof PedBrain) b.attacked(e.attacker);
    });
  }

  update(dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.4;
    const ctx = this.ctx;
    const focus = ctx.player.vehicle ? ctx.player.vehicle.pos : ctx.player.pos;
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.despawn(focus);

    const peds = ctx.entities.characters.filter((c) => c.role !== 'player' && !c.vehicle && c.alive).length;
    const moving = ctx.entities.vehicles.filter((v) => v.driver && v.driver !== ctx.player).length;
    const parked = ctx.entities.vehicles.filter((v) => !v.driver && !v.persistent && !v.kinematic).length;
    for (let i = 0; i < 3 && peds + i < PED_TARGET; i++) this.spawnPed(focus);
    if (moving < TRAFFIC_TARGET) this.spawnTraffic(focus);
    if (parked < PARKED_TARGET) this.spawnParked(focus);
  }

  /** Fills the area around the player right away (used when entering the world / respawning). */
  prime() {
    const ctx = this.ctx;
    const focus = ctx.player.vehicle ? ctx.player.vehicle.pos : ctx.player.pos;
    this.priming = true;
    for (let i = 0; i < PED_TARGET * 3; i++) this.spawnPed(focus, 8);
    for (let i = 0; i < TRAFFIC_TARGET * 3; i++) this.spawnTraffic(focus, 25);
    for (let i = 0; i < PARKED_TARGET * 3; i++) this.spawnParked(focus, 12);
    this.priming = false;
  }

  private priming = false;

  private visible(x: number, z: number): boolean {
    if (this.priming) return false;
    return this.frustum.containsPoint(tmp.set(x, this.ctx.world.groundHeight(x, z) + 1.5, z));
  }

  private despawn(focus: THREE.Vector3) {
    const ctx = this.ctx;
    for (const c of [...ctx.entities.characters]) {
      if (c === ctx.player || c.vehicle) continue;
      const d = Math.hypot(c.pos.x - focus.x, c.pos.z - focus.z);
      const tooFar = d > PED_DESPAWN || (!c.alive && c.deadTime > 45 && !this.visible(c.pos.x, c.pos.z));
      // Remove bodies and people standing on unloaded ground.
      if (tooFar || !ctx.world.isChunkLoaded(c.pos.x, c.pos.z)) ctx.entities.removeCharacter(c);
    }
    for (const v of [...ctx.entities.vehicles]) {
      if (v.driver === ctx.player || v.kinematic) continue;
      const d = Math.hypot(v.pos.x - focus.x, v.pos.z - focus.z);
      const sunk = v.state === 'sinking' && v.sinkTime > 6;
      const oldWreck = v.state === 'wrecked' && v.wreckTime > 60 && !this.visible(v.pos.x, v.pos.z);
      if (sunk && v.driver) {
        // Drivers of sunk cars drown.
        ctx.combat.damageCharacter(v.driver, 1000, null, 'other');
      }
      if ((d > CAR_DESPAWN && !v.persistent) || sunk || oldWreck || (d > 400 && v.persistent) || !ctx.world.isChunkLoaded(v.pos.x, v.pos.z)) {
        ctx.entities.removeVehicle(v);
      }
    }
  }

  private spawnPed(focus: THREE.Vector3, minR: number = PED_SPAWN[0]) {
    const ctx = this.ctx;
    if (ctx.entities.characters.filter((c) => c.role !== 'player' && !c.vehicle && c.alive).length >= PED_TARGET) return;
    const edge = ctx.world.roads.randomEdgeInRing(focus.x, focus.z, minR, PED_SPAWN[1], (e) => e.kind !== 'motorway' && e.kind !== 'service');
    if (!edge) return;
    const t = Math.random();
    const off = edge.drivable ? edge.width / 2 + 1.3 : 0;
    const side = chance(0.5) ? 1 : -1;
    const x = edge.a.x + (edge.b.x - edge.a.x) * t - edge.dz * off * side;
    const z = edge.a.z + (edge.b.z - edge.a.z) * t + edge.dx * off * side;
    if (this.visible(x, z) && Math.hypot(x - focus.x, z - focus.z) < 60) return;
    const y = ctx.world.groundHeight(x, z);
    if (ctx.world.collision.circleHit(x, z, 0.4, y + 0.4, y + 1.8) || ctx.world.surfaceAt(x, z, y) === 'water') return;
    const isCop = chance(0.06);
    const c = isCop ? createCop() : createCivilian();
    c.pos.set(x, y, z);
    c.heading = rand(0, Math.PI * 2);
    ctx.entities.addCharacter(c, isCop ? new CopBrain(c) : new PedBrain(c));
  }

  private spawnTraffic(focus: THREE.Vector3, minR: number = CAR_SPAWN[0]) {
    const ctx = this.ctx;
    if (ctx.entities.vehicles.filter((v) => v.driver && v.driver !== ctx.player).length >= TRAFFIC_TARGET) return;
    const edge = ctx.world.roads.randomEdgeInRing(focus.x, focus.z, minR, CAR_SPAWN[1], (e) => e.drivable && e.kind !== 'service' && e.length > 6);
    if (!edge) return;
    const forward = edge.oneway ? true : chance(0.5);
    const pose = lanePose(edge, forward, rand(0.2, 0.8));
    if (this.visible(pose.x, pose.z) && Math.hypot(pose.x - focus.x, pose.z - focus.z) < 120) return;
    const y = edgeHeight(ctx.world, edge, 0.5, pose.x, pose.z);
    if (ctx.entities.vehiclesNear(pose.x, pose.z, 8).length || ctx.world.collision.circleHit(pose.x, pose.z, 1.2, y + 0.4, y + 1.4)) return;
    if (ctx.world.surfaceAt(pose.x, pose.z, y) === 'water') return;
    const type = chance(0.04) ? 'police' : randomTrafficType();
    const v = createVehicle(type);
    v.pos.set(pose.x, y, pose.z);
    v.heading = pose.heading;
    const speed = Math.min(8, edge.length);
    v.vx = Math.sin(pose.heading) * speed;
    v.vz = Math.cos(pose.heading) * speed;
    ctx.entities.addVehicle(v);
    const driver: Character = type === 'police' ? createCop() : createCivilian();
    driver.vehicle = v;
    v.driver = driver;
    driver.pos.copy(v.pos);
    ctx.entities.addCharacter(driver, new DriverBrain(driver, edge, forward));
  }

  private spawnParked(focus: THREE.Vector3, minR = 50) {
    const ctx = this.ctx;
    if (ctx.entities.vehicles.filter((v) => !v.driver && !v.persistent && !v.kinematic).length >= PARKED_TARGET) return;
    const edge = ctx.world.roads.randomEdgeInRing(
      focus.x,
      focus.z,
      minR,
      CAR_SPAWN[1],
      (e) => (e.kind === 'residential' || e.kind === 'service' || e.kind === 'tertiary') && e.length > 10 && !e.bridge,
    );
    if (!edge) return;
    const forward = chance(0.5);
    const pose = parkedPose(edge, forward, rand(0.25, 0.75));
    if (this.visible(pose.x, pose.z) && Math.hypot(pose.x - focus.x, pose.z - focus.z) < 90) return;
    const y = ctx.world.groundHeight(pose.x, pose.z);
    if (ctx.entities.vehiclesNear(pose.x, pose.z, 6).length || ctx.world.collision.circleHit(pose.x, pose.z, 1.1, y + 0.4, y + 1.4)) return;
    if (ctx.world.surfaceAt(pose.x, pose.z, y) === 'water') return;
    const v = createVehicle(randomTrafficType() === 'taxi' ? 'sedan' : randomTrafficType());
    v.pos.set(pose.x, y, pose.z);
    v.heading = pose.heading;
    ctx.entities.addVehicle(v);
  }
}
