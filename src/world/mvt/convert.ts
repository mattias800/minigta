import { classifyRings, VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clipPolylineToRect, clipRingToRect, closestPointOnSegment, type Flat } from '../../geo/polygon';
import type { OsmElement, OsmPoint, OsmTags } from '../osm/types';

/**
 * Converts OpenMapTiles-schema vector tiles (as served by OpenFreeMap) into OSM-like elements, so the
 * same OsmChunker pipeline that handles Overpass data can turn them into game chunks.
 *
 * Geometry is clipped to the exact tile bounds (tiles carry a buffer that would otherwise double up
 * features), and road vertices get ids derived from their global pixel position so that roads from
 * neighbouring tiles connect in the road graph.
 */

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Global pixel → lat/lon (web mercator). */
function toLatLon(gx: number, gy: number, worldSize: number): OsmPoint {
  const lon = (gx / worldSize) * 360 - 180;
  const n = Math.PI * (1 - (2 * gy) / worldSize);
  return { lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI, lon };
}

/** Negative ids keep synthetic vertices clear of real OSM node ids. */
export const vertexId = (gx: number, gy: number) => -(Math.round(gx) * 0x4000000 + Math.round(gy));

const ROAD_CLASS: Record<string, string> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  service: 'service',
  track: 'track',
};

const PATH_SUBCLASS: Record<string, string> = {
  footway: 'footway',
  cycleway: 'cycleway',
  steps: 'steps',
  pedestrian: 'pedestrian',
  path: 'path',
  bridleway: 'bridleway',
  corridor: 'corridor',
  platform: '',
};

function roadTags(p: Record<string, unknown>): OsmTags | null {
  const cls = String(p.class ?? '');
  const sub = String(p.subclass ?? '');
  if (cls.endsWith('_construction')) return null;
  const tags: OsmTags = {};
  if (cls === 'rail' || cls === 'transit') {
    if (!['rail', 'tram', 'light_rail', 'subway'].includes(sub)) return null;
    tags.railway = sub;
  } else if (cls === 'path') {
    const h = PATH_SUBCLASS[sub] ?? 'footway';
    if (!h) return null;
    tags.highway = h;
  } else if (ROAD_CLASS[cls]) {
    tags.highway = ROAD_CLASS[cls];
    if (p.ramp === 1) tags.highway += '_link';
  } else return null;
  if (p.brunnel === 'bridge') tags.bridge = 'yes';
  if (p.brunnel === 'tunnel') tags.tunnel = 'yes';
  if (p.layer !== undefined) tags.layer = String(p.layer);
  if (p.oneway === 1) tags.oneway = 'yes';
  if (p.oneway === -1) tags.oneway = '-1';
  return tags;
}

function areaTags(layer: string, p: Record<string, unknown>): OsmTags | null {
  const cls = String(p.class ?? '');
  const sub = String(p.subclass ?? '');
  switch (layer) {
    case 'water':
      return cls === 'swimming_pool' ? null : { natural: 'water' };
    case 'landcover':
      if (sub === 'park' || sub === 'garden') return { leisure: 'park' };
      if (cls === 'grass') return { landuse: 'grass' };
      if (cls === 'wood') return { natural: 'wood' };
      if (cls === 'sand') return { natural: 'sand' };
      if (cls === 'rock') return { natural: 'bare_rock' };
      if (cls === 'wetland') return { natural: 'wetland' };
      if (cls === 'farmland') return { landuse: 'farmland' };
      return null;
    case 'landuse':
      if (['residential', 'commercial', 'industrial', 'railway', 'cemetery', 'retail'].includes(cls)) return { landuse: cls };
      if (cls === 'pitch' || cls === 'playground' || cls === 'stadium') return { leisure: 'pitch' };
      return null;
    case 'park':
      return { leisure: 'park' };
    case 'transportation':
      if (cls === 'pier') return { man_made: 'pier' };
      if (cls === 'bridge') return { man_made: 'bridge' };
      if (cls === 'path' && sub === 'pedestrian') return { highway: 'pedestrian', area: 'yes' };
      return null;
    default:
      return null;
  }
}

interface Line {
  pts: Flat;
  tags: OsmTags;
}

/** Roads and rails only connect to their own kind, and only on the same level. */
function connectKey(t: OsmTags): string {
  return `${t.railway ? 'rail' : 'road'}|${t.layer ?? '0'}|${t.bridge ? 'b' : t.tunnel ? 't' : ''}`;
}

const SNAP = 3; // pixels (~1 m at z14)

/**
 * Vector tiles simplify lines, which drops junction vertices on straight roads. Re-insert shared
 * vertices where lines cross, and where a line ends on (or just short of) another line.
 */
