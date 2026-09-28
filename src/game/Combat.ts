import * as THREE from 'three';
import { rand } from '../core/math';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import type { GameContext } from './GameContext';
import { WEAPONS } from './weapons';

export type Hit =
  | { kind: 'character'; character: Character; point: THREE.Vector3; distance: number; head: boolean }
  | { kind: 'vehicle'; vehicle: Vehicle; point: THREE.Vector3; distance: number; normal: THREE.Vector3 }
  | { kind: 'world'; point: THREE.Vector3; distance: number; normal: THREE.Vector3 }
  | { kind: 'ground'; point: THREE.Vector3; distance: number };

const tmpDir = new THREE.Vector3();
const tmpA = new THREE.Vector3();

/** Damage, weapons fire, hit detection and explosions. All damage goes through here so events fire. */
export class Combat {
  constructor(private readonly ctx: GameContext) {}

  damageCharacter(victim: Character, amount: number, attacker: Character | null, cause: 'bullet' | 'melee' | 'vehicle' | 'explosion' | 'other', dir?: THREE.Vector3) {
    if (!victim.alive || amount <= 0) return;
    victim.damage(amount, attacker);
    const fx = this.ctx.effects;
    const d = dir ?? tmpDir.set(0, 0, 0);
    if (cause !== 'other') fx.blood(victim.pos.x, victim.pos.y + 1.1, victim.pos.z, d.x, d.z, cause === 'bullet' ? 6 : 10);
    if (victim.alive) {
      this.ctx.events.emit('injure', { victim, attacker });
    } else {
      fx.bloodPool(victim.pos.x, victim.pos.z);
      this.ctx.events.emit('death', { victim, killer: attacker, cause });
    }
  }

  damageVehicle(v: Vehicle, amount: number, by: Character | null) {
    const wasAlive = v.state === 'ok';
    v.damage(amount, by);
    if (wasAlive && v.state === 'burning') v.lastDamager = by;
  }

  /**
   * Casts a ray against characters, vehicles, buildings and the ground.
   * `dir` must be normalized.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ignore: Character | null, ignoreVehicle: Vehicle | null = null): Hit | null {
    let best: Hit | null = null;
    let bestD = maxDist;

    const horiz = Math.hypot(dir.x, dir.z);
    if (horiz > 1e-4) {
      const wh = this.ctx.world.collision.raycast(origin.x, origin.z, dir.x, dir.z, maxDist * horiz, origin.y, dir.y / horiz);
      if (wh) {
        const d = wh.distance / horiz;
        if (d < bestD) {
          bestD = d;
          best = { kind: 'world', point: origin.clone().addScaledVector(dir, d), distance: d, normal: new THREE.Vector3(wh.nx, 0, wh.nz) };
        }
      }
    }
    if (dir.y < -1e-4) {
      const d = -origin.y / dir.y;
      if (d > 0 && d < bestD) {
        bestD = d;
        best = { kind: 'ground', point: origin.clone().addScaledVector(dir, d), distance: d };
      }
    }

    for (const c of this.ctx.entities.characters) {
      if (c === ignore || c.vehicle || !c.alive) continue;
      const d = rayCapsule(origin, dir, c.pos.x, c.pos.z, c.pos.y + (c.downTime > 0 ? 0 : 0.25), c.pos.y + (c.downTime > 0 ? 0.4 : 1.75), 0.33);
      if (d !== null && d < bestD) {
        bestD = d;
        const point = origin.clone().addScaledVector(dir, d);
        best = { kind: 'character', character: c, point, distance: d, head: point.y - c.pos.y > 1.55 };
      }
    }

    for (const v of this.ctx.entities.vehicles) {
      if (v === ignoreVehicle) continue;
      const r = rayVehicle(origin, dir, v);
      if (r && r.distance < bestD) {
        bestD = r.distance;
        best = { kind: 'vehicle', vehicle: v, point: origin.clone().addScaledVector(dir, r.distance), distance: r.distance, normal: r.normal };
      }
    }
    return best;
  }

  /** Fires the shooter's current weapon from `origin` towards `target`. Returns false if it didn't fire. */
  fire(shooter: Character, origin: THREE.Vector3, target: THREE.Vector3, accuracy = 1, damageScale = 1): boolean {
    const inv = shooter.inventory;
    const def = inv.def;
    if (!inv.tryFire()) return false;
    if (def.melee) {
      this.melee(shooter);
      return true;
    }
    const fx = this.ctx.effects;
    const baseDir = tmpA.copy(target).sub(origin).normalize();
    fx.muzzleFlash(origin, baseDir);
    this.ctx.audio.gunshot(def.id, origin);
    this.ctx.events.emit('gunshot', { shooter, x: origin.x, z: origin.z, weapon: def.id, noise: def.noise });

    const spread = def.spread / Math.max(0.2, accuracy);
    for (let i = 0; i < def.pellets; i++) {
      const dir = baseDir.clone();
      dir.x += rand(-spread, spread);
      dir.y += rand(-spread, spread) * 0.7;
      dir.z += rand(-spread, spread);
      dir.normalize();
      const hit = this.raycast(origin, dir, def.range, shooter, shooter.vehicle);
      const end = hit ? hit.point : origin.clone().addScaledVector(dir, def.range);
      if (i < 3) fx.tracer(origin.clone().addScaledVector(dir, 0.6), end);
      if (!hit) continue;
      switch (hit.kind) {
        case 'character': {
          const dmg = def.damage * damageScale * (hit.head ? 2.5 : 1);
          this.damageCharacter(hit.character, dmg, shooter, 'bullet', dir);
          if (!hit.character.alive) hit.character.vel.addScaledVector(dir, 2.5);
          break;
        }
        case 'vehicle': {
          this.damageVehicle(hit.vehicle, def.damage * 2 * damageScale, shooter);
          fx.impact(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.z);
          // Shots through the side windows can hit the driver.
          const drv = hit.vehicle.driver;
          if (drv && hit.point.y > hit.vehicle.spec.belt + 0.05 && Math.random() < 0.6) {
            this.damageCharacter(drv, def.damage * damageScale, shooter, 'bullet', dir);
          }
          break;
        }
        case 'world':
          fx.impact(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.z);
          break;
        case 'ground':
          fx.impact(hit.point.x, hit.point.y + 0.05, hit.point.z, 0, 0);
          break;
      }
    }
    return true;
  }

