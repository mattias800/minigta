import { closestPointOnSegment } from '../geo/polygon';

/**
 * A static obstacle edge: a wall segment of a building (r = 0) or a round post such as a tree trunk
 * (a = b, r > 0). `top` is the height of the obstacle, used by ray casts that can pass over it.
 */
export interface Obstacle {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
  /** Absolute height range (m) the obstacle occupies. */
  bottom: number;
  top: number;
  owner: string;
  /** Query stamp used for de-duplication across grid cells. */
  stamp: number;
}

export interface CircleHit {
  /** Push-out direction (unit). */
  nx: number;
  nz: number;
  depth: number;
}

export interface RayHit {
  distance: number;
  x: number;
  z: number;
  nx: number;
  nz: number;
}

const CELL = 8;
const OFFSET = 0x8000;
const cellKey = (ix: number, iz: number) => (ix + OFFSET) * 0x10000 + (iz + OFFSET);

/** Uniform-grid spatial hash of static 2D obstacles (building walls, tree trunks). */
export class StaticCollision {
  private readonly cells = new Map<number, Obstacle[]>();
  private readonly ownerCells = new Map<string, Set<number>>();
  private stamp = 1;

  addWall(owner: string, ax: number, az: number, bx: number, bz: number, bottom: number, top: number) {
    this.insert({ ax, az, bx, bz, r: 0, bottom, top, owner, stamp: 0 });
  }

  addPost(owner: string, x: number, z: number, r: number, bottom: number, top: number) {
    this.insert({ ax: x, az: z, bx: x, bz: z, r, bottom, top, owner, stamp: 0 });
  }

