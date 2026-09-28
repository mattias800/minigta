import { CHUNK_SIZE, DATA_VERSION, DEFAULT_ORIGIN } from '../config';
import type { Projection } from '../geo/projection';
import { chunkKey, type ChunkData } from './chunkTypes';
import { VectorTileSource } from './mvt/VectorTileSource';

interface Manifest {
  v: number;
  origin: { lat: number; lon: number };
  chunkSize: number;
  bounds: { minCx: number; maxCx: number; minCz: number; maxCz: number };
}

/** Bump when the live conversion changes, so browsers don't reuse stale cached chunks. */
const LIVE_CACHE_TAG = 'mvt1';

/**
 * Provides chunk data: pre-baked chunks (from Overpass, richest data) shipped with the game where
 * available, otherwise streamed live from OSM vector tiles and cached in IndexedDB.
 */
export class ChunkSource {
  private manifest: Manifest | null = null;
  private readonly cache = new ChunkCache();
  private readonly live: VectorTileSource;
  /** Number of live chunk loads in flight (for the loading indicator). */
  liveRequests = 0;
  lastError: string | null = null;

  constructor(private readonly proj: Projection) {
    this.live = new VectorTileSource(proj);
  }

  async init() {
    const o = this.proj.origin;
    if (o.lat !== DEFAULT_ORIGIN.lat || o.lon !== DEFAULT_ORIGIN.lon) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/manifest.json`);
      if (res.ok) {
        const m = (await res.json()) as Manifest;
        if (m.v === DATA_VERSION && m.chunkSize === CHUNK_SIZE) this.manifest = m;
      }
    } catch {
      // No baked data; everything will stream live.
    }
  }

  isBaked(cx: number, cz: number): boolean {
    const b = this.manifest?.bounds;
    return !!b && cx >= b.minCx && cx <= b.maxCx && cz >= b.minCz && cz <= b.maxCz;
  }

  async load(cx: number, cz: number): Promise<ChunkData> {
    if (this.isBaked(cx, cz)) {
      const res = await fetch(`${import.meta.env.BASE_URL}data/chunks/${chunkKey(cx, cz)}.json`);
      if (!res.ok) throw new Error(`chunk ${cx},${cz}: HTTP ${res.status}`);
      return (await res.json()) as ChunkData;
    }
    const cacheKey = this.cacheKey(cx, cz);
    const cached = await this.cache.get(cacheKey);
    if (cached && cached.v === DATA_VERSION) return cached;
    this.liveRequests++;
    try {
      const chunk = await this.live.chunk(cx, cz);
      this.lastError = null;
      void this.cache.set(cacheKey, chunk);
      return chunk;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.liveRequests--;
    }
  }

  private cacheKey(cx: number, cz: number) {
    const o = this.proj.origin;
    return `${LIVE_CACHE_TAG}:${o.lat.toFixed(5)},${o.lon.toFixed(5)}:${chunkKey(cx, cz)}`;
  }
}

/** Minimal promise wrapper around an IndexedDB object store. Failures degrade to "no cache". */
class ChunkCache {
  private db: Promise<IDBDatabase | null>;

  constructor() {
    this.db = new Promise((resolve) => {
      try {
        const req = indexedDB.open('minigta-chunks', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('chunks');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async get(key: string): Promise<ChunkData | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const req = db.transaction('chunks').objectStore('chunks').get(key);
        req.onsuccess = () => resolve(req.result as ChunkData | undefined);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async set(key: string, value: ChunkData): Promise<void> {
    const db = await this.db;
    if (!db) return;
    try {
      db.transaction('chunks', 'readwrite').objectStore('chunks').put(value, key);
    } catch {
      // Quota or private mode; ignore.
    }
  }
}
