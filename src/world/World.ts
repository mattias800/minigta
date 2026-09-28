import * as THREE from 'three';
import { CHUNK_LOAD_RADIUS, CHUNK_SIZE, CHUNK_UNLOAD_RADIUS } from '../config';
import { pointInPolygon, ringBounds, type Rect } from '../geo/polygon';
import type { Projection } from '../geo/projection';
import { ChunkMesher, type ChunkMeshes } from '../render/ChunkMesher';
import { WorldMaterials } from '../render/WorldMaterials';
import { renderMapTile } from '../ui/minimapTiles';
import { chunkKey, type AreaData, type ChunkData, type PlaceData } from './chunkTypes';
import { ChunkSource } from './ChunkSource';
import { lampsForChunk, treesForChunk } from './decorations';
import { RoadNetwork } from './RoadNetwork';
import { StaticCollision } from './StaticCollision';

interface LoadedChunk {
  key: string;
  data: ChunkData;
  meshes: ChunkMeshes;
  water: (AreaData & { bounds: Rect })[];
  piers: (AreaData & { bounds: Rect })[];
  mapTile: HTMLCanvasElement | null;
}

export type Surface = 'ground' | 'water';

/**
 * The static world: streams chunks around a focus point and owns everything derived from map data
 * (meshes, collision, road graph, minimap tiles).
 */
export class World {
  readonly group = new THREE.Group();
  readonly collision = new StaticCollision();
  readonly roads = new RoadNetwork();
  /** Tram tracks as a graph (edges are track segments). */
  readonly tramTracks = new RoadNetwork();
  readonly source: ChunkSource;
  readonly materials = new WorldMaterials();
  private readonly mesher = new ChunkMesher(this.materials);
  private readonly loaded = new Map<string, LoadedChunk>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly ready: ChunkData[] = [];
  private readonly failed = new Map<string, number>();
  private time = 0;
  private initialized = false;

  constructor(readonly projection: Projection) {
    this.source = new ChunkSource(projection);
    this.group.name = 'world';
  }

  async init() {
    await this.source.init();
    this.initialized = true;
  }

  /** Streams chunks around (x, z). `buildBudgetMs` limits main-thread mesh building per call. */
  update(dt: number, x: number, z: number, buildBudgetMs = 6) {
    this.time += dt;
    this.materials.update(this.time);
    // Don't request anything before we know which chunks are pre-baked.
    if (!this.initialized) return;
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);

    // Request missing chunks, nearest first.
    const wanted: { cx: number; cz: number; d: number }[] = [];
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const k = chunkKey(cx, cz);
        if (this.loaded.has(k) || this.loading.has(k)) continue;
        if ((this.failed.get(k) ?? 0) > this.time) continue;
        // Distance from the player to the chunk center.
        wanted.push({ cx, cz, d: Math.hypot((cx + 0.5) * CHUNK_SIZE - x, (cz + 0.5) * CHUNK_SIZE - z) });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    for (const w of wanted) this.request(w.cx, w.cz);

    // Build ready chunks within the time budget (always at least one).
    const start = performance.now();
    this.ready.sort((a, b) => chunkDist(a, x, z) - chunkDist(b, x, z));
    while (this.ready.length && (performance.now() - start < buildBudgetMs || this.loaded.size === 0)) {
      const data = this.ready.shift()!;
      const k = chunkKey(data.cx, data.cz);
      if (Math.max(Math.abs(data.cx - pcx), Math.abs(data.cz - pcz)) > CHUNK_UNLOAD_RADIUS) continue;
      this.add(k, data);
    }

