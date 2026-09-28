import { closestPointOnSegment } from '../geo/polygon';
import type { RoadData, RoadKind } from './chunkTypes';
import { isDrivable } from './osm/process';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  edges: RoadEdge[];
}

export interface RoadEdge {
  id: number;
  a: RoadNode;
  b: RoadNode;
  kind: RoadKind;
  width: number;
  lanes: number;
  /** If true, traffic may only travel a → b. */
  oneway: boolean;
  bridge: boolean;
  name?: string;
  length: number;
  /** Unit direction a → b. */
  dx: number;
  dz: number;
  drivable: boolean;
  owner: string;
  stamp: number;
}

export interface EdgeQuery {
  edge: RoadEdge;
  /** 0..1 along a → b. */
  t: number;
  x: number;
  z: number;
  distance: number;
}

const CELL = 24;
const OFFSET = 0x8000;
const cellKey = (ix: number, iz: number) => (ix + OFFSET) * 0x10000 + (iz + OFFSET);

/** Speed limits per road class (m/s) used by AI drivers. */
export const SPEED_LIMIT: Record<RoadKind, number> = {
  motorway: 24,
  primary: 15,
  secondary: 13,
  tertiary: 11,
  residential: 8.5,
  service: 5.5,
  pedestrian: 3,
  footway: 3,
  cycleway: 3,
  steps: 2,
};

/**
 * Graph of all loaded roads and paths, built from OSM ways. Nodes are OSM nodes, so ways (and chunk
 * pieces of ways) connect wherever they share a node.
 */
export class RoadNetwork {
  readonly nodes = new Map<number, RoadNode>();
  private readonly ownerEdges = new Map<string, RoadEdge[]>();
  private readonly cells = new Map<number, RoadEdge[]>();
  private nextEdgeId = 1;
  private stamp = 1;
  /** Incremented whenever the graph changes; lets AI invalidate cached paths. */
  version = 0;