  removeOwner(owner: string) {
    const keys = this.ownerCells.get(owner);
    if (!keys) return;
    for (const k of keys) {
      const list = this.cells.get(k);
      if (!list) continue;
      const kept = list.filter((o) => o.owner !== owner);
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
    this.ownerCells.delete(owner);
  }

  private insert(o: Obstacle) {
    let keys = this.ownerCells.get(o.owner);
    if (!keys) {
      keys = new Set();
      this.ownerCells.set(o.owner, keys);
    }
    const x0 = Math.floor((Math.min(o.ax, o.bx) - o.r) / CELL);
    const x1 = Math.floor((Math.max(o.ax, o.bx) + o.r) / CELL);
    const z0 = Math.floor((Math.min(o.az, o.bz) - o.r) / CELL);
    const z1 = Math.floor((Math.max(o.az, o.bz) + o.r) / CELL);
    // Only rasterize cells the segment actually passes near (long walls would otherwise fill their bbox).
    const dx = o.bx - o.ax;
    const dz = o.bz - o.az;
    const len = Math.hypot(dx, dz);
    const half = CELL * 0.7072 + o.r;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        if (len > CELL) {
          const cx = (ix + 0.5) * CELL;
          const cz = (iz + 0.5) * CELL;
          const d = Math.abs((cx - o.ax) * dz - (cz - o.az) * dx) / len;
          if (d > half) continue;
        }
        const k = cellKey(ix, iz);
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(o);
        keys.add(k);
      }
    }
  }

  /** Calls `fn` once for every obstacle whose cell overlaps the given box. */
  forEachNear(minX: number, minZ: number, maxX: number, maxZ: number, fn: (o: Obstacle) => void) {
    const s = ++this.stamp;
    const x0 = Math.floor(minX / CELL);
    const x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL);
    const z1 = Math.floor(maxZ / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const o of list) {
          if (o.stamp === s) continue;
          o.stamp = s;
          fn(o);
        }
      }
    }
  }

  /**
   * Finds the deepest penetration of a circle (a vertical cylinder from `minY` to `maxY`) into any
   * obstacle overlapping that height range. Returns null if there is no overlap.
   */
  circleHit(x: number, z: number, radius: number, minY: number, maxY: number): CircleHit | null {
    let best: CircleHit | null = null;
    this.forEachNear(x - radius - 1, z - radius - 1, x + radius + 1, z + radius + 1, (o) => {
      if (o.top <= minY || o.bottom >= maxY) return;
      const c = closestPointOnSegment(x, z, o.ax, o.az, o.bx, o.bz);
      const rr = radius + o.r;
      if (c.d2 >= rr * rr) return;
      const d = Math.sqrt(c.d2);
      const depth = rr - d;
      if (best && depth <= best.depth) return;
      if (d > 1e-6) best = { nx: (x - c.x) / d, nz: (z - c.z) / d, depth };
      else {
        // Center exactly on a wall: push along the wall's normal.
        const len = Math.hypot(o.bx - o.ax, o.bz - o.az) || 1;
        best = { nx: -(o.bz - o.az) / len, nz: (o.bx - o.ax) / len, depth };
      }
    });
    return best;
  }

  /** Resolves a cylinder out of all obstacles; returns the accumulated push (or null if untouched). */
  resolveCircle(pos: { x: number; z: number }, radius: number, minY: number, maxY: number): { nx: number; nz: number } | null {
    let pushX = 0;
    let pushZ = 0;
    for (let iter = 0; iter < 4; iter++) {
      const hit = this.circleHit(pos.x, pos.z, radius, minY, maxY);
      if (!hit) break;
      pos.x += hit.nx * hit.depth;
      pos.z += hit.nz * hit.depth;
      pushX += hit.nx * hit.depth;
      pushZ += hit.nz * hit.depth;
    }
    const len = Math.hypot(pushX, pushZ);
    return len > 0 ? { nx: pushX / len, nz: pushZ / len } : null;
  }

  /**
   * Casts a ray in the xz plane at height y0 + dy * t (dy is the vertical rise per horizontal meter);
   * it passes over and under obstacles outside that height.
   */
  raycast(ox: number, oz: number, dx: number, dz: number, maxDist: number, y0: number, dy = 0): RayHit | null {
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return null;
    dx /= len;
    dz /= len;
    let best: RayHit | null = null;
    let bestT = maxDist;

    // Amanatides & Woo grid traversal.
    let ix = Math.floor(ox / CELL);
    let iz = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(CELL / dx);
    const tDeltaZ = Math.abs(CELL / dz);
    let tMaxX = dx !== 0 ? ((dx > 0 ? (ix + 1) * CELL - ox : ox - ix * CELL) / Math.abs(dx)) : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? (iz + 1) * CELL - oz : oz - iz * CELL) / Math.abs(dz)) : Infinity;
    const s = ++this.stamp;
    let tCell = 0;
    while (tCell <= bestT) {
      const list = this.cells.get(cellKey(ix, iz));
      if (list) {
        for (const o of list) {
          if (o.stamp === s) continue;
          o.stamp = s;
          const h = o.r > 0 ? rayCircle(ox, oz, dx, dz, o.ax, o.az, o.r) : raySegment(ox, oz, dx, dz, o.ax, o.az, o.bx, o.bz);
          if (h === null || h >= bestT) continue;
          const hy = y0 + dy * h;
          if (hy > o.top || hy < o.bottom) continue;
          bestT = h;
          const hx = ox + dx * h;
          const hz = oz + dz * h;
          let nx: number;
          let nz: number;
          if (o.r > 0) {
            nx = (hx - o.ax) / o.r;
            nz = (hz - o.az) / o.r;
          } else {
            const sl = Math.hypot(o.bx - o.ax, o.bz - o.az) || 1;
            nx = -(o.bz - o.az) / sl;
            nz = (o.bx - o.ax) / sl;
            if (nx * dx + nz * dz > 0) {
              nx = -nx;
              nz = -nz;
            }
          }
          best = { distance: h, x: hx, z: hz, nx, nz };
        }
      }
      if (tMaxX < tMaxZ) {
        tCell = tMaxX;
        tMaxX += tDeltaX;
        ix += stepX;
      } else {
        tCell = tMaxZ;
        tMaxZ += tDeltaZ;
        iz += stepZ;
      }
      if (tCell > maxDist) break;
    }
    return best;
  }

  /** True if the straight line between two points at the given heights is unobstructed. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    if (d < 0.01) return true;
    return this.raycast(ax, az, bx - ax, bz - az, d, ay, (by - ay) / d) === null;
  }
}

function raySegment(ox: number, oz: number, dx: number, dz: number, ax: number, az: number, bx: number, bz: number): number | null {
  const ex = bx - ax;
  const ez = bz - az;
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-12) return null;
  const fx = ax - ox;
  const fz = az - oz;
  const t = (fx * ez - fz * ex) / den;
  const u = (fx * dz - fz * dx) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
}

function rayCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, r: number): number | null {
  const fx = ox - cx;
  const fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}
