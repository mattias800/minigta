import { angleDiff, clamp } from '../core/math';
import type { Vehicle } from '../entities/Vehicle';
import type { RoadEdge, RoadNetwork, RoadNode } from '../world/RoadNetwork';

interface Step {
  edge: RoadEdge;
  forward: boolean;
}

const stepFrom = (s: Step) => (s.forward ? s.edge.a : s.edge.b);
const stepTo = (s: Step) => (s.forward ? s.edge.b : s.edge.a);
const stepDir = (s: Step) => ({ x: s.forward ? s.edge.dx : -s.edge.dx, z: s.forward ? s.edge.dz : -s.edge.dz });

/**
 * Follows the road graph lane by lane (right-hand traffic) and produces a steering target.
 * Plans a few edges ahead so the look-ahead point flows smoothly around corners. Either picks
 * random turns at intersections or follows a node path (used by police).
 */
export class LaneFollower {
  private current: Step;
  /** Planned upcoming edges after the current one. */
  private plan: Step[] = [];
  private path: RoadNode[] | null = null;
  respectOneway = true;

  constructor(edge: RoadEdge, forward: boolean) {
    this.current = { edge, forward };
  }

  get edge(): RoadEdge {
    return this.current.edge;
  }

  get to(): RoadNode {
    return stepTo(this.current);
  }

  static laneOffset(e: RoadEdge): number {
    if (e.oneway) return e.lanes > 1 ? e.width * 0.15 : 0;
    return clamp(e.width / 4, 1.4, 3.4);
  }

  /** Replaces the route with a node path (first node ≈ current position). */
  setPath(path: RoadNode[] | null) {
    this.path = path;
    this.plan = [];
  }

  /** True if the current edge is still part of the graph (chunks may unload). */
  valid(net: RoadNetwork): boolean {
    const e = this.current.edge;
    return net.nodes.get(e.a.id) === e.a && e.a.edges.includes(e);
  }

  /**
   * Computes the point to steer towards, `lookAhead` meters down the route, and the sharpest turn
   * within `brakeDistance`. Advances along the route as the vehicle passes nodes.
   */
  target(v: Vehicle, lookAhead: number, brakeDistance = 20): { x: number; z: number; turn: number; turnDistance: number } {
    // Advance past nodes we've reached (or overshot).
    for (let guard = 0; guard < 8; guard++) {
      const from = stepFrom(this.current);
      const d = stepDir(this.current);
      const along = (v.pos.x - from.x) * d.x + (v.pos.z - from.z) * d.z;
      if (along < this.current.edge.length - 1.5) break;
      if (!this.advance()) break;
    }

    this.ensurePlan(lookAhead + brakeDistance);
    const from = stepFrom(this.current);
    const d = stepDir(this.current);
    const along = clamp((v.pos.x - from.x) * d.x + (v.pos.z - from.z) * d.z, 0, this.current.edge.length);

    // Walk the look-ahead distance along current + planned edges.
    let remaining = lookAhead;
    let step = this.current;
    let s = along;
    let idx = -1;
    let turn = 0;
    let turnDistance = Infinity;
    let travelled = this.current.edge.length - along;
    let prevHeading = Math.atan2(d.x, d.z);
    for (;;) {
      const left = step.edge.length - s;
      if (remaining <= left || idx + 1 >= this.plan.length) {
        s = Math.min(step.edge.length, s + remaining);
        break;
      }
      remaining -= left;
      idx++;
      step = this.plan[idx];
      s = 0;
    }
    // Sharpest turn within brake distance.
    for (let i = 0; i < this.plan.length && travelled < brakeDistance; i++) {
      const nd = stepDir(this.plan[i]);
      const h = Math.atan2(nd.x, nd.z);
      const t = Math.abs(angleDiff(prevHeading, h));
      if (t > turn) {
        turn = t;
        turnDistance = travelled;
      }
      prevHeading = h;
      travelled += this.plan[i].edge.length;
    }

    const sf = stepFrom(step);
    const sd = stepDir(step);
    const off = LaneFollower.laneOffset(step.edge);
    // Right of travel direction is (-dz, dx).
    return { x: sf.x + sd.x * s - sd.z * off, z: sf.z + sd.z * s + sd.x * off, turn, turnDistance };
  }

  private advance(): boolean {
    this.ensurePlan(1);
    const next = this.plan.shift();
    if (!next) {
      // Dead end: turn around (if allowed).
      if (!this.current.edge.oneway || !this.respectOneway) this.current = { edge: this.current.edge, forward: !this.current.forward };
      return false;
    }
    const node = stepFrom(next);
    if (this.path) {
      const i = this.path.indexOf(node);
      if (i >= 0) this.path = this.path.slice(i);
    }
    this.current = next;
    return true;
  }

  private ensurePlan(distance: number) {
    let total = 0;
    for (const s of this.plan) total += s.edge.length;
    let last = this.plan.length ? this.plan[this.plan.length - 1] : this.current;
    while (total < distance && this.plan.length < 12) {
      const next = this.chooseNext(last);
      if (!next) break;
      this.plan.push(next);
      total += next.edge.length;
      last = next;
    }
  }

  private chooseNext(prev: Step): Step | null {
    const node = stepTo(prev);
    const inDir = stepDir(prev);
    const inHeading = Math.atan2(inDir.x, inDir.z);
    if (this.path && this.path.length > 1) {
      const i = this.path.indexOf(node);
      if (i >= 0 && i + 1 < this.path.length) {
        const want = this.path[i + 1];
        for (const e of node.edges) {
          if (!e.drivable) continue;
          const forward = e.a === node;
          if ((forward ? e.b : e.a) === want && (!this.respectOneway || !e.oneway || forward)) return { edge: e, forward };
        }
      }
    }
    const options: (Step & { weight: number })[] = [];
    for (const e of node.edges) {
      if (e === prev.edge || !e.drivable) continue;
      const forward = e.a === node;
      if (this.respectOneway && e.oneway && !forward) continue;
      const dx = forward ? e.dx : -e.dx;
      const dz = forward ? e.dz : -e.dz;
      const turn = Math.abs(angleDiff(inHeading, Math.atan2(dx, dz)));
      // Prefer going straight and staying on similar roads; avoid service roads.
      let w = 1 + Math.cos(turn) * 0.8;
      if (e.kind === 'service') w *= 0.15;
      if (e.kind === prev.edge.kind) w *= 1.5;
      if (e.name && e.name === prev.edge.name) w *= 2;
      if (turn > 2.6) w *= 0.05;
      options.push({ edge: e, forward, weight: w });
    }
    if (!options.length) return null;
    let r = Math.random() * options.reduce((s, o) => s + o.weight, 0);
    for (const o of options) {
      r -= o.weight;
      if (r <= 0) return o;
    }
    return options[options.length - 1];
  }
}
