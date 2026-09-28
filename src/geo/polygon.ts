/**
 * 2D polygon helpers. Polygons/polylines are flat number arrays: [x0, z0, x1, z1, ...].
 * Rings are stored open (the last point is not a repeat of the first).
 */

export type Flat = number[];

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Signed area (positive = counter-clockwise in a +x right, +z down... i.e. clockwise on screen with z down). */
export function signedArea(ring: Flat): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  }
  return a / 2;
}

export function centroid(ring: Flat): { x: number; z: number } {
  // Area-weighted centroid, falls back to vertex average for degenerate rings.
  let a = 0;
  let cx = 0;
  let cz = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const f = ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    a += f;
    cx += (ring[j] + ring[i]) * f;
    cz += (ring[j + 1] + ring[i + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i += 2) {
      sx += ring[i];
      sz += ring[i + 1];
    }
    const c = n / 2 || 1;
    return { x: sx / c, z: sz / c };
  }
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

export function pointInRing(x: number, z: number, ring: Flat): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i];
    const zi = ring[i + 1];
    const xj = ring[j];
    const zj = ring[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, z: number, outer: Flat, holes?: Flat[]): boolean {
  if (!pointInRing(x, z, outer)) return false;
  if (holes) for (const h of holes) if (pointInRing(x, z, h)) return false;
  return true;
}

export function ringBounds(ring: Flat): Rect {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i];
    const z = ring[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * Sutherland–Hodgman clip of a (possibly concave) ring against an axis-aligned rectangle.
 * Concave input can yield zero-width "bridges" along the rect edge, which is harmless for filling.
 */
export function clipRingToRect(ring: Flat, r: Rect): Flat {
  let out = ring;
  out = clipEdge(out, (x) => x >= r.minX, (ax, az, bx, bz) => [r.minX, az + ((bz - az) * (r.minX - ax)) / (bx - ax)]);
  out = clipEdge(out, (x) => x <= r.maxX, (ax, az, bx, bz) => [r.maxX, az + ((bz - az) * (r.maxX - ax)) / (bx - ax)]);
  out = clipEdge(out, (_x, z) => z >= r.minZ, (ax, az, bx, bz) => [ax + ((bx - ax) * (r.minZ - az)) / (bz - az), r.minZ]);
  out = clipEdge(out, (_x, z) => z <= r.maxZ, (ax, az, bx, bz) => [ax + ((bx - ax) * (r.maxZ - az)) / (bz - az), r.maxZ]);
  return out;
}

function clipEdge(
  ring: Flat,
  inside: (x: number, z: number) => boolean,
  intersect: (ax: number, az: number, bx: number, bz: number) => [number, number],
): Flat {
  const n = ring.length;
  if (n < 6) return [];
  const out: Flat = [];
  let px = ring[n - 2];
  let pz = ring[n - 1];
  let pIn = inside(px, pz);
  for (let i = 0; i < n; i += 2) {
    const cx = ring[i];
    const cz = ring[i + 1];
    const cIn = inside(cx, cz);
    if (cIn) {
      if (!pIn) out.push(...intersect(px, pz, cx, cz));
      out.push(cx, cz);
    } else if (pIn) {
      out.push(...intersect(px, pz, cx, cz));
    }
    px = cx;
    pz = cz;
    pIn = cIn;
  }
  return out.length >= 6 ? out : [];
}

/** Removes consecutive duplicate points and the closing duplicate, if any. */
export function cleanRing(ring: Flat, eps = 1e-6): Flat {
  const out: Flat = [];
  for (let i = 0; i < ring.length; i += 2) {
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - ring[i]) < eps && Math.abs(out[n - 1] - ring[i + 1]) < eps) continue;
    out.push(ring[i], ring[i + 1]);
  }
  const n = out.length;
  if (n >= 4 && Math.abs(out[0] - out[n - 2]) < eps && Math.abs(out[1] - out[n - 1]) < eps) out.length = n - 2;
  return out;
}

/**
 * Joins open polyline fragments (e.g. multipolygon member ways) into closed rings by matching endpoints.
 * Fragments that cannot be closed are dropped.
 */
export function joinRings(fragments: Flat[], eps = 1e-7): Flat[] {
  const pool = fragments.filter((f) => f.length >= 4).map((f) => f.slice());
  const rings: Flat[] = [];
  const same = (ax: number, az: number, bx: number, bz: number) => Math.abs(ax - bx) < eps && Math.abs(az - bz) < eps;
  while (pool.length) {
    let cur = pool.pop()!;
    let guard = 0;
    while (!same(cur[0], cur[1], cur[cur.length - 2], cur[cur.length - 1]) && guard++ < 10_000) {
      const ex = cur[cur.length - 2];
      const ez = cur[cur.length - 1];
      let found = -1;
      let reverse = false;
      for (let i = 0; i < pool.length; i++) {
        const f = pool[i];
        if (same(f[0], f[1], ex, ez)) {
          found = i;
          break;
        }
        if (same(f[f.length - 2], f[f.length - 1], ex, ez)) {
          found = i;
          reverse = true;
          break;
        }
      }
      if (found < 0) break;
      let next = pool.splice(found, 1)[0];
      if (reverse) next = reversePolyline(next);
      cur = cur.concat(next.slice(2));
    }
    if (same(cur[0], cur[1], cur[cur.length - 2], cur[cur.length - 1])) {
      const ring = cleanRing(cur);
      if (ring.length >= 6) rings.push(ring);
    }
  }
  return rings;
}

export function reversePolyline(p: Flat): Flat {
  const out: Flat = new Array(p.length);
  for (let i = 0, j = p.length - 2; j >= 0; i += 2, j -= 2) {
    out[i] = p[j];
    out[i + 1] = p[j + 1];
  }
  return out;
}

/** Distance from point to segment, plus the closest point on the segment. */
export function closestPointOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { x: number; z: number; t: number; d2: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t;
  const z = az + dz * t;
  const ex = px - x;
  const ez = pz - z;
  return { x, z, t, d2: ex * ex + ez * ez };
}
