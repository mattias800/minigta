import * as THREE from 'three';
import { CHUNK_SIZE } from '../config';
import { hashString, seededRandom } from '../core/math';
import { closestPointOnSegment, pointInPolygon, signedArea, type Flat } from '../geo/polygon';
import type { AreaData, BridgeSpan, BuildingData, ChunkData, RoadData } from '../world/chunkTypes';
import type { LampInstance, TreeInstance } from '../world/decorations';
import { isDrivable } from '../world/osm/process';
import { buildingBase, LATTICE, type HeightSampler } from '../world/terrain/heights';
import { GeometryBuilder } from './GeometryBuilder';
import { AREA_STYLE, LAYER, layerY, type WorldMaterials } from './WorldMaterials';

const FLOOR_HEIGHT = 3.1;
const BAY_WIDTH = 3.5;
const ROAD_TEXTURE_LENGTH = 12;
const SIDEWALK_WIDTH = 2.6;
/** Max length of a draped road segment / area triangle edge, so they follow the terrain. */
const DRAPE_STEP = 5;
/** Areas are big; match the terrain lattice spacing instead. */
const AREA_STEP = 10;
const DECK_THICKNESS = 0.9;
const PILLAR_SPACING = 32;

/** Typical Gothenburg facade colors: plaster, stone and brick. */
const WALL_PALETTE = ['#d8cbb0', '#c9b79a', '#e3d9c3', '#b86f52', '#a65a45', '#d9c38f', '#cfd0c8', '#bfae94', '#e6e1d3', '#c28e6b', '#9aa3a6', '#d4b483'];
const ROOF_PALETTE = ['#4b4f55', '#5b3b32', '#6e8f7c', '#7c9f8c', '#3f4247', '#6b4a3a', '#575b61'];

/** Collision shapes that come out of meshing (bridge railings and pillars). */
export interface MeshColliders {
  walls: { ax: number; az: number; bx: number; bz: number; bottom: number; top: number }[];
  posts: { x: number; z: number; r: number; bottom: number; top: number }[];
}

export interface ChunkMeshes {
  group: THREE.Group;
  colliders: MeshColliders;
  dispose(): void;
}

const tmpColor = new THREE.Color();

function safeColor(value: string | undefined, fallback: string): THREE.Color {
  if (value) {
    try {
      const c = new THREE.Color();
      if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return c.set(value.startsWith('#') ? value : `#${value}`);
      if (/^[a-z]+$/i.test(value) && value.toLowerCase() in THREE.Color.NAMES) return c.set(value.toLowerCase());
    } catch {
      /* fall through */
    }
  }
  return new THREE.Color(fallback);
}

const hsl = { h: 0, s: 0, l: 0 };

/** Mapped colours are often garish ("green"); keep them in a believable facade range. */
function tame(c: THREE.Color): THREE.Color {
  c.getHSL(hsl);
  return c.setHSL(hsl.h, Math.min(hsl.s, 0.45) * 0.8, Math.min(Math.max(hsl.l, 0.3), 0.85));
}

/** Height of a draped vertex: (x, z, distance along the line) → y. */
type HeightFn = (x: number, z: number, s: number) => number;

/**
 * Builds renderable meshes for one chunk. Everything is draped on the terrain (or placed on bridge
 * decks). Geometry is merged per material to keep draw calls low.
 */
export class ChunkMesher {
  private readonly trunkGeom = new THREE.CylinderGeometry(0.18, 0.28, 3, 6).translate(0, 1.5, 0);
  private readonly canopyGeom = new THREE.IcosahedronGeometry(2.4, 1).translate(0, 4.6, 0);
  private readonly lampGeom = mergeLampGeometry();
  private readonly lampMat = new THREE.MeshLambertMaterial({ color: '#3b4045' });

  constructor(private readonly mats: WorldMaterials) {}

