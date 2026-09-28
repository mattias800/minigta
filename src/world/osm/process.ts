import { CHUNK_SIZE, DATA_VERSION } from '../../config';
import type { Projection } from '../../geo/projection';
import {
  centroid,
  cleanRing,
  clipRingToRect,
  joinRings,
  pointInRing,
  rectsOverlap,
  ringBounds,
  type Flat,
  type Rect,
} from '../../geo/polygon';
import {
  chunkKey,
  type BridgeSpan,
  type AreaData,
  type AreaKind,
  type BuildingData,
  type ChunkData,
  type PlaceData,
  type RailData,
  type RoadData,
  type RoadKind,
} from '../chunkTypes';
import type { OsmElement, OsmPoint, OsmRelation, OsmTags, OsmWay } from './types';

/**
 * Turns raw Overpass elements into per-chunk game data.
 *
 * Every feature belongs to exactly one chunk, so chunks can be loaded and unloaded independently:
 * - buildings, trees and places belong to the chunk containing their centroid/position,
 * - roads and rails are split at OSM nodes, each segment belonging to the chunk containing its midpoint
 *   (pieces keep OSM node ids so the road graph reconnects across chunks),
 * - areas (water, parks, ...) are clipped to every chunk they overlap.
 */
export class OsmChunker {
  private readonly buildings: BuildingData[] = [];
  private readonly roads: RoadData[] = [];
  private readonly rails: RailData[] = [];
  private readonly areas: (AreaData & { bounds: Rect })[] = [];
  private readonly trees: number[] = [];
  private readonly places: PlaceData[] = [];

