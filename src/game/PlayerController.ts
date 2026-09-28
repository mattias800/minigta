import * as THREE from 'three';
import { bailOut } from '../ai/DriverBrain';
import { PedBrain } from '../ai/PedBrain';
import { clamp } from '../core/math';
import type { Input } from '../core/Input';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import type { CameraRig } from './CameraRig';
import type { GameContext } from './GameContext';
import { WEAPON_ORDER } from './weapons';

const tmpO = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpMuzzle = new THREE.Vector3();

/** Translates player input into character/vehicle actions. */
export class PlayerController {
  /** Short text shown by the HUD (e.g. "Press F to steal"). */
  hint: string | null = null;
  private hornCooldown = 0;
  onRadioNext: (() => void) | null = null;

  constructor(
    private readonly ctx: GameContext,
    private readonly input: Input,
    private readonly rig: CameraRig,
  ) {}

  get player(): Character {
    return this.ctx.player;
  }

  update(dt: number) {
    const p = this.player;
    this.hint = null;
    this.hornCooldown -= dt;
    if (!p.alive) {
      p.moveX = p.moveZ = 0;
      p.aiming = false;
      return;
    }
    if (p.vehicle) this.drive(p.vehicle);
    else this.onFoot();
  }

  private onFoot() {
    const p = this.player;
    const input = this.input;
    const fx = this.rig.forwardX;
    const fz = this.rig.forwardZ;
    // Right of forward (fx, fz) is (-fz, fx).
    const f = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const r = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    p.moveX = fx * f - fz * r;
    p.moveZ = fz * f + fx * r;
    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    p.aiming = input.isMouseDown(2) || (input.isMouseDown(0) && !p.inventory.def.melee);
    p.moveSpeed = p.aiming ? 2.6 : sprint ? 7.2 : 4.6;
    if (input.wasPressed('Space')) p.wantJump = true;

    // Weapons.
    if (input.wheel) p.inventory.cycle(input.wheel > 0 ? 1 : -1);
    WEAPON_ORDER.forEach((w, i) => {
      if (input.wasPressed(`Digit${i + 1}`)) p.inventory.select(w);
    });
    if (input.wasPressed('KeyR')) p.inventory.reload();

    this.rig.aimRay(tmpO, tmpD);
    p.faceHeading = p.aiming || input.isMouseDown(0) ? Math.atan2(tmpD.x, tmpD.z) : null;
    p.aimPitch = Math.asin(clamp(tmpD.y, -1, 1));

    const def = p.inventory.def;
    const wantsFire = def.automatic ? input.isMouseDown(0) : input.wasMousePressed(0);
    if (p.aiming || wantsFire) {
      // Find what the crosshair points at (skip the part of the ray behind the player).
      const skip = tmpO.distanceTo(p.chest(tmpMuzzle)) * 0.9;
      tmpO.addScaledVector(tmpD, skip);
      const hit = this.ctx.combat.raycast(tmpO, tmpD, def.range + 10, p);
      const target = hit ? hit.point.clone() : tmpO.clone().addScaledVector(tmpD, def.range);
      // Scare pedestrians we aim at.
      if (hit?.kind === 'character' && hit.character.role === 'civilian') {
        const b = this.ctx.entities.brainOf(hit.character);
        if (b instanceof PedBrain && !b.fleeing) b.flee(p.pos.x, p.pos.z);
      }
      if (wantsFire) {
        const h = p.heading;
        const muzzle = tmpMuzzle.set(p.pos.x + Math.sin(h) * 0.55 - Math.cos(h) * 0.28, p.pos.y + 1.38, p.pos.z + Math.cos(h) * 0.55 + Math.sin(h) * 0.28);
        if (!p.swimming) this.ctx.combat.fire(p, muzzle, target);
      }
    }

    // Enter vehicles.
    const car = this.nearestEnterable();
    if (car) this.hint = car.driver ? 'F: hijack' : 'F: enter vehicle';
    if (input.wasPressed('KeyF') && car) this.enter(car);
  }

  private nearestEnterable(): Vehicle | null {
    const p = this.player;
    let best: Vehicle | null = null;
    let bestD = 3.6;
    for (const v of this.ctx.entities.vehicles) {
      if (!v.alive || v.state !== 'ok' || v.kinematic) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) - v.spec.width / 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  private enter(v: Vehicle) {
    const ctx = this.ctx;
    const p = this.player;
    const victim = v.driver;
    if (victim) {
      bailOut(ctx, victim, v, true);
      // Thrown out on the pavement.
      victim.knock(Math.cos(v.heading) * 3, 2, -Math.sin(v.heading) * 3, 1.2);
      ctx.events.emit('carjack', { vehicle: v, thief: p, victim });
      ctx.audio.punch(v.pos);
    }
    p.vehicle = v;
    v.driver = p;
    v.stolen = true;
    v.sirenOn = false;
    p.aiming = false;
    p.moveX = p.moveZ = 0;
    this.rig.snapBehind(this.rig.yaw);
  }

  private exit(v: Vehicle) {
    const p = this.player;
    const col = this.ctx.world.collision;
    let spot = v.doorPosition(1);
    if (col.circleHit(spot.x, spot.z, 0.35)) {
      const other = v.doorPosition(-1);
      if (!col.circleHit(other.x, other.z, 0.35)) spot = other;
    }
    v.driver = null;
    v.controls.throttle = 0;
    v.controls.steer = 0;
    v.controls.handbrake = true;
    p.vehicle = null;
    p.pos.set(spot.x, 0, spot.z);
    p.heading = v.heading;
    const speed = v.speed;
    if (speed > 8) {
      // Bailing out of a moving car hurts.
      p.knock(v.vx * 0.6, 2, v.vz * 0.6, 1.2);
      this.ctx.combat.damageCharacter(p, speed * 0.8, null, 'other');
    } else {
      p.vel.set(0, 0, 0);
    }
    this.ctx.audio.setEngine(false);
  }

  private drive(v: Vehicle) {
    const input = this.input;
    const c = v.controls;
    c.throttle = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    c.steer = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    c.handbrake = input.isDown('Space');
    if (input.wasPressed('KeyH') && this.hornCooldown <= 0) {
      this.ctx.audio.horn(v.pos, 0.4);
      this.hornCooldown = 0.45;
      // Honking makes pedestrians in front jump.
      for (const ch of this.ctx.entities.charactersNear(v.pos.x, v.pos.z, 12)) {
        const b = this.ctx.entities.brainOf(ch);
        if (b instanceof PedBrain && !b.fleeing && Math.random() < 0.5) b.flee(v.pos.x, v.pos.z, 2.5);
      }
    }
    if (input.wasPressed('KeyQ')) this.onRadioNext?.();
    if (v.spec.type === 'police' && input.wasPressed('KeyG')) v.sirenOn = !v.sirenOn;
    this.ctx.audio.setEngine(v.state === 'ok' || v.state === 'burning', v.forwardSpeed, c.throttle, v.spec.maxSpeed);
    if (input.wasPressed('KeyF') || (v.state === 'sinking' && v.sinkTime > 1)) this.exit(v);
    if (v.state === 'burning' && v.burnTime > 1.5) this.hint = 'The car is on fire! Get out! (F)';
  }
}
