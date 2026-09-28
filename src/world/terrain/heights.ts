import type { BridgeSpan, BuildingData } from '../chunkTypes';

/** Height queries used by meshing and physics. */
export interface HeightSampler {
  /** Ground elevation (m) at a world position, on the terrain mesh surface. */
  ground(x: number, z: number): number;
  /** Smoothed ground normal (unit vector) at a world position. */
  normal(x: number, z: number): { x: number; y: number; z: number };
  /** Bridge deck elevation at distance `s` from the span's A end. */
  deck(span: BridgeSpan, s: number): number;
}

/** Spacing (m) of the global terrain lattice. */
export const LATTICE = 10;
const OFFSET = 50_000;
const MAX_CACHED = 400_000;

/**
 * The ground is a global lattice of height samples every LATTICE meters, triangulated the same way
 * everywhere (split along the x = z diagonal). Terrain meshes, draped roads/areas and physics all use
 * this exact surface, so nothing floats or sinks, and neighbouring chunks meet seamlessly.
 */
export function makeHeightSampler(raw: (x: number, z: number) => number): HeightSampler {
  let cache = new Map<number, number>();
  const node = (i: number, j: number): number => {
    const key = (i + OFFSET) * 2 * OFFSET + (j + OFFSET);
    let h = cache.get(key);
    if (h === undefined) {
      h = raw(i * LATTICE, j * LATTICE);
      // 0 means "no data loaded yet"; don't cache it, so the real value is picked up later.
      if (h !== 0) {
        if (cache.size > MAX_CACHED) cache = new Map();
        cache.set(key, h);
      }
    }
    return h;
  };
  const ground = (x: number, z: number): number => {
    const gx = x / LATTICE;
    const gz = z / LATTICE;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h00 = node(i, j);
    const h11 = node(i + 1, j + 1);
    if (fx >= fz) {
      const h10 = node(i + 1, j);
      return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    }
    const h01 = node(i, j + 1);
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  };
  const ends = new Map<string, [number, number]>();
  return {
    ground,
    normal(x, z) {
      const d = LATTICE * 0.5;
      const dx = ground(x + d, z) - ground(x - d, z);
      const dz = ground(x, z + d) - ground(x, z - d);
      const nx = -dx / (2 * d);
      const nz = -dz / (2 * d);
      const len = Math.hypot(nx, 1, nz);
      return { x: nx / len, y: 1 / len, z: nz / len };
    },
    deck(span, s) {
      const key = `${span.ax},${span.az},${span.bx},${span.bz}`;
      let e = ends.get(key);
      if (!e) {
        e = [ground(span.ax, span.az), ground(span.bx, span.bz)];
        if (e[0] !== 0 || e[1] !== 0) ends.set(key, e);
      }
      const u = span.length > 0 ? Math.min(1, Math.max(0, s / span.length)) : 0;
      return e[0] + (e[1] - e[0]) * u + span.arch * 4 * u * (1 - u);
    },
  };
}

/** Water connected to the sea sits at sea level; the elevation data is too coarse to trust there. */
const SEA_LEVEL = 0.3;

/**
 * Flat water surface for a (chunk piece of a) water area: sea level for rivers/harbours that reach
 * down near sea level, otherwise the lowest shoreline point (lakes and ponds).
 */
export function waterLevel(outer: number[], ground: (x: number, z: number) => number): number {
  let min = Infinity;
  for (let i = 0; i < outer.length; i += 2) min = Math.min(min, ground(outer[i], outer[i + 1]));
  if (!Number.isFinite(min)) return SEA_LEVEL;
  return min < 4 ? SEA_LEVEL : min - 0.2;
}

/** A building sits on the lowest ground under its footprint (so no side floats). */
export function buildingBase(b: BuildingData, ground: (x: number, z: number) => number): number {
  let min = Infinity;
  const ring = b.outer;
  const step = Math.max(1, Math.floor(ring.length / 2 / 24)) * 2;
  for (let i = 0; i < ring.length; i += step) min = Math.min(min, ground(ring[i], ring[i + 1]));
  return (Number.isFinite(min) ? min : 0) - 0.3;
}
