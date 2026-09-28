import type { Projection } from '../../geo/projection';

/** Decoded elevation tile: `size` × `size` heights in meters, row-major, north row first. */
export interface HeightTile {
  size: number;
  heights: Float32Array;
}

/** Loads the elevation tile at web-mercator (z, x, y), or null if unavailable. */
export type HeightTileLoader = (z: number, x: number, y: number) => Promise<HeightTile | null>;

const ZOOM = 14;

/**
 * Ground elevation (meters above sea level) from web-mercator elevation tiles. Areas are loaded
 * asynchronously with `ensure`; `heightAt` is synchronous and returns 0 where nothing is loaded.
 *
 * The tile loader is pluggable, so the global Terrarium tiles can be swapped for a national
 * high-resolution model (e.g. Lantmäteriet's 1 m laser data) without touching the engine.
 */
export class Terrain {
  private readonly tiles = new Map<string, HeightTile | null>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly worldPx: number;

  constructor(
    private readonly proj: Projection,
    private readonly loader: HeightTileLoader,
    private readonly tileSize = 256,
  ) {
    this.worldPx = tileSize * 2 ** ZOOM;
  }

  /** Loads all tiles covering the world-space rectangle. */
  ensure(minX: number, minZ: number, maxX: number, maxZ: number): Promise<void> {
    const a = this.pixel(minX, minZ);
    const b = this.pixel(maxX, maxZ);
    const loads: Promise<void>[] = [];
    for (let tx = Math.floor(Math.min(a.px, b.px) / this.tileSize); tx <= Math.floor(Math.max(a.px, b.px) / this.tileSize); tx++) {
      for (let ty = Math.floor(Math.min(a.py, b.py) / this.tileSize); ty <= Math.floor(Math.max(a.py, b.py) / this.tileSize); ty++) {
        loads.push(this.load(tx, ty));
      }
    }
    return Promise.all(loads).then(() => undefined);
  }

  private load(tx: number, ty: number): Promise<void> {
    const key = `${tx}/${ty}`;
    if (this.tiles.has(key)) return Promise.resolve();
    let p = this.pending.get(key);
    if (!p) {
      p = this.loader(ZOOM, tx, ty)
        .catch(() => null)
        .then((t) => {
          this.tiles.set(key, t);
          this.pending.delete(key);
        });
      this.pending.set(key, p);
    }
    return p;
  }

  private pixel(x: number, z: number): { px: number; py: number } {
    const ll = this.proj.toLatLon(x, z);
    const px = ((ll.lon + 180) / 360) * this.worldPx;
    const r = (ll.lat * Math.PI) / 180;
    const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * this.worldPx;
    return { px, py };
  }

  private sample(px: number, py: number): number | null {
    const s = this.tileSize;
    const tile = this.tiles.get(`${Math.floor(px / s)}/${Math.floor(py / s)}`);
    if (!tile) return null;
    const ix = Math.min(s - 1, Math.max(0, Math.floor(px) - Math.floor(px / s) * s));
    const iy = Math.min(s - 1, Math.max(0, Math.floor(py) - Math.floor(py / s) * s));
    return tile.heights[iy * s + ix];
  }

  /** Bilinear ground height at a world position (0 where no data is loaded). */
  heightAt(x: number, z: number): number {
    const { px, py } = this.pixel(x, z);
    // Pixel centers are at +0.5.
    const fx = px - 0.5;
    const fy = py - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = this.sample(x0, y0);
    if (h00 === null) return 0;
    const h10 = this.sample(x0 + 1, y0) ?? h00;
    const h01 = this.sample(x0, y0 + 1) ?? h00;
    const h11 = this.sample(x0 + 1, y0 + 1) ?? h00;
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  }
}

/**
 * Loader for the free, global "Terrarium" elevation tiles hosted on AWS Open Data
 * (height = R * 256 + G + B / 256 - 32768). Browser only (uses createImageBitmap).
 */
export const terrariumLoader: HeightTileLoader = async (z, x, y) => {
  const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const size = bmp.width;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, size, size).data;
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return { size, heights };
};