export function nodeLines(lines: Line[]): Line[] {
  const CELL = 64;
  interface Seg {
    line: number;
    i: number; // segment index (vertex i → i+1)
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }
  const keys = lines.map((l) => connectKey(l.tags));
  const grid = new Map<string, Seg[]>();
  lines.forEach((l, li) => {
    for (let i = 0; i + 3 < l.pts.length; i += 2) {
      const s: Seg = { line: li, i: i / 2, ax: l.pts[i], ay: l.pts[i + 1], bx: l.pts[i + 2], by: l.pts[i + 3] };
      const x0 = Math.floor((Math.min(s.ax, s.bx) - SNAP) / CELL);
      const x1 = Math.floor((Math.max(s.ax, s.bx) + SNAP) / CELL);
      const y0 = Math.floor((Math.min(s.ay, s.by) - SNAP) / CELL);
      const y1 = Math.floor((Math.max(s.ay, s.by) + SNAP) / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = `${gx},${gy}`;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(s);
        }
      }
    }
  });
  // Split points per line: segment index → list of (t, x, y).
  const splits = lines.map(() => new Map<number, { t: number; x: number; y: number }[]>());
  const addSplit = (s: Seg, t: number, x: number, y: number) => {
    if (t <= 1e-6 || t >= 1 - 1e-6) return;
    const m = splits[s.line];
    let list = m.get(s.i);
    if (!list) m.set(s.i, (list = []));
    if (!list.some((p) => Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5)) list.push({ t, x, y });
  };
  const done = new Set<string>();
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const s1 = list[a];
        const s2 = list[b];
        if (s1.line === s2.line || keys[s1.line] !== keys[s2.line]) continue;
        const pairKey = s1.line < s2.line ? `${s1.line}:${s1.i}|${s2.line}:${s2.i}` : `${s2.line}:${s2.i}|${s1.line}:${s1.i}`;
        if (done.has(pairKey)) continue;
        done.add(pairKey);
        // Proper crossing.
        const d1x = s1.bx - s1.ax;
        const d1y = s1.by - s1.ay;
        const d2x = s2.bx - s2.ax;
        const d2y = s2.by - s2.ay;
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) > 1e-9) {
          const t = ((s2.ax - s1.ax) * d2y - (s2.ay - s1.ay) * d2x) / den;
          const u = ((s2.ax - s1.ax) * d1y - (s2.ay - s1.ay) * d1x) / den;
          if (t > 0 && t < 1 && u > 0 && u < 1) {
            const x = s1.ax + d1x * t;
            const y = s1.ay + d1y * t;
            addSplit(s1, t, x, y);
            addSplit(s2, u, x, y);
            continue;
          }
        }
        // Line ends near the other segment (T-junction).
        for (const [end, seg] of [
          [s1, s2],
          [s2, s1],
        ] as const) {
          const l = lines[end.line].pts;
          const isFirst = end.i === 0;
          const isLast = end.i * 2 + 4 === l.length;
          for (const [px, py, which] of [
            [end.ax, end.ay, isFirst ? 0 : -1],
            [end.bx, end.by, isLast ? l.length - 2 : -1],
          ] as const) {
            if (which < 0) continue;
            const c = closestPointOnSegment(px, py, seg.ax, seg.ay, seg.bx, seg.by);
            if (c.d2 > SNAP * SNAP || c.t <= 0.001 || c.t >= 0.999) continue;
            addSplit(seg, c.t, c.x, c.z);
            l[which] = c.x;
            l[which + 1] = c.z;
          }
        }
      }
    }
  }
  return lines.map((l, li) => {
    const m = splits[li];
    if (!m.size) return l;
    const pts: Flat = [];
    const n = l.pts.length / 2;
    for (let i = 0; i < n; i++) {
      pts.push(l.pts[i * 2], l.pts[i * 2 + 1]);
      const extra = m.get(i);
      if (extra && i + 1 < n) for (const p of extra.sort((a, b) => a.t - b.t)) pts.push(p.x, p.y);
    }
    return { pts, tags: l.tags };
  });
}

interface NameSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  name: string;
}