  addRoads(owner: string, roads: RoadData[]) {
    const edges: RoadEdge[] = [];
    for (const r of roads) {
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = this.node(r.nodes[i], r.pts[i * 2], r.pts[i * 2 + 1]);
        const b = this.node(r.nodes[i + 1], r.pts[i * 2 + 2], r.pts[i * 2 + 3]);
        if (a === b) continue;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 0.05) continue;
        const e: RoadEdge = {
          id: this.nextEdgeId++,
          a,
          b,
          kind: r.kind,
          width: r.width,
          lanes: r.lanes,
          oneway: r.oneway,
          bridge: !!r.bridge,
          name: r.name,
          length,
          dx: (b.x - a.x) / length,
          dz: (b.z - a.z) / length,
          drivable: isDrivable(r.kind),
          owner,
          stamp: 0,
        };
        a.edges.push(e);
        b.edges.push(e);
        edges.push(e);
        this.index(e);
      }
    }
    this.ownerEdges.set(owner, edges);
    this.version++;
  }

  removeOwner(owner: string) {
    const edges = this.ownerEdges.get(owner);
    if (!edges) return;
    const dead = new Set(edges);
    for (const e of edges) {
      for (const n of [e.a, e.b]) {
        n.edges = n.edges.filter((x) => !dead.has(x));
        if (!n.edges.length) this.nodes.delete(n.id);
      }
      this.forCells(e, (k) => {
        const list = this.cells.get(k);
        if (!list) return;
        const kept = list.filter((x) => x !== e);
        if (kept.length) this.cells.set(k, kept);
        else this.cells.delete(k);
      });
    }
    this.ownerEdges.delete(owner);
    this.version++;
  }

  private node(id: number, x: number, z: number): RoadNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, x, z, edges: [] };
      this.nodes.set(id, n);
    }
    return n;
  }

  private forCells(e: RoadEdge, fn: (k: number) => void) {
    const pad = e.width / 2 + 2;
    const x0 = Math.floor((Math.min(e.a.x, e.b.x) - pad) / CELL);
    const x1 = Math.floor((Math.max(e.a.x, e.b.x) + pad) / CELL);
    const z0 = Math.floor((Math.min(e.a.z, e.b.z) - pad) / CELL);
    const z1 = Math.floor((Math.max(e.a.z, e.b.z) + pad) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) fn(cellKey(ix, iz));
  }

  private index(e: RoadEdge) {
    this.forCells(e, (k) => {
      let list = this.cells.get(k);
      if (!list) {
        list = [];
        this.cells.set(k, list);
      }
      list.push(e);
    });
  }

  forEachEdgeNear(x: number, z: number, radius: number, fn: (e: RoadEdge) => void) {
    const s = ++this.stamp;
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL);
    const z1 = Math.floor((z + radius) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const e of list) {
          if (e.stamp === s) continue;
          e.stamp = s;
          fn(e);
        }
      }
    }
  }

  /** Nearest graph node reachable via an edge matching the filter. */
  nearestNode(x: number, z: number, maxDist: number, filter?: (e: RoadEdge) => boolean): RoadNode | null {
    const q = this.nearestEdge(x, z, maxDist, filter);
    if (!q) return null;
    return q.t < 0.5 ? q.edge.a : q.edge.b;
  }

  nearestEdge(x: number, z: number, maxDist: number, filter?: (e: RoadEdge) => boolean): EdgeQuery | null {
    let best: EdgeQuery | null = null;
    this.forEachEdgeNear(x, z, maxDist, (e) => {
      if (filter && !filter(e)) return;
      const c = closestPointOnSegment(x, z, e.a.x, e.a.z, e.b.x, e.b.z);
      const d = Math.sqrt(c.d2);
      if (d > maxDist || (best && d >= best.distance)) return;
      best = { edge: e, t: c.t, x: c.x, z: c.z, distance: d };
    });
    return best;
  }

  /** True if (x, z) lies on the paved surface of any road or bridge. */
  isOnRoad(x: number, z: number, margin = 0): boolean {
    let on = false;
    this.forEachEdgeNear(x, z, 16, (e) => {
      if (on) return;
      const c = closestPointOnSegment(x, z, e.a.x, e.a.z, e.b.x, e.b.z);
      const hw = e.width / 2 + margin + (e.drivable && e.kind !== 'service' && e.kind !== 'motorway' ? 2.5 : 0);
      if (c.d2 < hw * hw) on = true;
    });
    return on;
  }

  /** Picks a random edge whose midpoint is between rMin and rMax from (x, z). */
  randomEdgeInRing(
    x: number,
    z: number,
    rMin: number,
    rMax: number,
    filter: (e: RoadEdge) => boolean,
    tries = 12,
  ): RoadEdge | null {
    const candidates: RoadEdge[] = [];
    for (let i = 0; i < tries && candidates.length < 1; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = rMin + Math.random() * (rMax - rMin);
      const px = x + Math.sin(ang) * r;
      const pz = z + Math.cos(ang) * r;
      this.forEachEdgeNear(px, pz, 20, (e) => {
        if (!filter(e)) return;
        const mx = (e.a.x + e.b.x) / 2;
        const mz = (e.a.z + e.b.z) / 2;
        const d = Math.hypot(mx - x, mz - z);
        if (d >= rMin && d <= rMax) candidates.push(e);
      });
    }
    return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  }

  /**
   * A* over the network (drivable roads only, or everything for people on foot). Oneway restrictions
   * are optional (police ignore them). Returns the node sequence from start to goal, or null.
   */
  findPath(start: RoadNode, goal: RoadNode, opts: { respectOneway: boolean; drivableOnly: boolean }, maxExpanded = 4000): RoadNode[] | null {
    const { respectOneway, drivableOnly } = opts;
    if (start === goal) return [start];
    const g = new Map<RoadNode, number>([[start, 0]]);
    const came = new Map<RoadNode, RoadNode>();
    const open = new MinHeap<RoadNode>();
    const h = (n: RoadNode) => Math.hypot(n.x - goal.x, n.z - goal.z);
    open.push(start, h(start));
    const closed = new Set<RoadNode>();
    let expanded = 0;
    while (open.size) {
      const cur = open.pop()!;
      if (cur === goal) {
        const path = [cur];
        let n = cur;
        while (came.has(n)) {
          n = came.get(n)!;
          path.push(n);
        }
        return path.reverse();
      }
      if (closed.has(cur)) continue;
      closed.add(cur);
      if (++expanded > maxExpanded) return null;
      const gc = g.get(cur)!;
      for (const e of cur.edges) {
        if (drivableOnly && !e.drivable) continue;
        const forward = e.a === cur;
        if (respectOneway && e.oneway && !forward) continue;
        const next = forward ? e.b : e.a;
        if (closed.has(next)) continue;
        const cost = gc + e.length * (e.kind === 'service' ? 1.6 : 1);
        if (cost < (g.get(next) ?? Infinity)) {
          g.set(next, cost);
          came.set(next, cur);
          open.push(next, cost + h(next));
        }
      }
    }
    return null;
  }
}

class MinHeap<T> {
  private items: T[] = [];
  private prios: number[] = [];

  get size() {
    return this.items.length;
  }

  push(item: T, prio: number) {
    this.items.push(item);
    this.prios.push(prio);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prios[p] <= this.prios[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): T | undefined {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPrio = this.prios.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prios[l] < this.prios[m]) m = l;
        if (r < this.items.length && this.prios[r] < this.prios[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prios[a], this.prios[b]] = [this.prios[b], this.prios[a]];
  }
}
