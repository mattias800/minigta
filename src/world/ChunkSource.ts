import { CHUNK_SIZE, DATA_VERSION, DEFAULT_ORIGIN } from '../config';
import type { Projection } from '../geo/projection';
import { chunkKey, type ChunkData } from './chunkTypes';
import { fetchOverpass } from './osm/overpass';
import { OsmChunker } from './osm/process';

interface Manifest {
  v: number;
  origin: { lat: number; lon: number };
  chunkSize: number;
  bounds: { minCx: number; maxCx: number; minCz: number; maxCz: number };
}

/** Live fetches are grouped into blocks of BLOCK x BLOCK chunks to keep Overpass request counts down. */
const BLOCK = 3;

/**
 * Provides chunk data: pre-baked chunks shipped with the game where available, otherwise streamed
 * live from the Overpass API and cached in IndexedDB.
 */
export class ChunkSource {
  private manifest: Manifest | null = null;
  private readonly cache = new ChunkCache();
  private readonly pendingBlocks = new Map<string, Promise<Map<string, ChunkData>>>();
  private liveQueue: Promise<unknown> = Promise.resolve();
  /** Number of live Overpass requests in flight or queued (for the loading indicator). */
  liveRequests = 0;
  lastError: string | null = null;

  constructor(private readonly proj: Projection) {}

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
    const block = await this.loadBlock(Math.floor(cx / BLOCK), Math.floor(cz / BLOCK));
    return block.get(chunkKey(cx, cz)) ?? emptyChunk(cx, cz);
  }

  private cacheKey(cx: number, cz: number) {
    const o = this.proj.origin;
    return `${o.lat.toFixed(5)},${o.lon.toFixed(5)}:${chunkKey(cx, cz)}`;
  }

  private loadBlock(bx: number, bz: number): Promise<Map<string, ChunkData>> {
    const key = `${bx}_${bz}`;
    let p = this.pendingBlocks.get(key);
    if (p) return p;
    this.liveRequests++;
    // Serialize requests: public Overpass instances only allow a couple of concurrent queries per IP.
    p = this.liveQueue.then(async () => {
      try {
        const minX = bx * BLOCK * CHUNK_SIZE;
        const minZ = bz * BLOCK * CHUNK_SIZE;
        const bbox = this.proj.bboxOf(minX, minZ, minX + BLOCK * CHUNK_SIZE, minZ + BLOCK * CHUNK_SIZE);
        const data = await fetchOverpass(bbox, { attemptsPerEndpoint: 3 });
        const wanted = new Set<string>();
        for (let i = 0; i < BLOCK; i++) for (let j = 0; j < BLOCK; j++) wanted.add(chunkKey(bx * BLOCK + i, bz * BLOCK + j));
        const chunks = new OsmChunker(this.proj, data.elements).buildAll(wanted);
        for (const k of wanted) {
          const [cx, cz] = k.split('_').map(Number);
          if (!chunks.has(k)) chunks.set(k, emptyChunk(cx, cz));
          void this.cache.set(this.cacheKey(cx, cz), chunks.get(k)!);
        }
        this.lastError = null;
        return chunks;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.pendingBlocks.delete(key);
        throw e;
      } finally {
        this.liveRequests--;
      }
    });
    this.liveQueue = p.catch(() => undefined);
    this.pendingBlocks.set(key, p);
    return p;
  }
}

function emptyChunk(cx: number, cz: number): ChunkData {
  return { v: DATA_VERSION, cx, cz, buildings: [], roads: [], areas: [], rails: [], trees: [], places: [] };
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