    for (const [k, c] of this.loaded) {
      if (Math.max(Math.abs(c.data.cx - pcx), Math.abs(c.data.cz - pcz)) > CHUNK_UNLOAD_RADIUS) this.remove(k);
    }
  }

  private request(cx: number, cz: number) {
    const k = chunkKey(cx, cz);
    const p = this.source
      .load(cx, cz)
      .then((data) => {
        this.ready.push(data);
      })
      .catch((e) => {
        console.warn(`Failed to load chunk ${k}:`, e);
        this.failed.set(k, this.time + 10);
      })
      .finally(() => this.loading.delete(k));
    this.loading.set(k, p);
  }

  private add(key: string, data: ChunkData) {
    const trees = treesForChunk(data);
    const lamps = lampsForChunk(data);
    const meshes = this.mesher.build(data, trees, lamps);
    this.group.add(meshes.group);

    for (const b of data.buildings) {
      if (b.roofOnly) continue;
      for (const ring of [b.outer, ...(b.holes ?? [])]) {
        const n = ring.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          this.collision.addWall(key, ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], b.height);
        }
      }
    }
    for (const t of trees) this.collision.addPost(key, t.x, t.z, 0.3 * t.scale, 6 * t.scale);
    for (const l of lamps) this.collision.addPost(key, l.x, l.z, 0.14, 5.5);
    this.roads.addRoads(key, data.roads);
    this.tramTracks.addRoads(
      key,
      data.rails
        .filter((r) => r.kind === 'tram' && r.nodes?.length === r.pts.length / 2)
        .map((r) => ({ id: r.id, kind: 'service' as const, pts: r.pts, nodes: r.nodes, width: 2.6, lanes: 1, oneway: false })),
    );

    const withBounds = (a: AreaData) => ({ ...a, bounds: ringBounds(a.outer) });
    this.loaded.set(key, {
      key,
      data,
      meshes,
      water: data.areas.filter((a) => a.kind === 'water').map(withBounds),
      piers: data.areas.filter((a) => a.kind === 'pier').map(withBounds),
      mapTile: null,
    });
    // Neighbouring map tiles may include features of this chunk.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const n = this.loaded.get(chunkKey(data.cx + dx, data.cz + dz));
        if (n) n.mapTile = null;
      }
    }
  }

  private remove(key: string) {
    const c = this.loaded.get(key);
    if (!c) return;
    this.group.remove(c.meshes.group);
    c.meshes.dispose();
    this.collision.removeOwner(key);
    this.roads.removeOwner(key);
    this.tramTracks.removeOwner(key);
    this.loaded.delete(key);
  }

  isChunkLoaded(x: number, z: number): boolean {
    return this.loaded.has(chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }

  /** Fraction of chunks within the load radius around (x, z) that are loaded, 0..1. */
  loadProgress(x: number, z: number, radius = 1): number {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    let total = 0;
    let done = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        total++;
        if (this.loaded.has(chunkKey(pcx + dx, pcz + dz))) done++;
      }
    }
    return done / total;
  }

  surfaceAt(x: number, z: number): Surface {
    const c = this.loaded.get(chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
    if (!c || !c.water.length) return 'ground';
    const inside = (a: AreaData & { bounds: Rect }) =>
      x >= a.bounds.minX && x <= a.bounds.maxX && z >= a.bounds.minZ && z <= a.bounds.maxZ && pointInPolygon(x, z, a.outer, a.holes);
    if (!c.water.some(inside)) return 'ground';
    if (c.piers.some(inside)) return 'ground';
    if (this.roads.isOnRoad(x, z, 0.5)) return 'ground';
    return 'water';
  }

  /** Nearest named place (district) among loaded chunks. */
  nearestPlace(x: number, z: number): PlaceData | null {
    let best: PlaceData | null = null;
    let bestD = Infinity;
    for (const c of this.loaded.values()) {
      for (const p of c.data.places) {
        // Neighbourhoods are more specific than suburbs, so prefer them slightly.
        const d = Math.hypot(p.x - x, p.z - z) * (p.kind === 'suburb' ? 1.6 : 1);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
    }
    return best;
  }

  /** Minimap tile image for a chunk, (re)rendered lazily. Returns null if the chunk isn't loaded. */
  mapTile(cx: number, cz: number): HTMLCanvasElement | null {
    const c = this.loaded.get(chunkKey(cx, cz));
    if (!c) return null;
    if (!c.mapTile) {
      const around: ChunkData[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const n = this.loaded.get(chunkKey(cx + dx, cz + dz));
          if (n) around.push(n.data);
        }
      }
      c.mapTile = renderMapTile(cx, cz, around);
    }
    return c.mapTile;
  }

  loadedChunks(): Iterable<{ cx: number; cz: number }> {
    return [...this.loaded.values()].map((c) => ({ cx: c.data.cx, cz: c.data.cz }));
  }

  get pendingLive(): number {
    return this.source.liveRequests;
  }
}

function chunkDist(c: ChunkData, x: number, z: number) {
  return Math.hypot((c.cx + 0.5) * CHUNK_SIZE - x, (c.cz + 0.5) * CHUNK_SIZE - z);
}