  constructor(
    private readonly proj: Projection,
    elements: OsmElement[],
  ) {
    const seen = new Set<string>();
    for (const el of elements) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (el.type === 'node') {
        const t = el.tags ?? {};
        const p = proj.toWorld(el.lat, el.lon);
        if (t.natural === 'tree') this.trees.push(round(p.x), round(p.z));
        else if (t.place && t.name) this.places.push({ name: t.name, kind: t.place, x: round(p.x), z: round(p.z) });
      } else if (el.type === 'way') {
        this.addWay(el);
      } else {
        this.addRelation(el);
      }
    }
  }

  /** Builds the data for a single chunk (used for live fetching of one chunk). */
  chunk(cx: number, cz: number): ChunkData {
    return this.buildAll(new Set([chunkKey(cx, cz)])).get(chunkKey(cx, cz)) ?? emptyChunk(cx, cz);
  }

  /**
   * Distributes all features into chunks. If `only` is given, only those chunk keys are produced.
   */
  buildAll(only?: Set<string>): Map<string, ChunkData> {
    const out = new Map<string, ChunkData>();
    const get = (cx: number, cz: number): ChunkData | undefined => {
      const k = chunkKey(cx, cz);
      if (only && !only.has(k)) return undefined;
      let c = out.get(k);
      if (!c) {
        c = emptyChunk(cx, cz);
        out.set(k, c);
      }
      return c;
    };
    const idx = (v: number) => Math.floor(v / CHUNK_SIZE);

    for (const b of this.buildings) {
      const c = centroid(b.outer);
      get(idx(c.x), idx(c.z))?.buildings.push(b);
    }
    for (let i = 0; i < this.trees.length; i += 2) {
      get(idx(this.trees[i]), idx(this.trees[i + 1]))?.trees.push(this.trees[i], this.trees[i + 1]);
    }
    for (const p of this.places) get(idx(p.x), idx(p.z))?.places.push(p);

    this.computeBridgeSpans(this.roads);
    this.computeBridgeSpans(this.rails);
    for (const r of this.roads) for (const piece of splitLine(r)) get(piece.cx, piece.cz)?.roads.push(piece.line);
    for (const r of this.rails) for (const piece of splitLine(r)) get(piece.cx, piece.cz)?.rails.push(piece.line);

    for (const a of this.areas) {
      const b = a.bounds;
      for (let cx = idx(b.minX); cx <= idx(b.maxX); cx++) {
        for (let cz = idx(b.minZ); cz <= idx(b.maxZ); cz++) {
          const k = chunkKey(cx, cz);
          if (only && !only.has(k)) continue;
          const rect = chunkRect(cx, cz);
          const outer = roundFlat(cleanRing(clipRingToRect(a.outer, rect)));
          if (outer.length < 6) continue;
          const holes = a.holes
            ?.filter((h) => rectsOverlap(ringBounds(h), rect))
            .map((h) => roundFlat(cleanRing(clipRingToRect(h, rect))))
            .filter((h) => h.length >= 6);
          const area: AreaData = { kind: a.kind, outer };
          if (holes && holes.length) area.holes = holes;
          get(cx, cz)?.areas.push(area);
        }
      }
    }
    return out;
  }

  /**
   * Stitches bridge ways that share end nodes into chains (a long bridge is often several ways) and
   * gives every way its span: chain end points, length, its offset along the chain, and an arch if the
   * bridge crosses water.
   */
  private computeBridgeSpans(lines: Linear[]) {
    const bridges = lines.filter((r) => r.bridge && !r.span);
    const byEnd = new Map<number, Linear[]>();
    for (const r of bridges) {
      for (const n of [r.nodes[0], r.nodes[r.nodes.length - 1]]) {
        let list = byEnd.get(n);
        if (!list) byEnd.set(n, (list = []));
        list.push(r);
      }
    }
    const lengthOf = (r: Linear) => {
      let l = 0;
      for (let i = 0; i + 3 < r.pts.length; i += 2) l += Math.hypot(r.pts[i + 2] - r.pts[i], r.pts[i + 3] - r.pts[i + 1]);
      return l;
    };
    const done = new Set<Linear>();
    const water = this.areas.filter((a) => a.kind === 'water');
    for (const seed of bridges) {
      if (done.has(seed)) continue;
      // Walk backwards from the seed to the chain start, then forwards collecting (way, reversed).
      let startWay = seed;
      let startNode = seed.nodes[0];
      const visited = new Set<Linear>([seed]);
      for (;;) {
        const prev = (byEnd.get(startNode) ?? []).find((r) => !visited.has(r));
        if (!prev || (byEnd.get(startNode)?.length ?? 0) > 2) break;
        visited.add(prev);
        startWay = prev;
        startNode = prev.nodes[0] === startNode ? prev.nodes[prev.nodes.length - 1] : prev.nodes[0];
      }
      const chain: { r: Linear; reversed: boolean }[] = [];
      let node = startNode;
      let cur: Linear | undefined = startWay;
      while (cur && !done.has(cur)) {
        done.add(cur);
        const reversed = cur.nodes[0] !== node;
        chain.push({ r: cur, reversed });
        node = reversed ? cur.nodes[0] : cur.nodes[cur.nodes.length - 1];
        const options: Linear[] = byEnd.get(node) ?? [];
        cur = options.length === 2 ? options.find((r) => !done.has(r)) : undefined;
      }
      let total = 0;
      const offsets: number[] = [];
      for (const c of chain) {
        offsets.push(total);
        total += lengthOf(c.r);
      }
      const first = chain[0];
      const last = chain[chain.length - 1];
      const fp = first.r.pts;
      const lp = last.r.pts;
      const ax = first.reversed ? fp[fp.length - 2] : fp[0];
      const az = first.reversed ? fp[fp.length - 1] : fp[1];
      const bx = last.reversed ? lp[0] : lp[lp.length - 2];
      const bz = last.reversed ? lp[1] : lp[lp.length - 1];
      const overWater = chain.some((c) => {
        for (let i = 0; i < c.r.pts.length; i += 2) {
          const x = c.r.pts[i];
          const z = c.r.pts[i + 1];
          if (water.some((a) => x >= a.bounds.minX && x <= a.bounds.maxX && z >= a.bounds.minZ && z <= a.bounds.maxZ && pointInRing(x, z, a.outer))) return true;
        }
        return false;
      });
      const arch = overWater ? Math.min(20, Math.max(2, total * 0.025)) : 0;
      chain.forEach((c, i) => {
        const len = lengthOf(c.r);
        c.r.span = {
          ax: round(ax),
          az: round(az),
          bx: round(bx),
          bz: round(bz),
          length: round(total),
          arch: round(arch),
          // Distance at the way's first vertex.
          start: round(c.reversed ? offsets[i] + len : offsets[i]),
          dir: c.reversed ? -1 : 1,
        };
      });
    }
  }

  // ---------------------------------------------------------------------------------------------

  private project(geom: (OsmPoint | null)[]): Flat {
    const out: Flat = [];
    for (const p of geom) {
      if (!p) continue;
      const w = this.proj.toWorld(p.lat, p.lon);
      out.push(w.x, w.z);
    }
    return out;
  }

  private addWay(w: OsmWay) {
    const t = w.tags;
    if (!t || !w.geometry || w.geometry.length < 2) return;
    const closed = w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];

    if (t.building && t.building !== 'no' && !t['building:part']) {
      if (!closed || isUnderground(t)) return;
      const outer = roundFlat(cleanRing(this.project(w.geometry)));
      if (outer.length >= 6) this.buildings.push(makeBuilding(w.id, t, outer));
      return;
    }

    if (t.highway) {
      if (t.area === 'yes') {
        const areaKind = closed ? areaKindOf(t) : null;
        if (areaKind) this.addArea(areaKind, [this.project(w.geometry)], []);
        return;
      }
      const road = makeRoad(w, this.project(w.geometry));
      if (road) this.roads.push(road);
      return;
    }

    if (t.railway) {
      if (t.tunnel === 'yes' || isUnderground(t)) return;
      const kind = t.railway === 'rail' ? 'rail' : t.railway === 'subway' ? null : 'tram';
      if (!kind) return;
      const rail: RailData = { id: w.id, kind, pts: roundFlat(this.project(w.geometry)), nodes: w.nodes.slice() };
      if (t.bridge && t.bridge !== 'no') rail.bridge = true;
      this.rails.push(rail);
      return;
    }

    if (closed) {
      const kind = areaKindOf(t);
      if (kind) this.addArea(kind, [this.project(w.geometry)], []);
    }
  }

  private addRelation(r: OsmRelation) {
    const t = r.tags ?? {};
    const outerFrags: Flat[] = [];
    const innerFrags: Flat[] = [];
    for (const m of r.members) {
      if (m.type !== 'way' || !m.geometry) continue;
      const pts = this.project(m.geometry);
      if (m.role === 'inner') innerFrags.push(pts);
      else outerFrags.push(pts);
    }
    const outers = joinRings(outerFrags, 1e-3);
    const inners = joinRings(innerFrags, 1e-3);
    if (!outers.length) return;

    if (t.building && t.building !== 'no') {
      if (isUnderground(t)) return;
      for (const o of outers) {
        const holes = inners.filter((h) => pointInRing(h[0], h[1], o)).map((h) => roundFlat(h));
        const b = makeBuilding(r.id, t, roundFlat(o));
        if (holes.length) b.holes = holes;
        this.buildings.push(b);
      }
      return;
    }
    const kind = areaKindOf(t);
    if (kind) this.addArea(kind, outers, inners);
  }

  private addArea(kind: AreaKind, outers: Flat[], inners: Flat[]) {
    for (const raw of outers) {
      const o = cleanRing(raw);
      if (o.length < 6) continue;
      const holes = inners.filter((h) => pointInRing(h[0], h[1], o));
      this.areas.push({ kind, outer: o, holes: holes.length ? holes : undefined, bounds: ringBounds(o) });
    }
  }
}