  build(chunk: ChunkData, trees: TreeInstance[], lamps: LampInstance[], h: HeightSampler): ChunkMeshes {
    const group = new THREE.Group();
    group.name = `chunk_${chunk.cx}_${chunk.cz}`;
    const geometries: THREE.BufferGeometry[] = [];
    const colliders: MeshColliders = { walls: [], posts: [] };
    const add = (builder: GeometryBuilder, material: THREE.Material, opts: { shadow?: boolean; receive?: boolean } = {}) => {
      if (builder.isEmpty) return;
      const geom = builder.build();
      geometries.push(geom);
      const mesh = new THREE.Mesh(geom, material);
      mesh.castShadow = !!opts.shadow;
      mesh.receiveShadow = opts.receive ?? true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    };

    add(this.ground(chunk, h), this.mats.ground);

    const areas = new GeometryBuilder();
    const water = new GeometryBuilder();
    for (const a of chunk.areas) this.area(a, a.kind === 'water' ? water : areas, h);
    add(areas, this.mats.areas);
    add(water, this.mats.water);

    const roadBuilders = new Map<THREE.Material, GeometryBuilder>();
    const sidewalks = new GeometryBuilder();
    const structure = new GeometryBuilder();
    for (const r of chunk.roads) {
      const { material, layer } = this.mats.roadMaterial(r.kind, r.oneway);
      let b = roadBuilders.get(material);
      if (!b) {
        b = new GeometryBuilder();
        roadBuilders.set(material, b);
      }
      const offset = layerY(layer);
      if (r.span) {
        const deck = deckFn(r.span, h, 0.05);
        drapedRibbon(b, r.pts, r.width, deck, ROAD_TEXTURE_LENGTH, null);
        bridgeStructure(structure, colliders, r, h);
      } else {
        drapedRibbon(b, r.pts, r.width, (x, z) => h.ground(x, z) + offset, ROAD_TEXTURE_LENGTH, h);
        if (hasSidewalk(r)) {
          const so = layerY(LAYER.sidewalk);
          drapedRibbon(sidewalks, r.pts, r.width + SIDEWALK_WIDTH * 2, (x, z) => h.ground(x, z) + so, 4, h);
        }
      }
    }
    for (const [material, b] of roadBuilders) add(b, material);
    add(sidewalks, this.mats.sidewalk);
    add(structure, this.mats.railing, { shadow: true });

    const rails = new GeometryBuilder();
    const ro = layerY(LAYER.rail);
    for (const r of chunk.rails) {
      const y: HeightFn = r.span ? deckFn(r.span, h, 0.08) : (x, z) => h.ground(x, z) + ro;
      for (const off of [-0.72, 0.72]) drapedRibbon(rails, offsetPolyline(r.pts, off), 0.12, y, 4, r.span ? null : h);
    }
    add(rails, this.mats.rail);

    const walls = new GeometryBuilder();
    const roofs = new GeometryBuilder();
    for (const b of chunk.buildings) this.building(b, walls, roofs, h);
    add(walls, this.mats.walls, { shadow: true });
    add(roofs, this.mats.roofs, { shadow: true });

    const instanced = [...this.trees(chunk, trees, h), ...this.lamps(lamps, h)];
    for (const m of instanced) group.add(m);

    return {
      group,
      colliders,
      dispose: () => {
        for (const g of geometries) g.dispose();
        for (const m of instanced) m.dispose();
      },
    };
  }

