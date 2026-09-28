import { angleDiff, clamp } from '../core/math';
import type { Vehicle } from '../entities/Vehicle';
import type { GameContext } from '../game/GameContext';

/** Sets throttle/steer so the vehicle heads to (tx, tz) at roughly `desiredSpeed`. */
export function steerTowards(v: Vehicle, tx: number, tz: number, desiredSpeed: number) {
  const want = Math.atan2(tx - v.pos.x, tz - v.pos.z);
  const diff = angleDiff(v.heading, want);
  const vF = v.forwardSpeed;
  const reversing = vF < -0.5;
  // diff > 0 means the target is to the left (heading must increase), i.e. negative (left) steer.
  v.controls.steer = clamp(-diff * 2.2, -1, 1) * (reversing ? -1 : 1);
  const speed = vF;
  if (speed < desiredSpeed - 0.5) v.controls.throttle = clamp((desiredSpeed - speed) * 0.4, 0.25, 1);
  else if (speed > desiredSpeed + 1) v.controls.throttle = -clamp((speed - desiredSpeed) * 0.25, 0.15, 1);
  else v.controls.throttle = 0.05;
  v.controls.handbrake = false;
}

/**
 * Looks for vehicles and people in the path ahead and returns the max safe speed (Infinity if clear),
 * plus what's blocking.
 */
export function obstacleAhead(ctx: GameContext, v: Vehicle, range: number, laneHalfWidth = 1.6): { maxSpeed: number; blockerIsPlayer: boolean } {
  const s = Math.sin(v.heading);
  const c = Math.cos(v.heading);
  let maxSpeed = Infinity;
  let blockerIsPlayer = false;
  const front = v.spec.length / 2;
  const check = (x: number, z: number, halfWidth: number, isPlayer: boolean, otherSpeedAlong: number) => {
    const rx = x - v.pos.x;
    const rz = z - v.pos.z;
    const f = rx * s + rz * c - front;
    if (f < -1 || f > range) return;
    const l = Math.abs(rx * -c + rz * s);
    if (l > laneHalfWidth + halfWidth) return;
    // Keep a gap of ~4 m; allow following at the leader's speed.
    const safe = Math.max(0, (f - 4) * 0.9) + Math.max(0, otherSpeedAlong);
    if (safe < maxSpeed) {
      maxSpeed = safe;
      blockerIsPlayer = isPlayer;
    }
  };
  for (const o of ctx.entities.vehicles) {
    if (o === v) continue;
    if (Math.abs(o.pos.x - v.pos.x) > range + 6 || Math.abs(o.pos.z - v.pos.z) > range + 6 || Math.abs(o.pos.y - v.pos.y) > 3) continue;
    const along = o.vx * s + o.vz * c;
    check(o.pos.x, o.pos.z, o.spec.width / 2, o.driver === ctx.player, along);
  }
  for (const ch of ctx.entities.characters) {
    if (ch.vehicle || !ch.alive) continue;
    if (Math.abs(ch.pos.x - v.pos.x) > range + 2 || Math.abs(ch.pos.z - v.pos.z) > range + 2 || Math.abs(ch.pos.y - v.pos.y) > 3) continue;
    check(ch.pos.x, ch.pos.z, 0.5, ch === ctx.player, 0);
  }
  return { maxSpeed, blockerIsPlayer };
}