// -----------------------------------------------------------------------------------------------

function emptyChunk(cx: number, cz: number): ChunkData {
  return { v: DATA_VERSION, cx, cz, buildings: [], roads: [], areas: [], rails: [], trees: [], places: [] };
}

export function chunkRect(cx: number, cz: number): Rect {
  return { minX: cx * CHUNK_SIZE, minZ: cz * CHUNK_SIZE, maxX: (cx + 1) * CHUNK_SIZE, maxZ: (cz + 1) * CHUNK_SIZE };
}

const round = (v: number) => Math.round(v * 10) / 10;
const roundFlat = (f: Flat) => f.map(round);

function isUnderground(t: OsmTags): boolean {
  const layer = parseFloat(t.layer ?? '0');
  return t.location === 'underground' || t.tunnel === 'yes' || (layer < 0 && t.covered !== 'no');
}

/** Parses OSM length values like "12", "12.5 m", "40'"; returns NaN if unparseable. */
export function parseLength(v: string | undefined): number {
  if (!v) return NaN;
  const m = /^\s*(-?[\d.]+)\s*(m|ft|')?/.exec(v.replace(',', '.'));
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}

function hash01(id: number): number {
  let h = id | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const LOW_BUILDINGS = new Set([
  'house', 'detached', 'semidetached_house', 'terrace', 'garage', 'garages', 'shed', 'hut', 'cabin', 'kiosk',
  'carport', 'bungalow', 'farm_auxiliary', 'greenhouse', 'toilets', 'service', 'container', 'boathouse',
]);

function makeBuilding(id: number, t: OsmTags, outer: Flat): BuildingData {
  const kind = t.building ?? 'yes';
  let height = parseLength(t.height);
  const levels = parseFloat(t['building:levels'] ?? '');
  const roofLevels = parseFloat(t['roof:levels'] ?? '');
  if (!(height > 0) && levels > 0) height = levels * 3.1 + (roofLevels > 0 ? roofLevels * 2.2 : 1);
  if (!(height > 0)) {
    const r = hash01(id);
    if (LOW_BUILDINGS.has(kind)) height = 3 + r * 4;
    else if (kind === 'church' || kind === 'cathedral') height = 18 + r * 10;
    else if (kind === 'industrial' || kind === 'warehouse') height = 8 + r * 6;
    else height = 12 + r * 9;
  }
  let minHeight = parseLength(t.min_height);
  const minLevel = parseFloat(t['building:min_level'] ?? '');
  if (!(minHeight > 0) && minLevel > 0) minHeight = minLevel * 3.1;
  if (!(minHeight > 0)) minHeight = 0;
  const roofOnly = kind === 'roof' || minHeight > 2.5;
  if (kind === 'roof' && minHeight === 0) minHeight = Math.max(2.8, height - 1);
  if (minHeight >= height) height = minHeight + 1;

  const b: BuildingData = {
    id,
    outer,
    height: round(Math.min(height, 400)),
    minHeight: round(minHeight),
    kind,
  };
  if (t['building:colour']) b.color = t['building:colour'];
  if (t['roof:colour']) b.roofColor = t['roof:colour'];
  if (t.name) b.name = t.name;
  if (roofOnly) b.roofOnly = true;
  return b;
}

const HIGHWAY_KIND: Record<string, RoadKind> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'motorway',
  trunk_link: 'motorway',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  unclassified: 'residential',
  residential: 'residential',
  living_street: 'residential',
  road: 'residential',
  service: 'service',
  pedestrian: 'pedestrian',
  footway: 'footway',
  path: 'footway',
  track: 'footway',
  bridleway: 'footway',
  corridor: 'footway',
  cycleway: 'cycleway',
  steps: 'steps',
};

const LANE_WIDTH = 3.3;
const DEFAULT_WIDTH: Record<RoadKind, number> = {
  motorway: 2 * LANE_WIDTH,
  primary: 4 * LANE_WIDTH,
  secondary: 3 * LANE_WIDTH,
  tertiary: 2.4 * LANE_WIDTH,
  residential: 2 * LANE_WIDTH,
  service: 4,
  pedestrian: 6,
  footway: 2.2,
  cycleway: 2.2,
  steps: 2.5,
};

function makeRoad(w: OsmWay, pts: Flat): RoadData | null {
  const t = w.tags!;
  const kind = HIGHWAY_KIND[t.highway];
  if (!kind) return null;
  if (t.tunnel === 'yes' || (isUnderground(t) && t.bridge !== 'yes')) return null;
  if (t.indoor === 'yes' || (t.level !== undefined && parseFloat(t.level) < 0)) return null;

  let nodes = w.nodes.slice();
  let oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' ||
    t.highway === 'motorway' || t.highway === 'motorway_link' || t.junction === 'circular';
  if (t.oneway === '-1' || t.oneway === 'reverse') {
    oneway = true;
    const rev: Flat = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
    pts = rev;
    nodes = nodes.reverse();
  }
  if (t.oneway === 'no') oneway = false;
  if (kind === 'footway' || kind === 'cycleway' || kind === 'steps' || kind === 'pedestrian') oneway = false;

  let lanes = parseInt(t.lanes ?? '', 10);
  if (!(lanes > 0)) lanes = oneway ? (kind === 'motorway' ? 2 : 1) : kind === 'primary' ? 4 : 2;
  let width = parseLength(t.width);
  if (!(width > 1)) {
    width = parseInt(t.lanes ?? '', 10) > 0 && isDrivable(kind) ? lanes * LANE_WIDTH : DEFAULT_WIDTH[kind];
    if (oneway && isDrivable(kind) && !t.lanes) width = Math.max(LANE_WIDTH * 1.4, width / 2 + 1);
  }
  width = Math.min(width, 30);

  const road: RoadData = { id: w.id, kind, pts: roundFlat(pts), nodes, width: round(width), lanes, oneway };
  if (t.bridge && t.bridge !== 'no') road.bridge = true;
  if (t.name) road.name = t.name;
  return road;
}

export function isDrivable(kind: RoadKind): boolean {
  return (
    kind === 'motorway' ||
    kind === 'primary' ||
    kind === 'secondary' ||
    kind === 'tertiary' ||
    kind === 'residential' ||
    kind === 'service'
  );
}

function areaKindOf(t: OsmTags): AreaKind | null {
  const n = t.natural;
  const l = t.landuse;
  const le = t.leisure;
  if (n === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.waterway === 'canal' || l === 'basin' || l === 'reservoir' || le === 'marina') {
    return 'water';
  }
  if (t.man_made === 'pier' || t.man_made === 'bridge') return 'pier';
  if (t.highway === 'pedestrian' || t.highway === 'footway' || t.place === 'square') return 'plaza';
  if (t.amenity === 'parking') return 'parking';
  if (le === 'park' || le === 'garden' || le === 'common' || le === 'nature_reserve' || l === 'recreation_ground' || l === 'village_green') {
    return 'park';
  }
  if (le === 'pitch' || le === 'playground') return 'pitch';
  if (l === 'forest' || n === 'wood' || n === 'scrub' || n === 'wetland') return 'forest';
  if (l === 'grass' || l === 'meadow' || l === 'cemetery' || l === 'allotments' || l === 'orchard' || l === 'farmland' || n === 'grassland' || n === 'heath' || l === 'flowerbed') {
    return 'grass';
  }
  if (n === 'beach' || n === 'sand' || n === 'bare_rock') return 'sand';
  if (l === 'industrial' || l === 'port' || l === 'construction' || l === 'brownfield' || l === 'depot') return 'industrial';
  if (l === 'railway') return 'railway';
  if (l === 'residential') return 'residential';
  if (l === 'commercial' || l === 'retail') return 'commercial';
  return null;
}

/** Shared shape of roads and rails. */
type Linear = { pts: Flat; nodes: number[]; bridge?: boolean; span?: BridgeSpan };

/** Splits a road/rail into chunk pieces, carrying the bridge span offset along. */
function splitLine<T extends Linear>(r: T): { cx: number; cz: number; line: T }[] {
  const out: { cx: number; cz: number; line: T }[] = [];
  let dist = 0;
  let vertex = 0;
  for (const piece of splitByChunk(r.pts, r.nodes)) {
    // Advance to the piece's first vertex to know how far along the bridge it starts.
    while (vertex < piece.firstVertex) {
      dist += Math.hypot(r.pts[vertex * 2 + 2] - r.pts[vertex * 2], r.pts[vertex * 2 + 3] - r.pts[vertex * 2 + 1]);
      vertex++;
    }
    const line: T = { ...r, pts: piece.pts, nodes: piece.nodes };
    if (r.span) line.span = { ...r.span, start: round(r.span.start + r.span.dir * dist) };
    out.push({ cx: piece.cx, cz: piece.cz, line });
  }
  return out;
}

/** Splits a polyline at its vertices into consecutive runs whose segment midpoints share a chunk. */
function splitByChunk(pts: Flat, nodes: number[] | null): { cx: number; cz: number; pts: Flat; nodes: number[]; firstVertex: number }[] {
  const out: { cx: number; cz: number; pts: Flat; nodes: number[]; firstVertex: number }[] = [];
  let cur: { cx: number; cz: number; pts: Flat; nodes: number[]; firstVertex: number } | null = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const mz = (pts[i + 1] + pts[i + 3]) / 2;
    const cx = Math.floor(mx / CHUNK_SIZE);
    const cz = Math.floor(mz / CHUNK_SIZE);
    const ni = i / 2;
    if (!cur || cur.cx !== cx || cur.cz !== cz) {
      cur = { cx, cz, pts: [pts[i], pts[i + 1]], nodes: nodes ? [nodes[ni]] : [], firstVertex: ni };
      out.push(cur);
    }
    cur.pts.push(pts[i + 2], pts[i + 3]);
    if (nodes) cur.nodes.push(nodes[ni + 1]);
  }
  return out;
}