  /** Terrain mesh on the global lattice (same triangulation as HeightSampler.ground). */
  private ground(chunk: ChunkData, h: HeightSampler): GeometryBuilder {
    const b = new GeometryBuilder();
    const n = CHUNK_SIZE / LATTICE;
    const x0 = chunk.cx * CHUNK_SIZE;
    const z0 = chunk.cz * CHUNK_SIZE;
    const idx: number[] = [];
    const water = chunk.areas.filter((a) => a.kind === 'water');
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = x0 + i * LATTICE;
        const z = z0 + j * LATTICE;
        const nm = h.normal(x, z);
        let y = h.ground(x, z);
        // Push the bed below any water surface covering (or bordering) this vertex.
        for (const a of water) {
          if (y > (a.level ?? 0) - 1 && nearPolygon(x, z, a.outer, a.holes, LATTICE * 0.75)) y = (a.level ?? 0) - 1.5;
        }
        idx.push(b.vertex(x, y, z, nm.x, nm.y, nm.z, x, z));
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v00 = idx[j * (n + 1) + i];
        const v10 = idx[j * (n + 1) + i + 1];
        const v01 = idx[(j + 1) * (n + 1) + i];
        const v11 = idx[(j + 1) * (n + 1) + i + 1];
        b.triFacing(v00, v10, v11, 0, 1, 0);
        b.triFacing(v00, v11, v01, 0, 1, 0);
      }
    }
    return b;
  }

  private area(a: AreaData, b: GeometryBuilder, h: HeightSampler) {
    const style = AREA_STYLE[a.kind];
    const color = new THREE.Color(style.color);
    if (a.kind === 'water') {
      // Water is flat; the terrain mesh is carved beneath it.
      polygonCap(b, a.outer, a.holes, (a.level ?? 0) + 0.05, color, 1);
      return;
    }
    const offset = layerY(style.layer);
    drapedPolygon(b, a.outer, a.holes, (x, z) => h.ground(x, z) + offset, color, h);
  }

  private building(bd: BuildingData, walls: GeometryBuilder, roofs: GeometryBuilder, h: HeightSampler) {
    const rnd = seededRandom(bd.id);
    const wallColor = tame(safeColor(bd.color, WALL_PALETTE[Math.floor(rnd() * WALL_PALETTE.length)]));
    const roofColor = tame(safeColor(bd.roofColor, ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)]));
    const base = buildingBase(bd, h.ground);
    const top = base + bd.height;
    const bottom = base + bd.minHeight;
    const rings = [bd.outer, ...(bd.holes ?? [])];
    rings.forEach((ring, ri) => {
      // Outer rings face outward, holes face inward (towards the courtyard).
      const ccw = signedArea(ring) > 0;
      const outward = ri === 0 ? ccw : !ccw;
      const n = ring.length / 2;
      let u = 0;
      for (let i = 0; i < n; i++) {
        const ax = ring[i * 2];
        const az = ring[i * 2 + 1];
        const bx = ring[((i + 1) % n) * 2];
        const bz = ring[((i + 1) % n) * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        let nx = (bz - az) / len;
        let nz = -(bx - ax) / len;
        if (!outward) {
          nx = -nx;
          nz = -nz;
        }
        // Slight per-wall shading variation breaks up large flat facades.
        tmpColor.copy(wallColor).multiplyScalar(0.92 + (((i * 7919) % 13) / 13) * 0.12);
        const u0 = u / BAY_WIDTH;
        const u1 = (u + len) / BAY_WIDTH;
        // Windows are aligned to the building's own floors.
        const v0 = bd.minHeight / FLOOR_HEIGHT;
        const v1 = bd.height / FLOOR_HEIGHT;
        const a0 = walls.vertex(ax, bottom, az, nx, 0, nz, u0, v0, tmpColor);
        const b0 = walls.vertex(bx, bottom, bz, nx, 0, nz, u1, v0, tmpColor);
        const b1 = walls.vertex(bx, top, bz, nx, 0, nz, u1, v1, tmpColor);
        const a1 = walls.vertex(ax, top, az, nx, 0, nz, u0, v1, tmpColor);
        walls.triFacing(a0, b0, b1, nx, 0, nz);
        walls.triFacing(a0, b1, a1, nx, 0, nz);
        u += len;
      }
    });
    polygonCap(roofs, bd.outer, bd.holes, top, roofColor, 1 / 6);
    if (bd.minHeight > 0.5) polygonCap(roofs, bd.outer, bd.holes, bottom, tmpColor.copy(wallColor).multiplyScalar(0.6), 1 / 6, -1);
  }

  private lamps(lamps: LampInstance[], h: HeightSampler): THREE.InstancedMesh[] {
    if (!lamps.length) return [];
    const mesh = new THREE.InstancedMesh(this.lampGeom, this.lampMat, lamps.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    lamps.forEach((l, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, l.heading);
      m.compose(p.set(l.x, h.ground(l.x, l.z), l.z), q, one);
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = true;
    mesh.computeBoundingSphere();
    return [mesh];
  }

  private trees(chunk: ChunkData, trees: TreeInstance[], h: HeightSampler): THREE.InstancedMesh[] {
    if (!trees.length) return [];
    const trunks = new THREE.InstancedMesh(this.trunkGeom, this.mats.trunk, trees.length);
    const canopies = new THREE.InstancedMesh(this.canopyGeom, this.mats.canopy, trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const rnd = seededRandom(hashString(`trees${chunk.cx},${chunk.cz}`));
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
      p.set(t.x, h.ground(t.x, t.z) - 0.2, t.z);
      s.setScalar(t.scale);
      m.compose(p, q, s);
      trunks.setMatrixAt(i, m);
      s.set(t.scale * (0.85 + rnd() * 0.3), t.scale * (0.8 + rnd() * 0.4), t.scale * (0.85 + rnd() * 0.3));
      m.compose(p, q, s);
      canopies.setMatrixAt(i, m);
      c.setHSL(0.24 + t.hue * 0.1, 0.45 + t.hue * 0.15, 0.24 + t.hue * 0.1);
      canopies.setColorAt(i, c);
    });
    for (const mesh of [trunks, canopies]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
    }
    return [trunks, canopies];
  }
}

