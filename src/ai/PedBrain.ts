import * as THREE from 'three';
import { angleDiff, chance, clamp, rand } from '../core/math';
import type { Character } from '../entities/Character';
import type { Brain } from '../game/Entities';
import type { GameContext } from '../game/GameContext';
import type { RoadEdge, RoadNode } from '../world/RoadNetwork';

type State = 'wander' | 'idle' | 'flee' | 'fight';

const SIDEWALK_MARGIN = 1.3;
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Walkable offset from an edge's center line: sidewalks beside roads, the middle of footpaths. */
function walkOffset(e: RoadEdge): number {
  if (e.drivable) return e.width / 2 + (e.kind === 'service' ? 0.6 : SIDEWALK_MARGIN);
  return 0;
}

/**
 * Pedestrian behaviour: strolls along sidewalks and footpaths, occasionally stops, flees from danger
 * and sometimes fights back when attacked.
 */
export class PedBrain implements Brain {
  readonly kind: string = 'ped';
  protected state: State = 'wander';
  private edge: RoadEdge | null = null;
  private forward = true;
  private side: 1 | -1 = chance(0.5) ? 1 : -1;
  private readonly jitter = rand(-0.4, 0.4);
  private timer = rand(5, 30);
  private fleeX = 0;
  private fleeZ = 0;
  private fleeDir = 0;
  private fightTarget: Character | null = null;
  private readonly walkSpeed = rand(1.2, 1.7);
  /** Chance to fight back when attacked. */
  protected bravery = rand(0, 1);

  constructor(protected readonly me: Character) {
    me.moveSpeed = this.walkSpeed;
  }

  get fleeing(): boolean {
    return this.state === 'flee';
  }

  flee(fromX: number, fromZ: number, seconds = rand(6, 12)) {
    if (this.state === 'fight') return;
    this.state = 'flee';
    this.fleeX = fromX;
    this.fleeZ = fromZ;
    this.timer = seconds;
    this.fleeDir = Math.atan2(this.me.pos.x - fromX, this.me.pos.z - fromZ);
  }

  /** Called when attacked: fight back or flee. */
  attacked(by: Character | null) {
    if (by && by !== this.me && this.bravery > 0.72 && this.me.health > 40) {
      this.state = 'fight';
      this.fightTarget = by;
      this.timer = 12;
      return;
    }
    const from = by ? by.pos : this.me.pos;
    this.state = 'wander';
    this.flee(from.x, from.z, rand(10, 16));
  }

  update(dt: number, ctx: GameContext) {
    const me = this.me;
    me.faceHeading = null;
    me.aiming = false;
    if (!me.canAct) {
      me.moveX = me.moveZ = 0;
      return;
    }
    this.timer -= dt;
    switch (this.state) {
      case 'wander':
        this.wander(ctx);
        if (this.timer <= 0) {
          this.state = 'idle';
          this.timer = rand(1.5, 5);
        }
        break;
      case 'idle':
        me.moveX = me.moveZ = 0;
        if (this.timer <= 0) {
          this.state = 'wander';
          this.timer = rand(10, 40);
        }
        break;
      case 'flee':
        this.doFlee(ctx);
        if (this.timer <= 0) {
          this.state = 'wander';
          this.edge = null;
          this.timer = rand(10, 30);
        }
        break;
      case 'fight':
        this.doFight(ctx);
        break;
    }
    this.avoidTraffic(ctx);
  }

  private wander(ctx: GameContext) {
    const me = this.me;
    me.moveSpeed = this.walkSpeed;
    const net = ctx.world.roads;
    if (!this.edge || !this.edge.a.edges.includes(this.edge)) {
      const q = net.nearestEdge(me.pos.x, me.pos.z, 40, (e) => e.kind !== 'motorway');
      if (!q) {
        me.moveX = me.moveZ = 0;
        return;
      }
      this.edge = q.edge;
      this.forward = chance(0.5);
    }
    const e = this.edge;
    const from: RoadNode = this.forward ? e.a : e.b;
    const to: RoadNode = this.forward ? e.b : e.a;
    const dx = (to.x - from.x) / e.length;
    const dz = (to.z - from.z) / e.length;
    const along = clamp((me.pos.x - from.x) * dx + (me.pos.z - from.z) * dz, 0, e.length);
    if (along > e.length - 1.2) {
      this.nextEdge(to);
      return;
    }
    const s = Math.min(e.length, along + 2.5);
    // Side is relative to the edge's a→b direction so a ped stays on one side of the street.
    const off = (walkOffset(e) + this.jitter) * this.side * (this.forward ? 1 : -1);
    const tx = from.x + dx * s - dz * off;
    const tz = from.z + dz * s + dx * off;
    const mx = tx - me.pos.x;
    const mz = tz - me.pos.z;
    const len = Math.hypot(mx, mz) || 1;
    me.moveX = mx / len;
    me.moveZ = mz / len;
  }

