import * as THREE from 'three';
import { clamp } from '../core/math';
import type { Vehicle } from '../entities/Vehicle';
import type { Combat } from './Combat';
import type { GameContext } from './GameContext';

const tmp = new THREE.Vector3();

/** Dynamic-vs-dynamic collisions: car/car, car/person and person/person. */
export function resolveInteractions(ctx: GameContext, combat: Combat) {
  const { vehicles, characters } = ctx.entities;

  // Vehicle vs vehicle (circle chains).
  for (let i = 0; i < vehicles.length; i++) {
    const a = vehicles[i];
    for (let j = i + 1; j < vehicles.length; j++) {
      const b = vehicles[j];
      const reach = (a.spec.length + b.spec.length) / 2 + 0.5;
      if (Math.abs(a.pos.x - b.pos.x) > reach || Math.abs(a.pos.z - b.pos.z) > reach) continue;
      collideVehicles(ctx, combat, a, b);
    }
  }

  // Vehicle vs character.
  for (const v of vehicles) {
    const speed = v.speed;
    for (const c of characters) {
      if (c.vehicle) continue;
      const reach = v.spec.length / 2 + 1;
      if (Math.abs(c.pos.x - v.pos.x) > reach || Math.abs(c.pos.z - v.pos.z) > reach) continue;
      if (c.pos.y > v.spec.height + 0.2) continue;
      for (const circle of v.circles()) {
        const dx = c.pos.x - circle.x;
        const dz = c.pos.z - circle.z;
        const d = Math.hypot(dx, dz);
        const rr = circle.r + c.radius;
        if (d >= rr || d < 1e-4) continue;
        const nx = dx / d;
        const nz = dz / d;
        const approach = v.vx * nx + v.vz * nz;
        if (c.alive && speed > 4 && approach > 2.5) {
          // Run over / knocked flying.
          const dmg = (approach - 2.5) * 7.5;
          c.knock(v.vx * 1.05 + nx * 2, clamp(approach * 0.35, 2, 7), v.vz * 1.05 + nz * 2, 1.8);
          c.pos.x = circle.x + nx * (rr + 0.05);
          c.pos.z = circle.z + nz * (rr + 0.05);
          combat.damageCharacter(c, dmg, v.driver, 'vehicle', tmp.set(nx, 0, nz));
          ctx.audio.impact(c.pos, clamp(approach / 20, 0.2, 0.8));
          v.vx *= 0.93;
          v.vz *= 0.93;
          combat.damageVehicle(v, dmg * 0.1, null);
        } else {
          // Slow contact: just push the person out of the way.
          c.pos.x = circle.x + nx * rr;
          c.pos.z = circle.z + nz * rr;
          if (approach > 0) {
            c.vel.x += nx * approach;
            c.vel.z += nz * approach;
          }
        }
        break;
      }
    }
  }

  // Character vs character: soft separation.
  for (let i = 0; i < characters.length; i++) {
    const a = characters[i];
    if (a.vehicle || !a.alive) continue;
    for (let j = i + 1; j < characters.length; j++) {
      const b = characters[j];
      if (b.vehicle || !b.alive) continue;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const rr = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (rr - d) / 2;
      a.pos.x -= (dx / d) * push;
      a.pos.z -= (dz / d) * push;
      b.pos.x += (dx / d) * push;
      b.pos.z += (dz / d) * push;
    }
  }
}

function collideVehicles(ctx: GameContext, combat: Combat, a: Vehicle, b: Vehicle) {
  const ca = a.circles();
  const cb = b.circles();
  for (const p of ca) {
    for (const q of cb) {
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      const rr = p.r + q.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      const pen = rr - d;
      if (a.kinematic && b.kinematic) return;
      const ma = a.kinematic ? 1e9 : a.alive ? a.spec.mass : a.spec.mass * 1.5;
      const mb = b.kinematic ? 1e9 : b.alive ? b.spec.mass : b.spec.mass * 1.5;
      const wa = mb / (ma + mb);
      const wb = ma / (ma + mb);
      a.pos.x += nx * pen * wa;
      a.pos.z += nz * pen * wa;
      b.pos.x -= nx * pen * wb;
      b.pos.z -= nz * pen * wb;
      const vrel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (vrel >= 0) continue;
      const e = 0.3;
      const j = (-(1 + e) * vrel) / (1 / ma + 1 / mb);
      a.vx += (j / ma) * nx;
      a.vz += (j / ma) * nz;
      b.vx -= (j / mb) * nx;
      b.vz -= (j / mb) * nz;
      // Spin from off-center contact.
      if (!a.kinematic) a.angVel += clamp(p.offset * -vrel * 0.03, -2, 2) * (Math.random() < 0.5 ? -1 : 1);
      if (!b.kinematic) b.angVel += clamp(q.offset * -vrel * 0.03, -2, 2) * (Math.random() < 0.5 ? -1 : 1);
      const impact = -vrel;
      if (impact > 3) {
        const dmg = impact * impact * 0.9;
        combat.damageVehicle(a, dmg * wa * 2, b.driver);
        combat.damageVehicle(b, dmg * wb * 2, a.driver);
        ctx.audio.impact({ x: (p.x + q.x) / 2, y: 0.6, z: (p.z + q.z) / 2 }, impact / 18);
        ctx.effects.impact((p.x + q.x) / 2, 0.7, (p.z + q.z) / 2, nx, nz);
        if (impact > 12) ctx.effects.shake = Math.max(ctx.effects.shake, 0.4);
        for (const [v, other] of [
          [a, b],
          [b, a],
        ] as const) {
          if (v.driver && impact > 14) combat.damageCharacter(v.driver, (impact - 14) * 2, other.driver, 'vehicle');
        }
      }
      return;
    }
  }
}

/** Handles static-collision impacts reported by vehicles (damage + sound). */
export function processVehicleImpacts(ctx: GameContext, combat: Combat, v: Vehicle) {
  for (const imp of v.impacts) {
    if (imp.speed > 3) {
      combat.damageVehicle(v, imp.speed * imp.speed * 0.8, null);
      ctx.audio.impact({ x: imp.x, y: 0.6, z: imp.z }, imp.speed / 18);
      if (imp.speed > 8) ctx.effects.impact(imp.x, 0.7, imp.z, 0, 0);
      if (imp.speed > 10 && v.driver === ctx.player) ctx.effects.shake = Math.max(ctx.effects.shake, imp.speed / 30);
      if (v.driver && imp.speed > 16) combat.damageCharacter(v.driver, (imp.speed - 16) * 2, null, 'vehicle');
    }
  }
}