/** Pole + arm + lamp head in one geometry; the arm points along +z. */
function mergeLampGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 5.6, 6).translate(0, 2.8, 0);
  const arm = new THREE.BoxGeometry(0.08, 0.08, 1.5).translate(0, 5.5, 0.7);
  const head = new THREE.BoxGeometry(0.3, 0.14, 0.55).translate(0, 5.42, 1.4);
  const parts = [pole, arm, head].map((g) => g.toNonIndexed());
  const merged = new THREE.BufferGeometry();
  for (const attr of ['position', 'normal'] as const) {
    const arrays = parts.map((g) => g.getAttribute(attr).array as Float32Array);
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const a of arrays) {
      out.set(a, o);
      o += a.length;
    }
    merged.setAttribute(attr, new THREE.BufferAttribute(out, 3));
  }
  return merged;
}

/** Inside the polygon, or within `margin` of its outline. */
function nearPolygon(x: number, z: number, outer: Flat, holes: Flat[] | undefined, margin: number): boolean {
  if (pointInPolygon(x, z, outer, holes)) return true;
  const m2 = margin * margin;
  for (const ring of [outer]) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (closestPointOnSegment(x, z, ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]).d2 < m2) return true;
    }
  }
  return false;
}

function hasSidewalk(r: RoadData): boolean {
  return isDrivable(r.kind) && r.kind !== 'service' && r.kind !== 'motorway' && !r.bridge;
}

/** Deck height along a bridge piece; `s` is the distance along the piece's points. */
function deckFn(span: BridgeSpan, h: HeightSampler, lift: number): HeightFn {
  return (_x, _z, s) => h.deck(span, span.start + span.dir * s) + lift;
}

/** Triangulated flat polygon (with holes) facing up (or down with dir = -1). */
function polygonCap(b: GeometryBuilder, outer: Flat, holes: Flat[] | undefined, y: number, color: THREE.Color, uvScale: number, dir = 1) {
  const contour = toVec2(outer);
  const holeVecs = (holes ?? []).map(toVec2);
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holeVecs);
  } catch {
    return;
  }
  const all = contour.concat(...holeVecs);
  const base = b.vertexCount;
  for (const v of all) b.vertex(v.x, y, v.y, 0, dir, 0, v.x * uvScale, v.y * uvScale, color);
  for (const f of faces) b.triFacing(base + f[0], base + f[1], base + f[2], 0, dir, 0);
}

