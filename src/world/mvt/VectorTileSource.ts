import { CHUNK_SIZE } from '../../config';
import type { Projection } from '../../geo/projection';
import type { ChunkData } from '../chunkTypes';
import { OsmChunker } from '../osm/process';
import type { OsmElement } from '../osm/types';
import { mvtToOsm, type TileCoord } from './convert';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
/** OpenMapTiles' highest zoom; one tile is ~1.3 km across at Gothenburg's latitude. */
const ZOOM = 14;
const MAX_CACHED_TILES = 48;

function tileRange(south: number, west: number, north: number, east: number, z: number) {
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: tx(west), x1: tx(east), y0: ty(north), y1: ty(south) };
}

/**
 * Streams map data for any place on Earth from OpenFreeMap's OSM vector tiles (fast CDN, no key),
 * converting it into game chunks with the same pipeline as the pre-baked Overpass data.
 */
export class VectorTileSource {
  private template: Promise<string> | null = null;
  private readonly tiles = new Map<string, Promise<OsmElement[]>>();
  /** Chunkers per set of tiles; neighbouring chunks usually share one, saving re-projection work. */
  private readonly chunkers = new Map<string, Promise<OsmChunker>>();
  private idCounter = -1;

  constructor(private readonly proj: Projection) {}

  async chunk(cx: number, cz: number): Promise<ChunkData> {
    const b = this.proj.bboxOf(cx * CHUNK_SIZE, cz * CHUNK_SIZE, (cx + 1) * CHUNK_SIZE, (cz + 1) * CHUNK_SIZE);
    const r = tileRange(b.south, b.west, b.north, b.east, ZOOM);
    const key = `${r.x0},${r.y0},${r.x1},${r.y1}`;
    let chunker = this.chunkers.get(key);
    if (!chunker) {
      const loads: Promise<OsmElement[]>[] = [];
      const ring: Promise<OsmElement[]>[] = [];
      for (let x = r.x0 - 1; x <= r.x1 + 1; x++) {
        for (let y = r.y0 - 1; y <= r.y1 + 1; y++) {
          const inside = x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
          (inside ? loads : ring).push(this.tile({ z: ZOOM, x, y }));
        }
      }
      // Bridges from the surrounding tiles too, so bridges cut by tile borders get their full span.
      const bridgesAround = Promise.all(ring.map((p) => p.catch(() => [] as OsmElement[]))).then((parts) =>
        parts.flat().filter((e) => e.type === 'way' && e.tags?.bridge),
      );
      chunker = Promise.all([...loads, bridgesAround]).then((parts) => new OsmChunker(this.proj, parts.flat()));
      chunker.catch(() => this.chunkers.delete(key));
      this.chunkers.set(key, chunker);
      while (this.chunkers.size > 8) this.chunkers.delete(this.chunkers.keys().next().value!);
    }
    return (await chunker).chunk(cx, cz);
  }

  private tile(t: TileCoord): Promise<OsmElement[]> {
    const key = `${t.x}/${t.y}`;
    let p = this.tiles.get(key);
    if (p) {
      // Refresh LRU position.
      this.tiles.delete(key);
      this.tiles.set(key, p);
      return p;
    }
    p = this.fetchTile(t);
    p.catch(() => this.tiles.delete(key));
    this.tiles.set(key, p);
    while (this.tiles.size > MAX_CACHED_TILES) this.tiles.delete(this.tiles.keys().next().value!);
    return p;
  }

  private async fetchTile(t: TileCoord): Promise<OsmElement[]> {
    const template = await this.tileTemplate();
    const url = template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 404 || res.status === 204) return []; // empty (e.g. open sea)
        if (!res.ok) throw new Error(`tile ${t.x},${t.y}: HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        return mvtToOsm(buf, t, () => this.idCounter--);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private tileTemplate(): Promise<string> {
    if (!this.template) {
      this.template = fetch(TILEJSON_URL)
        .then((r) => r.json())
        .then((j: { tiles: string[] }) => j.tiles[0]);
      this.template.catch(() => (this.template = null));
    }
    return this.template;
  }
}