  private nextEdge(node: RoadNode) {
    const options = node.edges.filter((x) => x !== this.edge && x.kind !== 'motorway');
    if (!options.length) {
      this.forward = !this.forward;
      return;
    }
    // Prefer continuing roughly straight.
    const cur = this.edge!;
    const inH = Math.atan2(this.forward ? cur.dx : -cur.dx, this.forward ? cur.dz : -cur.dz);
    let best = options[0];
    let bestScore = -Infinity;
    for (const o of options) {
      const fwd = o.a === node;
      const h = Math.atan2(fwd ? o.dx : -o.dx, fwd ? o.dz : -o.dz);
      const score = Math.cos(angleDiff(inH, h)) + Math.random() * 1.6;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    const wasDrivable = cur.drivable;
    this.edge = best;
    this.forward = best.a === node;
    // Occasionally cross the street when continuing along roads.
    if (wasDrivable && best.drivable && chance(0.15)) this.side = this.side === 1 ? -1 : 1;
  }

  private doFlee(ctx: GameContext) {
    const me = this.me;
    me.moveSpeed = 5.2;
    // Steer away from the threat, sliding around walls.
    const away = Math.atan2(me.pos.x - this.fleeX, me.pos.z - this.fleeZ);
    this.fleeDir += angleDiff(this.fleeDir, away) * 0.05;
    const col = ctx.world.collision;
    let dir = this.fleeDir;
    for (const offset of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
      const a = this.fleeDir + offset;
      if (!col.raycast(me.pos.x, me.pos.z, Math.sin(a), Math.cos(a), 3, 1)) {
        dir = a;
        break;
      }
    }
    this.fleeDir = dir;
    me.moveX = Math.sin(dir);
    me.moveZ = Math.cos(dir);
  }

  private doFight(ctx: GameContext) {
    const me = this.me;
    const t = this.fightTarget;
    if (!t || !t.alive || this.timer <= 0 || me.pos.distanceTo(t.pos) > 25 || t.vehicle) {
      this.state = 'wander';
      this.fightTarget = null;
      this.edge = null;
      return;
    }
    me.moveSpeed = 4.5;
    const dx = t.pos.x - me.pos.x;
    const dz = t.pos.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    me.faceHeading = Math.atan2(dx, dz);
    if (d > 1.1) {
      me.moveX = dx / d;
      me.moveZ = dz / d;
    } else {
      me.moveX = me.moveZ = 0;
      if (Math.abs(angleDiff(me.heading, me.faceHeading)) < 0.4) {
        ctx.combat.fire(me, me.chest(tmpA), t.chest(tmpB));
      }
    }
  }

  /** Jump out of the way of fast cars heading at us. */
  private avoidTraffic(ctx: GameContext) {
    const me = this.me;
    for (const v of ctx.entities.vehicles) {
      const sp = v.speed;
      if (sp < 6) continue;
      const rx = me.pos.x - v.pos.x;
      const rz = me.pos.z - v.pos.z;
      const d = Math.hypot(rx, rz);
      if (d > 14 || d < 0.01) continue;
      const vxn = v.vx / sp;
      const vzn = v.vz / sp;
      const ahead = rx * vxn + rz * vzn;
      const lateral = rx * -vzn + rz * vxn;
      if (ahead > 0 && Math.abs(lateral) < 2.2 && chance(0.5)) {
        const side = lateral >= 0 ? 1 : -1;
        me.moveX = -vzn * side;
        me.moveZ = vxn * side;
        me.moveSpeed = 6;
        if (this.state !== 'flee' && this.state !== 'fight') this.flee(v.pos.x, v.pos.z, rand(2, 4));
      }
    }
  }
}