/** Triangulated polygon draped over the terrain: triangles are split until no edge exceeds DRAPE_STEP. */
function drapedPolygon(b: GeometryBuilder, outer: Flat, holes: Flat[] | undefined, y: (x: number, z: number) => number, color: THREE.Color, h: HeightSampler) {
  const contour = toVec2(outer);
  const holeVecs = (holes ?? []).map(toVec2);
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holeVecs);
  } catch {
    return;
  }
  const all = contour.concat(...holeVecs);
  const emit = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, depth: number) => {
    const ab = (bx - ax) ** 2 + (bz - az) ** 2;
    const bc = (cx - bx) ** 2 + (cz - bz) ** 2;
    const ca = (ax - cx) ** 2 + (az - cz) ** 2;
    const longest = Math.max(ab, bc, ca);
    if (longest > AREA_STEP * AREA_STEP && depth < 14) {
      // Longest-edge bisection.
      if (longest === ab) {
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        emit(ax, az, mx, mz, cx, cz, depth + 1);
        emit(mx, mz, bx, bz, cx, cz, depth + 1);
      } else if (longest === bc) {
        const mx = (bx + cx) / 2;
        const mz = (bz + cz) / 2;
        emit(ax, az, bx, bz, mx, mz, depth + 1);
        emit(ax, az, mx, mz, cx, cz, depth + 1);
      } else {
        const mx = (cx + ax) / 2;
        const mz = (cz + az) / 2;
        emit(ax, az, bx, bz, mx, mz, depth + 1);
        emit(mx, mz, bx, bz, cx, cz, depth + 1);
      }
      return;
    }
    const v = (x: number, z: number) => {
      const n = h.normal(x, z);
      return b.vertex(x, y(x, z), z, n.x, n.y, n.z, x, z, color);
    };
    b.triFacing(v(ax, az), v(bx, bz), v(cx, cz), 0, 1, 0);
  };
  for (const f of faces) emit(all[f[0]].x, all[f[0]].y, all[f[1]].x, all[f[1]].y, all[f[2]].x, all[f[2]].y, 0);
}

function toVec2(flatPts: Flat): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < flatPts.length; i += 2) out.push(new THREE.Vector2(flatPts[i], flatPts[i + 1]));
  return out;
}

/**
 * Strip along a polyline with mitered joins, subdivided every DRAPE_STEP meters so it follows the
 * terrain. u spans the width, v runs along the length. Normals come from `h` (terrain) or point up.
 */
export function drapedRibbon(b: GeometryBuilder, pts: Flat, width: number, y: HeightFn, vRepeat: number, h: HeightSampler | null) {
  const n = pts.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  let dist = 0;
  let prevL = -1;
  let prevR = -1;
  const emit = (x: number, z: number, rx: number, rz: number, s: number) => {
    const lx = x - rx * hw;
    const lz = z - rz * hw;
    const qx = x + rx * hw;
    const qz = z + rz * hw;
    const nm = h ? h.normal(x, z) : { x: 0, y: 1, z: 0 };
    const v = s / vRepeat;
    // Right side = (-dz, dx) relative to the direction of travel.
    const l = b.vertex(lx, y(lx, lz, s), lz, nm.x, nm.y, nm.z, 0, v);
    const r = b.vertex(qx, y(qx, qz, s), qz, nm.x, nm.y, nm.z, 1, v);
    if (prevL >= 0) {
      b.triFacing(prevL, prevR, r, 0, 1, 0);
      b.triFacing(prevL, r, l, 0, 1, 0);
    }
    prevL = l;
    prevR = r;
  };
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const z = pts[i * 2 + 1];
    const { mx, mz, scale } = miter(pts, i, n);
    emit(x, z, mx * scale, mz * scale, dist);
    if (i + 1 < n) {
      const nx = pts[i * 2 + 2];
      const nz = pts[i * 2 + 3];
      const len = Math.hypot(nx - x, nz - z);
      const steps = Math.floor(len / DRAPE_STEP);
      const rx = len > 0 ? -(nz - z) / len : 0;
      const rz = len > 0 ? (nx - x) / len : 0;
      for (let k = 1; k <= steps; k++) {
        const t = k / (steps + 1);
        emit(x + (nx - x) * t, z + (nz - z) * t, rx, rz, dist + len * t);
      }
      dist += len;
    }
  }
}

