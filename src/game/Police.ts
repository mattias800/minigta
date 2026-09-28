import * as THREE from 'three';
import { CopDriverBrain } from '../ai/CopDriverBrain';
import { CopBrain } from '../ai/CopBrain';
import type { Character } from '../entities/Character';
import type { GameContext } from './GameContext';
import { createCop, createVehicle, lanePose } from './spawn';

/** Heat needed for each wanted star (index = stars). */
const THRESHOLDS = [0, 40, 180, 420, 800, 1400];
/** Police cars dispatched per wanted level. */
const CARS_FOR_STARS = [0, 1, 2, 3, 5, 7];

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/**
 * Wanted level ("heat") and police response. Crimes add heat; heat maps to 0–5 stars. Out of sight of
 * the police for long enough, the level drops one star at a time. Also detects arrests ("busted").
 */
export class Police {
  heat = 0;
  /** Seconds since any officer last saw the player. */
  unseenTime = 0;
  /** True while cops currently see the player (HUD shows solid vs flashing stars). */
  seen = false;
  private spawnCooldown = 0;
  private bustTime = 0;
  private seenTimer = 0;
  onBusted: (() => void) | null = null;
  onStarsChanged: ((stars: number, previous: number) => void) | null = null;
  private lastStars = 0;

  constructor(private readonly ctx: GameContext) {
    const ev = ctx.events;
    ev.on('gunshot', (e) => {
      if (e.shooter !== ctx.player || e.weapon === 'fists') return;
      if (this.copsNear(e.x, e.z, 50).length) this.atLeast(1);
      else this.add(4);
    });
    ev.on('injure', (e) => {
      if (e.attacker !== ctx.player) return;
      if (e.victim.role === 'cop') {
        this.atLeast(1);
        this.add(40);
      } else this.add(12);
    });
    ev.on('death', (e) => {
      if (e.killer !== ctx.player) return;
      if (e.victim.role === 'cop') {
        this.atLeast(2);
        this.add(140);
      } else {
        this.atLeast(1);
        this.add(55);
      }
    });
    ev.on('carjack', (e) => {
      if (e.thief !== ctx.player) return;
      if (this.copsNear(e.vehicle.pos.x, e.vehicle.pos.z, 40).length || e.vehicle.spec.type === 'police') this.atLeast(1);
      else this.add(10);
    });
    ev.on('vehicleDestroyed', (e) => {
      if (e.by === ctx.player) this.add(e.vehicle.spec.type === 'police' ? 120 : 45);
    });
  }

  get stars(): number {
    let s = 0;
    for (let i = 1; i < THRESHOLDS.length; i++) if (this.heat >= THRESHOLDS[i]) s = i;
    return s;
  }

  add(amount: number) {
    this.heat = Math.min(THRESHOLDS[5] + 200, this.heat + amount);
    this.unseenTime = 0;
  }

  atLeast(stars: number) {
    this.heat = Math.max(this.heat, THRESHOLDS[stars]);
    this.unseenTime = 0;
  }

  clear() {
    this.heat = 0;
    this.unseenTime = 0;
    this.bustTime = 0;
    this.check();
  }

  private copsNear(x: number, z: number, r: number): Character[] {
    return this.ctx.entities.charactersNear(x, z, r, (c) => c.role === 'cop' && c.alive);
  }

  update(dt: number) {
    const ctx = this.ctx;
    const player = ctx.player;
    const stars = this.stars;
    this.spawnCooldown -= dt;

    if (stars > 0 && player.alive) {
      // Visibility: any officer (on foot or driving) with line of sight within range.
      this.seenTimer -= dt;
      if (this.seenTimer <= 0) {
        this.seenTimer = 0.4;
        this.seen = this.anyCopSees();
      }
      if (this.seen) this.unseenTime = 0;
      else this.unseenTime += dt;
      const escapeTime = 10 + stars * 4;
      if (this.unseenTime > escapeTime) {
        this.heat = THRESHOLDS[stars - 1] > 0 ? THRESHOLDS[stars - 1] : 0;
        this.unseenTime = 0;
      }
      this.dispatch(stars);
      this.checkBust(dt, stars);
    } else {
      this.seen = false;
      this.bustTime = 0;
    }
    this.check();
  }

  private check() {
    const s = this.stars;
    if (s !== this.lastStars) {
      const prev = this.lastStars;
      this.lastStars = s;
      this.onStarsChanged?.(s, prev);
    }
  }

  private anyCopSees(): boolean {
    const ctx = this.ctx;
    const p = ctx.player;
    const target = p.chest(tmpB);
    for (const c of ctx.entities.characters) {
      if (c.role !== 'cop' || !c.alive) continue;
      const src = c.vehicle ? c.vehicle.pos : c.pos;
      const d = Math.hypot(src.x - target.x, src.z - target.z);
      if (d < 12) return true;
      if (d > 65) continue;
      const eye = c.vehicle ? tmpA.set(src.x, 1.3, src.z) : c.chest(tmpA);
      if (ctx.world.collision.lineOfSight(eye.x, eye.y, eye.z, target.x, target.y, target.z)) return true;
    }
    return false;
  }

  private dispatch(stars: number) {
    const ctx = this.ctx;
    if (this.spawnCooldown > 0) return;
    const pursuing = ctx.entities.characters.filter((c) => c.role === 'cop' && c.alive && ctx.entities.brainOf(c)?.kind === 'copDriver').length;
    if (pursuing >= CARS_FOR_STARS[stars]) return;
    const p = ctx.player.vehicle ? ctx.player.vehicle.pos : ctx.player.pos;
    const edge = ctx.world.roads.randomEdgeInRing(p.x, p.z, 90, 170, (e) => e.drivable && e.kind !== 'service' && e.length > 8);
    if (!edge) return;
    const forward = Math.random() < 0.5 || edge.oneway;
    const pose = lanePose(edge, forward, 0.5);
    if (ctx.entities.vehiclesNear(pose.x, pose.z, 7).length) return;
    const car = createVehicle('police');
    car.pos.set(pose.x, 0, pose.z);
    car.heading = pose.heading;
    car.sirenOn = true;
    ctx.entities.addVehicle(car);
    const cop = createCop();
    cop.vehicle = car;
    car.driver = cop;
    cop.pos.copy(car.pos);
    ctx.entities.addCharacter(cop, new CopDriverBrain(cop));
    this.spawnCooldown = 4 - stars * 0.5;
  }

  private checkBust(dt: number, stars: number) {
    const ctx = this.ctx;
    const p = ctx.player;
    let close = false;
    if (!p.vehicle && stars <= 2) {
      close = this.copsNear(p.pos.x, p.pos.z, 1.6).some((c) => !c.vehicle && c.canAct && ctx.entities.brainOf(c) instanceof CopBrain);
    } else if (p.vehicle && stars <= 3 && p.vehicle.speed < 1) {
      const v = p.vehicle;
      close = this.copsNear(v.pos.x, v.pos.z, v.spec.width / 2 + 1.8).some((c) => !c.vehicle && c.canAct);
    }
    this.bustTime = close ? this.bustTime + dt : 0;
    if (this.bustTime > (p.vehicle ? 1.6 : 1.1)) {
      this.bustTime = 0;
      this.onBusted?.();
    }
  }
}
