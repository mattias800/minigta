import { angleDiff, rand } from '../core/math';
import type { Vehicle } from '../entities/Vehicle';
import type { RoadEdge, RoadNode } from '../world/RoadNetwork';
import type { GameContext } from './GameContext';
import { createVehicle } from './spawn';

const SECTIONS = 3;
const SECTION_GAP = 0.5;
const CRUISE = 11;
const MAX_TRAMS = 3;
const TRAM_COLORS = ['#1f5fae', '#1f5fae', '#2d8bd2'];

interface Tram {
  sections: Vehicle[];
  edge: RoadEdge;
  forward: boolean;
  /** Distance travelled along the current edge. */
  s: number;
  speed: number;
  /** Recent front positions (newest first), so trailing sections follow the track. */
  trail: { x: number; z: number }[];
  bellCooldown: number;
  stopped: number;
}

/**
 * Gothenburg trams running on the real OSM tram tracks. Trams are chains of kinematic sections that
 * follow a breadcrumb trail of the lead section, brake for obstacles and ring their bell.
 */
export class Trams {
  private readonly trams: Tram[] = [];
  private spawnTimer = 1;

  constructor(private readonly ctx: GameContext) {}

  update(dt: number) {
    const ctx = this.ctx;
    const focus = ctx.player.vehicle ? ctx.player.vehicle.pos : ctx.player.pos;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 3;
      if (this.trams.length < MAX_TRAMS) this.spawn(focus.x, focus.z);
    }
    for (const t of [...this.trams]) {
      const lead = t.sections[0];
      const far = Math.hypot(lead.pos.x - focus.x, lead.pos.z - focus.z) > 320;
      if (far || !this.edgeValid(t.edge)) {
        this.remove(t);
        continue;
      }
      this.drive(t, dt);
    }
  }

  private edgeValid(e: RoadEdge): boolean {
    return this.ctx.world.tramTracks.nodes.get(e.a.id) === e.a && e.a.edges.includes(e);
  }

  private spawn(x: number, z: number) {
    const net = this.ctx.world.tramTracks;
    const edge = net.randomEdgeInRing(x, z, 90, 260, (e) => e.length > 3);
    if (!edge) return;
    for (const t of this.trams) if (Math.hypot(t.sections[0].pos.x - edge.a.x, t.sections[0].pos.z - edge.a.z) < 60) return;
    const forward = Math.random() < 0.5;
    const from = forward ? edge.a : edge.b;
    const dx = forward ? edge.dx : -edge.dx;
    const dz = forward ? edge.dz : -edge.dz;
    const s = edge.length * 0.5;
    const fx = from.x + dx * s;
    const fz = from.z + dz * s;
    const totalLen = SECTIONS * (9.6 + SECTION_GAP) + 5;
    // Initial trail: straight back along the track direction.
    const trail: { x: number; z: number }[] = [];
    for (let d = 0; d <= totalLen; d += 1) trail.push({ x: fx - dx * d, z: fz - dz * d });
    const color = TRAM_COLORS[Math.floor(Math.random() * TRAM_COLORS.length)];
    const sections: Vehicle[] = [];
    for (let i = 0; i < SECTIONS; i++) {
      const v = createVehicle('tram', color);
      v.kinematic = true;
      v.persistent = true;
      this.ctx.entities.addVehicle(v);
      sections.push(v);
    }
    const tram: Tram = { sections, edge, forward, s, speed: CRUISE * 0.7, trail, bellCooldown: 0, stopped: 0 };
    this.place(tram, 0);
    this.trams.push(tram);
  }

  /** Forgets all trams (after the entity registry has been cleared). */
  clear() {
    for (const t of [...this.trams]) this.remove(t);
  }

  private remove(t: Tram) {
    for (const v of t.sections) this.ctx.entities.removeVehicle(v);
    this.trams.splice(this.trams.indexOf(t), 1);
  }

  private drive(t: Tram, dt: number) {
    // Brake for anything on the track ahead.
    const lead = t.sections[0];
    const blocked = this.obstacleDistance(t);
    let target = CRUISE;
    if (blocked < 30) target = Math.max(0, (blocked - 6) * 0.6);
    const accel = target > t.speed ? 1.2 : 4;
    t.speed += Math.sign(target - t.speed) * Math.min(Math.abs(target - t.speed), accel * dt);
    t.bellCooldown -= dt;
    if (blocked < 18 && t.bellCooldown <= 0) {
      this.ctx.audio.tramBell(lead.pos);
      t.bellCooldown = rand(2.5, 4);
    }
    // Stuck at a dead end or blocked forever: give up (despawned and respawned elsewhere).
    t.stopped = t.speed < 0.2 ? t.stopped + dt : 0;
    if (t.stopped > 40) {
      this.remove(t);
      return;
    }

    let ds = t.speed * dt;
    while (ds > 0) {
      const left = t.edge.length - t.s;
      if (ds < left) {
        t.s += ds;
        ds = 0;
      } else {
        ds -= left;
        const node = t.forward ? t.edge.b : t.edge.a;
        const next = this.nextEdge(t, node);
        if (!next) {
          // End of the line.
          t.s = t.edge.length;
          t.speed = 0;
          break;
        }
        t.edge = next.edge;
        t.forward = next.forward;
        t.s = 0;
      }
    }
    this.place(t, dt);
  }

  private nextEdge(t: Tram, node: RoadNode): { edge: RoadEdge; forward: boolean } | null {
    const inH = Math.atan2(t.forward ? t.edge.dx : -t.edge.dx, t.forward ? t.edge.dz : -t.edge.dz);
    const options: { edge: RoadEdge; forward: boolean }[] = [];
    for (const e of node.edges) {
      if (e === t.edge) continue;
      const forward = e.a === node;
      const h = Math.atan2(forward ? e.dx : -e.dx, forward ? e.dz : -e.dz);
      // Trams can't take sharp switches.
      if (Math.abs(angleDiff(inH, h)) < 0.9) options.push({ edge: e, forward });
    }
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }

  private obstacleDistance(t: Tram): number {
    const lead = t.sections[0];
    const s = Math.sin(lead.heading);
    const c = Math.cos(lead.heading);
    let best = Infinity;
    const check = (x: number, z: number, half: number) => {
      const rx = x - lead.pos.x;
      const rz = z - lead.pos.z;
      const f = rx * s + rz * c - lead.spec.length / 2;
      if (f < -0.5 || f > 30) return;
      if (Math.abs(rx * -c + rz * s) > 1.6 + half) return;
      best = Math.min(best, f);
    };
    for (const v of this.ctx.entities.vehicles) {
      if (v.kinematic) continue;
      check(v.pos.x, v.pos.z, v.spec.width / 2);
    }
    for (const ch of this.ctx.entities.characters) if (!ch.vehicle && ch.alive) check(ch.pos.x, ch.pos.z, 0.3);
    return best;
  }

  /** Positions the sections along the trail behind the lead point. */
  private place(t: Tram, dt: number) {
    const from = t.forward ? t.edge.a : t.edge.b;
    const dx = t.forward ? t.edge.dx : -t.edge.dx;
    const dz = t.forward ? t.edge.dz : -t.edge.dz;
    const fx = from.x + dx * t.s;
    const fz = from.z + dz * t.s;
    const head = t.trail[0];
    if (!head || Math.hypot(head.x - fx, head.z - fz) > 0.5) {
      t.trail.unshift({ x: fx, z: fz });
      if (t.trail.length > 200) t.trail.length = 200;
    } else {
      head.x = fx;
      head.z = fz;
    }
    const len = t.sections[0].spec.length;
    for (let i = 0; i < t.sections.length; i++) {
      const front = this.pointBack(t.trail, i * (len + SECTION_GAP));
      const back = this.pointBack(t.trail, i * (len + SECTION_GAP) + len);
      const v = t.sections[i];
      const nx = (front.x + back.x) / 2;
      const nz = (front.z + back.z) / 2;
      if (dt > 0) {
        v.vx = (nx - v.pos.x) / dt;
        v.vz = (nz - v.pos.z) / dt;
      }
      v.pos.set(nx, 0, nz);
      v.heading = Math.atan2(front.x - back.x, front.z - back.z);
    }
  }

  private pointBack(trail: { x: number; z: number }[], dist: number): { x: number; z: number } {
    let remaining = dist;
    for (let i = 0; i + 1 < trail.length; i++) {
      const a = trail[i];
      const b = trail[i + 1];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (remaining <= seg) {
        const f = seg > 0 ? remaining / seg : 0;
        return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
      }
      remaining -= seg;
    }
    return trail[trail.length - 1];
  }
}