/** Unit "right" vector at vertex i (average of adjacent segment normals) and the miter scale. */
function miter(pts: Flat, i: number, n: number): { mx: number; mz: number; scale: number } {
  const seg = (j: number) => {
    const dx = pts[j * 2 + 2] - pts[j * 2];
    const dz = pts[j * 2 + 3] - pts[j * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    return { rx: -dz / len, rz: dx / len };
  };
  if (i === 0) {
    const s = seg(0);
    return { mx: s.rx, mz: s.rz, scale: 1 };
  }
  if (i === n - 1) {
    const s = seg(n - 2);
    return { mx: s.rx, mz: s.rz, scale: 1 };
  }
  const a = seg(i - 1);
  const c = seg(i);
  let mx = a.rx + c.rx;
  let mz = a.rz + c.rz;
  const len = Math.hypot(mx, mz);
  if (len < 1e-6) return { mx: a.rx, mz: a.rz, scale: 1 };
  mx /= len;
  mz /= len;
  const cos = mx * a.rx + mz * a.rz;
  return { mx, mz, scale: Math.min(1 / Math.max(cos, 0.1), 2.5) };
}

export function offsetPolyline(pts: Flat, offset: number): Flat {
  const n = pts.length / 2;
  const out: Flat = [];
  for (let i = 0; i < n; i++) {
    const { mx, mz, scale } = miter(pts, i, n);
    out.push(pts[i * 2] + mx * offset * scale, pts[i * 2 + 1] + mz * offset * scale);
  }
  return out;
}

/** Vertical quad between two points, from y0 to y1 at each end, facing (nx, nz). */
function wallQuad(b: GeometryBuilder, ax: number, az: number, bx: number, bz: number, a0: number, a1: number, b0: number, b1: number, nx: number, nz: number) {
  const p = b.vertex(ax, a0, az, nx, 0, nz, 0, 0);
  const q = b.vertex(bx, b0, bz, nx, 0, nz, 1, 0);
  const r = b.vertex(bx, b1, bz, nx, 0, nz, 1, 1);
  const s = b.vertex(ax, a1, az, nx, 0, nz, 0, 1);
  b.triFacing(p, q, r, nx, 0, nz);
  b.triFacing(p, r, s, nx, 0, nz);
}

/** Deck edges, underside, pillars and (over water) railings for a bridge piece. */
function bridgeStructure(b: GeometryBuilder, col: MeshColliders, r: RoadData, h: HeightSampler) {
  const span = r.span!;
  const deckAt = (s: number) => h.deck(span, span.start + span.dir * s);
  const railings = span.arch > 0;
  // Resample the center line so the deck follows the arch.
  const samples: { x: number; z: number; s: number }[] = [];
  let dist = 0;
  for (let i = 0; i + 3 < r.pts.length; i += 2) {
    const ax = r.pts[i];
    const az = r.pts[i + 1];
    const len = Math.hypot(r.pts[i + 2] - ax, r.pts[i + 3] - az);
    const steps = Math.max(1, Math.ceil(len / DRAPE_STEP));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      samples.push({ x: ax + (r.pts[i + 2] - ax) * t, z: az + (r.pts[i + 3] - az) * t, s: dist + len * t });
    }
    dist += len;
  }
  samples.push({ x: r.pts[r.pts.length - 2], z: r.pts[r.pts.length - 1], s: dist });

  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i];
    const c = samples[i + 1];
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (len < 0.01) continue;
    const rx = -(c.z - a.z) / len;
    const rz = (c.x - a.x) / len;
    const ya = deckAt(a.s);
    const yc = deckAt(c.s);
    for (const side of [-1, 1]) {
      const off = (r.width / 2) * side;
      const ax = a.x + rx * off;
      const az = a.z + rz * off;
      const cx = c.x + rx * off;
      const cz = c.z + rz * off;
      // Fascia (edge of the deck slab).
      wallQuad(b, ax, az, cx, cz, ya - DECK_THICKNESS, ya, yc - DECK_THICKNESS, yc, rx * side, rz * side);
      if (railings) {
        const ix = -rx * side * 0.2;
        const iz = -rz * side * 0.2;
        wallQuad(b, ax, az, cx, cz, ya, ya + 1.1, yc, yc + 1.1, rx * side, rz * side);
        wallQuad(b, ax + ix, az + iz, cx + ix, cz + iz, ya, ya + 1.1, yc, yc + 1.1, -rx * side, -rz * side);
        col.walls.push({ ax, az, bx: cx, bz: cz, bottom: Math.min(ya, yc) - 0.3, top: Math.max(ya, yc) + 1.1 });
      }
    }
    // Underside.
    const hw = r.width / 2;
    const u0 = b.vertex(a.x - rx * hw, ya - DECK_THICKNESS, a.z - rz * hw, 0, -1, 0, 0, 0);
    const u1 = b.vertex(a.x + rx * hw, ya - DECK_THICKNESS, a.z + rz * hw, 0, -1, 0, 1, 0);
    const u2 = b.vertex(c.x + rx * hw, yc - DECK_THICKNESS, c.z + rz * hw, 0, -1, 0, 1, 1);
    const u3 = b.vertex(c.x - rx * hw, yc - DECK_THICKNESS, c.z - rz * hw, 0, -1, 0, 0, 1);
    b.triFacing(u0, u1, u2, 0, -1, 0);
    b.triFacing(u0, u2, u3, 0, -1, 0);

    // Pillars at regular distances along the whole span, where the deck is high enough.
    const sa = span.start + span.dir * a.s;
    const sc = span.start + span.dir * c.s;
    const k0 = Math.floor(Math.min(sa, sc) / PILLAR_SPACING);
    const k1 = Math.floor(Math.max(sa, sc) / PILLAR_SPACING);
    if (k1 > k0 && k1 * PILLAR_SPACING > 4 && k1 * PILLAR_SPACING < span.length - 4) {
      const t = (k1 * PILLAR_SPACING - sa) / (sc - sa);
      const px = a.x + (c.x - a.x) * t;
      const pz = a.z + (c.z - a.z) * t;
      const top = ya + (yc - ya) * t - DECK_THICKNESS;
      const g = h.ground(px, pz);
      if (top - g > 2.5) {
        pillar(b, px, pz, g - 1, top, Math.min(1.4, r.width * 0.2));
        col.posts.push({ x: px, z: pz, r: 0.8, bottom: g - 1, top });
      }
    }
  }
}

function pillar(b: GeometryBuilder, x: number, z: number, y0: number, y1: number, half: number) {
  const c = [
    [x - half, z - half],
    [x + half, z - half],
    [x + half, z + half],
    [x - half, z + half],
  ];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i];
    const [bx, bz] = c[(i + 1) % 4];
    const nx = (bz - az) / (2 * half);
    const nz = -(bx - ax) / (2 * half);
    wallQuad(b, ax, az, bx, bz, y0, y1, y0, y1, nx, nz);
  }
}