  melee(attacker: Character) {
    attacker.model.punch();
    const fwdX = Math.sin(attacker.heading);
    const fwdZ = Math.cos(attacker.heading);
    let best: Character | null = null;
    let bestD = WEAPONS.fists.range;
    for (const c of this.ctx.entities.characters) {
      if (c === attacker || !c.alive || c.vehicle) continue;
      const dx = c.pos.x - attacker.pos.x;
      const dz = c.pos.z - attacker.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || d < 0.01) continue;
      if ((dx * fwdX + dz * fwdZ) / d < 0.5) continue;
      best = c;
      bestD = d;
    }
    if (!best) return;
    this.ctx.audio.punch(best.pos);
    const dir = new THREE.Vector3(best.pos.x - attacker.pos.x, 0, best.pos.z - attacker.pos.z).normalize();
    this.damageCharacter(best, WEAPONS.fists.damage * rand(0.8, 1.3), attacker, 'melee', dir);
    best.vel.addScaledVector(dir, 3);
    if (Math.random() < 0.15 && best.alive) best.knock(dir.x * 3, 2, dir.z * 3, 1.2);
    this.ctx.events.emit('gunshot', { shooter: attacker, x: attacker.pos.x, z: attacker.pos.z, weapon: 'fists', noise: WEAPONS.fists.noise });
  }

  explode(x: number, y: number, z: number, by: Character | null) {
    const fx = this.ctx.effects;
    fx.explosion(x, y, z);
    this.ctx.audio.explosion({ x, y, z });
    this.ctx.events.emit('explosion', { x, z, by });
    const radius = 9;
    for (const c of this.ctx.entities.characters) {
      if (c.vehicle) continue;
      const dx = c.pos.x - x;
      const dz = c.pos.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const nx = d > 0.01 ? dx / d : 1;
      const nz = d > 0.01 ? dz / d : 0;
      this.damageCharacter(c, 160 * f, by, 'explosion', new THREE.Vector3(nx, 0, nz));
      c.knock(nx * 12 * f, 6 * f + 2, nz * 12 * f, 2);
    }
    for (const v of this.ctx.entities.vehicles) {
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius || d < 0.01) continue;
      const f = 1 - d / radius;
      this.damageVehicle(v, 600 * f, by);
      v.vx += (dx / d) * 8 * f;
      v.vz += (dz / d) * 8 * f;
      v.angVel += rand(-2, 2) * f;
      if (v.driver) this.damageCharacter(v.driver, 60 * f, by, 'explosion');
    }
  }

  /** Burning cars explode; wrecked/sunk cars kill their occupants. */
  updateVehicles(dt: number) {
    const fx = this.ctx.effects;
    for (const v of this.ctx.entities.vehicles) {
      const frac = v.health / v.spec.health;
      const frontX = v.pos.x + Math.sin(v.heading) * v.spec.length * 0.35;
      const frontZ = v.pos.z + Math.cos(v.heading) * v.spec.length * 0.35;
      if (v.state === 'ok' && frac < 0.35 && Math.random() < dt * (frac < 0.2 ? 14 : 6)) {
        fx.smokePuff(frontX, v.spec.belt, frontZ, frac < 0.2 ? 0.6 : 0.1, 0.6);
      }
      if (v.state === 'burning') {
        if (Math.random() < dt * 30) fx.fire(frontX, v.spec.belt, frontZ, 0.8);
        if (Math.random() < dt * 10) fx.smokePuff(frontX, v.spec.belt + 0.5, frontZ, 0.8, 0.8);
        if (v.burnTime > 4.5) {
          v.state = 'wrecked';
          v.wreckTime = 0;
          v.model.setWrecked();
          v.vy = 5;
          v.pos.y = 0.01;
          this.explode(v.pos.x, 0.8, v.pos.z, v.lastDamager);
          if (v.driver) this.damageCharacter(v.driver, 1000, v.lastDamager, 'explosion');
          this.ctx.events.emit('vehicleDestroyed', { vehicle: v, by: v.lastDamager });
        }
      }
      if (v.state === 'wrecked' && v.wreckTime < 8 && Math.random() < dt * 8) {
        fx.smokePuff(v.pos.x, 1, v.pos.z, 0.9, 1);
        if (v.wreckTime < 5) fx.fire(v.pos.x, 0.8, v.pos.z, 1.2);
      }
      if (v.state === 'sinking' && v.sinkTime < dt * 1.5) {
        fx.splash(v.pos.x, v.pos.z);
        this.ctx.audio.splash(v.pos);
      }
    }
  }
}