export function mvtToOsm(buf: Uint8Array, t: TileCoord, nextId: () => number): OsmElement[] {
  const tile = new VectorTile(new PbfReader(buf));
  const out: OsmElement[] = [];

  for (const [layerName, layer] of Object.entries(tile.layers)) {
    const extent = layer.extent;
    const worldSize = extent * 2 ** t.z;
    const ox = t.x * extent;
    const oy = t.y * extent;
    const rect = { minX: 0, minZ: 0, maxX: extent, maxZ: extent };
    const geo = (flat: Flat): OsmPoint[] => {
      const pts: OsmPoint[] = [];
      for (let i = 0; i < flat.length; i += 2) pts.push(toLatLon(ox + flat[i], oy + flat[i + 1], worldSize));
      return pts;
    };

    // Street names live on a separate layer; index its segments so roads can pick them up.
    const names = layerName === 'transportation' ? nameIndex(tile.layers.transportation_name) : null;
    const lines: Line[] = [];

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const p = f.properties as Record<string, unknown>;

      if (layerName === 'place' && f.type === 1) {
        const cls = String(p.class ?? '');
        if (!['suburb', 'quarter', 'neighbourhood'].includes(cls) || !p.name) continue;
        const pt = f.loadGeometry()[0]?.[0];
        if (!pt || pt.x < 0 || pt.y < 0 || pt.x > extent || pt.y > extent) continue;
        const ll = toLatLon(ox + pt.x, oy + pt.y, worldSize);
        out.push({ type: 'node', id: nextId(), lat: ll.lat, lon: ll.lon, tags: { place: cls, name: String(p.name) } });
        continue;
      }

      if (f.type === 3) {
        let tags: OsmTags | null;
        if (layerName === 'building') {
          if (p.hide_3d) continue;
          tags = { building: 'yes' };
          if (typeof p.render_height === 'number') tags.height = String(p.render_height);
          if (typeof p.render_min_height === 'number' && p.render_min_height > 0) tags.min_height = String(p.render_min_height);
          if (typeof p.colour === 'string') tags['building:colour'] = p.colour;
        } else {
          tags = areaTags(layerName, p);
        }
        if (!tags) continue;
        for (const polygon of classifyRings(f.loadGeometry())) {
          const [outer, ...holes] = polygon
            .map((ring) => clipRingToRect(ring.flatMap((pt) => [pt.x, pt.y]), rect))
            .filter((r, k) => k === 0 || r.length >= 6);
          if (outer.length < 6) continue;
          if (!holes.length) {
            const g = geo(outer);
            g.push(g[0]);
            const nodes = g.map(() => nextId());
            nodes[nodes.length - 1] = nodes[0];
            out.push({ type: 'way', id: nextId(), nodes, geometry: g, tags });
          } else {
            out.push({
              type: 'relation',
              id: nextId(),
              tags: { ...tags, type: 'multipolygon' },
              members: [outer, ...holes].map((r, k) => {
                const g = geo(r);
                g.push(g[0]);
                return { type: 'way' as const, ref: nextId(), role: k === 0 ? 'outer' : 'inner', geometry: g };
              }),
            });
          }
        }
        continue;
      }

      if (f.type === 2 && layerName === 'transportation') {
        const tags = roadTags(p);
        if (!tags) continue;
        for (const line of f.loadGeometry()) {
          for (const piece of clipPolylineToRect(line.flatMap((pt) => [pt.x, pt.y]), rect)) {
            const name = names?.(piece);
            lines.push({ pts: piece, tags: name ? { ...tags, name } : tags });
          }
        }
      }
    }

    if (lines.length) {
      for (const l of nodeLines(lines)) {
        const nodes: number[] = [];
        for (let k = 0; k < l.pts.length; k += 2) nodes.push(vertexId(ox + l.pts[k], oy + l.pts[k + 1]));
        out.push({ type: 'way', id: nextId(), nodes, geometry: geo(l.pts), tags: l.tags });
      }
      lines.length = 0;
    }
  }
  return out;
}

/** Returns a lookup that finds the street name running along a line (pixel coordinates). */
function nameIndex(layer: VectorTile['layers'][string] | undefined): ((line: Flat) => string | undefined) | null {
  if (!layer) return null;
  const CELL = 64;
  const grid = new Map<string, NameSeg[]>();
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const name = f.properties.name;
    if (typeof name !== 'string' || !name) continue;
    for (const line of f.loadGeometry()) {
      for (let k = 0; k + 1 < line.length; k++) {
        const s: NameSeg = { ax: line[k].x, ay: line[k].y, bx: line[k + 1].x, by: line[k + 1].y, name };
        const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL);
        const x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
        const y0 = Math.floor(Math.min(s.ay, s.by) / CELL);
        const y1 = Math.floor(Math.max(s.ay, s.by) / CELL);
        for (let gx = x0; gx <= x1; gx++) {
          for (let gy = y0; gy <= y1; gy++) {
            const key = `${gx},${gy}`;
            let list = grid.get(key);
            if (!list) grid.set(key, (list = []));
            list.push(s);
          }
        }
      }
    }
  }
  return (line) => {
    // Probe the middle of the longest segment.
    let best = 0;
    let mx = 0;
    let my = 0;
    let dx = 0;
    let dy = 0;
    for (let k = 0; k + 3 < line.length; k += 2) {
      const len = Math.hypot(line[k + 2] - line[k], line[k + 3] - line[k + 1]);
      if (len > best) {
        best = len;
        mx = (line[k] + line[k + 2]) / 2;
        my = (line[k + 1] + line[k + 3]) / 2;
        dx = (line[k + 2] - line[k]) / len;
        dy = (line[k + 3] - line[k + 1]) / len;
      }
    }
    if (!best) return undefined;
    const list = grid.get(`${Math.floor(mx / CELL)},${Math.floor(my / CELL)}`);
    let found: string | undefined;
    let bestD = 8 * 8;
    for (const s of list ?? []) {
      const c = closestPointOnSegment(mx, my, s.ax, s.ay, s.bx, s.by);
      if (c.d2 >= bestD) continue;
      const sl = Math.hypot(s.bx - s.ax, s.by - s.ay) || 1;
      if (Math.abs(((s.bx - s.ax) * dx + (s.by - s.ay) * dy) / sl) < 0.8) continue;
      bestD = c.d2;
      found = s.name;
    }
    return found;
  };
}
