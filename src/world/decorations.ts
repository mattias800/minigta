import { seededRandom, hashString } from '../core/math';
import { closestPointOnSegment, pointInPolygon, ringBounds } from '../geo/polygon';
import { CHUNK_SIZE } from '../config';
import { chunkKey, type ChunkData } from './chunkTypes';
import { isDrivable } from './osm/process';

export interface TreeInstance {
  x: number;
  z: number;
  scale: number;
  /** 0..1, picks canopy tint. */
  hue: number;
}

const DENSITY: Partial<Record<string, number>> = {
  // Square meters per scattered tree.
  forest: 90,
  park: 320,
  grass: 1400,
};

/** Mapped trees plus deterministic scattered trees in parks and forests, avoiding roads and buildings. */
export function treesForChunk(chunk: ChunkData): TreeInstance[] {
  const rnd = seededRandom(hashString(chunkKey(chunk.cx, chunk.cz)));
  const out: TreeInstance[] = [];
  const blocked = obstacleTester(chunk);
  for (let i = 0; i < chunk.trees.length; i += 2) {
    out.push({ x: chunk.trees[i], z: chunk.trees[i + 1], scale: 0.8 + rnd() * 0.5, hue: rnd() });
  }
  for (const area of chunk.areas) {
    const density = DENSITY[area.kind];
    if (!density) continue;
    const b = ringBounds(area.outer);
    const approxArea = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    const n = Math.min(400, Math.floor(approxArea / density));
    for (let i = 0; i < n; i++) {
      const x = b.minX + rnd() * (b.maxX - b.minX);
      const z = b.minZ + rnd() * (b.maxZ - b.minZ);
      if (!pointInPolygon(x, z, area.outer, area.holes)) continue;
      if (blocked(x, z)) continue;
      out.push({ x, z, scale: 0.7 + rnd() * 0.7, hue: rnd() });
    }
  }
  return out;
}

function obstacleTester(chunk: ChunkData): (x: number, z: number) => boolean {
  const buildings = chunk.buildings.map((b) => ({ b, bounds: ringBounds(b.outer) }));
  const water = chunk.areas.filter((a) => a.kind === 'water');
  // Coarse grid of road segments for quick rejection.
  const CELL = 25;
  const n = Math.ceil(CHUNK_SIZE / CELL);
  const ox = chunk.cx * CHUNK_SIZE;
  const oz = chunk.cz * CHUNK_SIZE;
  const grid: number[][][] = Array.from({ length: n * n }, () => []);
  for (const r of chunk.roads) {
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const seg = [r.pts[i], r.pts[i + 1], r.pts[i + 2], r.pts[i + 3], r.width / 2 + 2];
      const pad = seg[4];
      const x0 = Math.max(0, Math.floor((Math.min(seg[0], seg[2]) - pad - ox) / CELL));
      const x1 = Math.min(n - 1, Math.floor((Math.max(seg[0], seg[2]) + pad - ox) / CELL));
      const z0 = Math.max(0, Math.floor((Math.min(seg[1], seg[3]) - pad - oz) / CELL));
      const z1 = Math.min(n - 1, Math.floor((Math.max(seg[1], seg[3]) + pad - oz) / CELL));
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) grid[gz * n + gx].push(seg);
    }
  }
  return (x, z) => {
    const gx = Math.floor((x - ox) / CELL);
    const gz = Math.floor((z - oz) / CELL);
    if (gx >= 0 && gz >= 0 && gx < n && gz < n) {
      for (const s of grid[gz * n + gx]) {
        if (closestPointOnSegment(x, z, s[0], s[1], s[2], s[3]).d2 < s[4] * s[4]) return true;
      }
    }
    if (water.some((a) => pointInPolygon(x, z, a.outer, a.holes))) return true;
    for (const { b, bounds } of buildings) {
      if (x < bounds.minX - 2 || x > bounds.maxX + 2 || z < bounds.minZ - 2 || z > bounds.maxZ + 2) continue;
      if (pointInPolygon(x, z, b.outer)) return true;
    }
    return false;
  };
}

export interface LampInstance {
  x: number;
  z: number;
  /** Direction the lamp arm points (towards the road). */
  heading: number;
}

const LAMP_SPACING = 30;

/** Street lamps along the kerbs of city streets, kept away from intersections (segment ends). */
export function lampsForChunk(chunk: ChunkData): LampInstance[] {
  const out: LampInstance[] = [];
  for (const r of chunk.roads) {
    if (!isDrivable(r.kind) || r.kind === 'service' || r.bridge) continue;
    let side = r.id % 2 === 0 ? 1 : -1;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i];
      const az = r.pts[i + 1];
      const dx = r.pts[i + 2] - ax;
      const dz = r.pts[i + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 22) continue;
      const ux = dx / len;
      const uz = dz / len;
      const off = r.width / 2 + 0.45;
      for (let s = 9; s < len - 9; s += LAMP_SPACING) {
        // Right of travel is (-uz, ux).
        const x = ax + ux * s - uz * off * side;
        const z = az + uz * s + ux * off * side;
        out.push({ x, z, heading: Math.atan2(uz * side, -ux * side) });
        side = -side as 1 | -1;
      }
    }
  }
  return out;
}