/** Ray vs vertical capsule (approximated as a cylinder with caps). Returns distance or null. */
function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, cx: number, cz: number, y0: number, y1: number, r: number): number | null {
  const fx = o.x - cx;
  const fz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return null;
  const b = fx * d.x + fz * d.z;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0) return null;
  const y = o.y + d.y * t;
  return y >= y0 && y <= y1 ? t : null;
}

/** Ray vs the vehicle's oriented bounding box. */
function rayVehicle(o: THREE.Vector3, d: THREE.Vector3, v: Vehicle): { distance: number; normal: THREE.Vector3 } | null {
  const s = Math.sin(v.heading);
  const c = Math.cos(v.heading);
  // To local frame: forward (s, c) -> +z, right (-c, s)... use x' = right component inverted to match model (+x = left).
  const ox = o.x - v.pos.x;
  const oz = o.z - v.pos.z;
  const lo = { x: ox * c - oz * s, y: o.y - v.pos.y, z: ox * s + oz * c };
  const ld = { x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c };
  const hx = v.spec.width / 2;
  const hz = v.spec.length / 2;
  const min = [-hx, 0.25, -hz];
  const max = [hx, v.spec.height, hz];
  const oo = [lo.x, lo.y, lo.z];
  const dd = [ld.x, ld.y, ld.z];
  let tmin = 0;
  let tmax = Infinity;
  let axis = -1;
  let sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-9) {
      if (oo[i] < min[i] || oo[i] > max[i]) return null;
      continue;
    }
    let t1 = (min[i] - oo[i]) / dd[i];
    let t2 = (max[i] - oo[i]) / dd[i];
    let sg = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sg = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = sg;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null; // origin inside the box
  const ln = [0, 0, 0];
  ln[axis] = sign;
  // Back to world: inverse rotation.
  const nx = ln[0] * c + ln[2] * s;
  const nz = -ln[0] * s + ln[2] * c;
  return { distance: tmin, normal: new THREE.Vector3(nx, ln[1], nz) };
}
