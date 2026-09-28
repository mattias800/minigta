import { CHUNK_SIZE } from '../config';
import type { ChunkData, RoadKind } from '../world/chunkTypes';

/** Pixels per meter of pre-rendered minimap tiles. */
export const MAP_PX_PER_M = 1.2;

export const MAP_COLORS = {
  background: '#4d5259',
  building: '#383c42',
  water: '#3f7aa6',
  green: '#4c6a45',
  paved: '#5c6067',
  footway: '#80858c',
  road: '#c3c6cb',
  major: '#e0d7b4',
};

const ROAD_STYLE: Record<RoadKind, { color: string; minWidth: number } | null> = {
  motorway: { color: MAP_COLORS.major, minWidth: 5 },
  primary: { color: MAP_COLORS.major, minWidth: 4 },
  secondary: { color: MAP_COLORS.road, minWidth: 4 },
  tertiary: { color: MAP_COLORS.road, minWidth: 3.5 },
  residential: { color: MAP_COLORS.road, minWidth: 3 },
  service: { color: MAP_COLORS.road, minWidth: 2 },
  pedestrian: { color: MAP_COLORS.footway, minWidth: 2 },
  footway: { color: MAP_COLORS.footway, minWidth: 1 },
  cycleway: { color: MAP_COLORS.footway, minWidth: 1 },
  steps: { color: MAP_COLORS.footway, minWidth: 1 },
};

const ROAD_ORDER: RoadKind[] = ['steps', 'footway', 'cycleway', 'pedestrian', 'service', 'residential', 'tertiary', 'secondary', 'primary', 'motorway'];

/**
 * Renders the map tile for chunk (cx, cz) into a small top-down image (north up) used by the minimap
 * and the full map. Features of neighbouring chunks are drawn too, since buildings and road pieces
 * can extend across chunk borders.
 */
export function renderMapTile(cx: number, cz: number, chunks: ChunkData[]): HTMLCanvasElement {
  const size = Math.round(CHUNK_SIZE * MAP_PX_PER_M);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const s = MAP_PX_PER_M;
  const path = (pts: number[], close: boolean) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const x = (pts[i] - ox) * s;
      const y = (pts[i + 1] - oz) * s;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (close) ctx.closePath();
  };

  ctx.fillStyle = MAP_COLORS.background;
  ctx.fillRect(0, 0, size, size);

  const areaColor = (kind: string) =>
    kind === 'water' ? MAP_COLORS.water : ['park', 'grass', 'forest', 'pitch'].includes(kind) ? MAP_COLORS.green : ['plaza', 'parking', 'pier'].includes(kind) ? MAP_COLORS.paved : null;
  for (const pass of ['green', 'paved', 'water']) {
    for (const a of chunks.flatMap((c) => (c.cx === cx && c.cz === cz ? c.areas : []))) {
      const color = areaColor(a.kind);
      if (!color) continue;
      const isPass = (pass === 'water' && a.kind === 'water') || (pass === 'green' && color === MAP_COLORS.green) || (pass === 'paved' && color === MAP_COLORS.paved);
      if (!isPass) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const ring of [a.outer, ...(a.holes ?? [])]) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = (ring[i] - ox) * s;
          const y = (ring[i + 1] - oz) * s;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
  }

  ctx.fillStyle = MAP_COLORS.building;
  for (const b of chunks.flatMap((c) => c.buildings)) {
    if (b.roofOnly) continue;
    path(b.outer, true);
    ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const kind of ROAD_ORDER) {
    const style = ROAD_STYLE[kind];
    if (!style) continue;
    ctx.strokeStyle = style.color;
    for (const r of chunks.flatMap((c) => c.roads)) {
      if (r.kind !== kind) continue;
      ctx.lineWidth = Math.max(style.minWidth, r.width * s * 0.8);
      path(r.pts, false);
      ctx.stroke();
    }
  }
  return c;
}
