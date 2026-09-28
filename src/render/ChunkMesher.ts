import * as THREE from 'three';
import { CHUNK_SIZE } from '../config';
import { hashString, seededRandom } from '../core/math';
import { pointInPolygon, signedArea, type Flat } from '../geo/polygon';
import type { AreaData, BuildingData, ChunkData, RoadData } from '../world/chunkTypes';
import type { LampInstance, TreeInstance } from '../world/decorations';
import { isDrivable } from '../world/osm/process';
import { GeometryBuilder } from './GeometryBuilder';
import { AREA_STYLE, LAYER, layerY, type WorldMaterials } from './WorldMaterials';

const FLOOR_HEIGHT = 3.1;
const BAY_WIDTH = 3.5;
const ROAD_TEXTURE_LENGTH = 12;
const SIDEWALK_WIDTH = 2.6;

/** Typical Gothenburg facade colors: plaster, stone and brick. */
const WALL_PALETTE = ['#d8cbb0', '#c9b79a', '#e3d9c3', '#b86f52', '#a65a45', '#d9c38f', '#cfd0c8', '#bfae94', '#e6e1d3', '#c28e6b', '#9aa3a6', '#d4b483'];
const ROOF_PALETTE = ['#4b4f55', '#5b3b32', '#6e8f7c', '#7c9f8c', '#3f4247', '#6b4a3a', '#575b61'];

export interface ChunkMeshes {
  group: THREE.Group;
  dispose(): void;
}

const tmpColor = new THREE.Color();

function safeColor(value: string | undefined, fallback: string): THREE.Color {
  if (value) {
    try {
      const c = new THREE.Color();
      // THREE.Color warns on unknown names; pre-validate with a canvas-free check.
      if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return c.set(value.startsWith('#') ? value : `#${value}`);
      if (/^[a-z]+$/i.test(value) && value.toLowerCase() in THREE.Color.NAMES) return c.set(value.toLowerCase());
    } catch {
      /* fall through */
    }
  }
  return new THREE.Color(fallback);
}

/** Builds renderable meshes for one chunk. Geometry is merged per material to keep draw calls low. */
export class ChunkMesher {
  private readonly trunkGeom = new THREE.CylinderGeometry(0.18, 0.28, 3, 6).translate(0, 1.5, 0);
  private readonly canopyGeom = new THREE.IcosahedronGeometry(2.4, 1).translate(0, 4.6, 0);
  private readonly lampGeom = mergeLampGeometry();
  private readonly lampMat = new THREE.MeshLambertMaterial({ color: '#3b4045' });

  constructor(private readonly mats: WorldMaterials) {}

  build(chunk: ChunkData, trees: TreeInstance[], lamps: LampInstance[]): ChunkMeshes {
    const group = new THREE.Group();
    group.name = `chunk_${chunk.cx}_${chunk.cz}`;
    const geometries: THREE.BufferGeometry[] = [];
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

    add(this.ground(chunk), this.mats.ground);

    const areas = new GeometryBuilder();
    const water = new GeometryBuilder();
    for (const a of chunk.areas) this.area(a, a.kind === 'water' ? water : areas);
    add(areas, this.mats.areas);
    add(water, this.mats.water);

    const roadBuilders = new Map<THREE.Material, GeometryBuilder>();
    const sidewalks = new GeometryBuilder();
    const railings = new GeometryBuilder();
    const waterAreas = chunk.areas.filter((a) => a.kind === 'water');
    for (const r of chunk.roads) {
      const { material, layer } = this.mats.roadMaterial(r.kind, r.oneway);
      let b = roadBuilders.get(material);
      if (!b) {
        b = new GeometryBuilder();
        roadBuilders.set(material, b);
      }
      ribbon(b, r.pts, r.width, layerY(layer), ROAD_TEXTURE_LENGTH);
      if (hasSidewalk(r)) ribbon(sidewalks, r.pts, r.width + SIDEWALK_WIDTH * 2, layerY(LAYER.sidewalk), 4);
      if (r.bridge && overWater(r, waterAreas)) bridgeRailings(railings, r);
    }
    for (const [material, b] of roadBuilders) add(b, material);
    add(sidewalks, this.mats.sidewalk);
    add(railings, this.mats.railing, { shadow: true });

    const rails = new GeometryBuilder();
    for (const r of chunk.rails) {
      for (const off of [-0.72, 0.72]) {
        ribbon(rails, offsetPolyline(r.pts, off), 0.12, layerY(LAYER.rail), 4);
      }
    }
    add(rails, this.mats.rail);

    const walls = new GeometryBuilder();
    const roofs = new GeometryBuilder();
    for (const b of chunk.buildings) this.building(b, walls, roofs);
    add(walls, this.mats.walls, { shadow: true });
    add(roofs, this.mats.roofs, { shadow: true });

    const treeMeshes = [...this.trees(chunk, trees), ...this.lamps(lamps)];
    for (const m of treeMeshes) group.add(m);

    return {
      group,
      dispose: () => {
        for (const g of geometries) g.dispose();
        for (const m of treeMeshes) m.dispose();
      },
    };
  }

  private ground(chunk: ChunkData): GeometryBuilder {
    const b = new GeometryBuilder();
    const x0 = chunk.cx * CHUNK_SIZE;
    const z0 = chunk.cz * CHUNK_SIZE;
    const x1 = x0 + CHUNK_SIZE;
    const z1 = z0 + CHUNK_SIZE;
    const v0 = b.vertex(x0, 0, z0, 0, 1, 0, x0, z0);
    const v1 = b.vertex(x1, 0, z0, 0, 1, 0, x1, z0);
    const v2 = b.vertex(x1, 0, z1, 0, 1, 0, x1, z1);
    const v3 = b.vertex(x0, 0, z1, 0, 1, 0, x0, z1);
    b.triFacing(v0, v1, v2, 0, 1, 0);
    b.triFacing(v0, v2, v3, 0, 1, 0);
    return b;
  }

  private area(a: AreaData, b: GeometryBuilder) {
    const style = AREA_STYLE[a.kind];
    const color = new THREE.Color(style.color);
    polygonCap(b, a.outer, a.holes, layerY(style.layer), color, 1);
  }

  private building(bd: BuildingData, walls: GeometryBuilder, roofs: GeometryBuilder) {
    const rnd = seededRandom(bd.id);
    const wallColor = safeColor(bd.color, WALL_PALETTE[Math.floor(rnd() * WALL_PALETTE.length)]);
    const roofColor = safeColor(bd.roofColor, ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)]);
    const top = bd.height;
    const bottom = bd.minHeight;
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
        tmpColor.copy(wallColor).multiplyScalar(0.92 + ((i * 7919) % 13) / 13 * 0.12);
        const u0 = u / BAY_WIDTH;
        const u1 = (u + len) / BAY_WIDTH;
        const v0 = bottom / FLOOR_HEIGHT;
        const v1 = top / FLOOR_HEIGHT;
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
    if (bottom > 0.5) polygonCap(roofs, bd.outer, bd.holes, bottom, tmpColor.copy(wallColor).multiplyScalar(0.6), 1 / 6, -1);
  }

  private lamps(lamps: LampInstance[]): THREE.InstancedMesh[] {
    if (!lamps.length) return [];
    const mesh = new THREE.InstancedMesh(this.lampGeom, this.lampMat, lamps.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    lamps.forEach((l, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, l.heading);
      m.compose(p.set(l.x, 0, l.z), q, one);
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = true;
    mesh.computeBoundingSphere();
    return [mesh];
  }

  private trees(chunk: ChunkData, trees: TreeInstance[]): THREE.InstancedMesh[] {
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
      p.set(t.x, 0, t.z);
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

function hasSidewalk(r: RoadData): boolean {
  return isDrivable(r.kind) && r.kind !== 'service' && r.kind !== 'motorway' && !r.bridge;
}

function overWater(r: RoadData, water: AreaData[]): boolean {
  if (!water.length) return false;
  for (let i = 0; i + 3 < r.pts.length; i += 2) {
    const mx = (r.pts[i] + r.pts[i + 2]) / 2;
    const mz = (r.pts[i + 1] + r.pts[i + 3]) / 2;
    if (water.some((a) => pointInPolygon(mx, mz, a.outer, a.holes))) return true;
  }
  return false;
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

function toVec2(flatPts: Flat): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < flatPts.length; i += 2) out.push(new THREE.Vector2(flatPts[i], flatPts[i + 1]));
  return out;
}

/** Flat strip along a polyline with mitered joins; u spans the width, v runs along the length. */
export function ribbon(b: GeometryBuilder, pts: Flat, width: number, y: number, vRepeat: number) {
  const n = pts.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  let dist = 0;
  let prevL = -1;
  let prevR = -1;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const z = pts[i * 2 + 1];
    const { mx, mz, scale } = miter(pts, i, n);
    if (i > 0) dist += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    const v = dist / vRepeat;
    // Right side = (-dz, dx) relative to the direction of travel.
    const l = b.vertex(x - mx * hw * scale, y, z - mz * hw * scale, 0, 1, 0, 0, v);
    const r = b.vertex(x + mx * hw * scale, y, z + mz * hw * scale, 0, 1, 0, 1, v);
    if (i > 0) {
      b.triFacing(prevL, prevR, r, 0, 1, 0);
      b.triFacing(prevL, r, l, 0, 1, 0);
    }
    prevL = l;
    prevR = r;
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

function bridgeRailings(b: GeometryBuilder, r: RoadData) {
  for (const side of [-1, 1]) {
    const line = offsetPolyline(r.pts, (side * r.width) / 2);
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i];
      const az = line[i + 1];
      const bx = line[i + 2];
      const bz = line[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const nx = ((bz - az) / len) * -side;
      const nz = (-(bx - ax) / len) * -side;
      for (const [ox, oz, dirSign] of [
        [0, 0, 1],
        [nx * -0.25, nz * -0.25, -1],
      ] as const) {
        const a0 = b.vertex(ax + ox, 0, az + oz, nx * dirSign, 0, nz * dirSign, 0, 0);
        const b0 = b.vertex(bx + ox, 0, bz + oz, nx * dirSign, 0, nz * dirSign, 1, 0);
        const b1 = b.vertex(bx + ox, 1.1, bz + oz, nx * dirSign, 0, nz * dirSign, 1, 1);
        const a1 = b.vertex(ax + ox, 1.1, az + oz, nx * dirSign, 0, nz * dirSign, 0, 1);
        b.triFacing(a0, b0, b1, nx * dirSign, 0, nz * dirSign);
        b.triFacing(a0, b1, a1, nx * dirSign, 0, nz * dirSign);
      }
    }
  }
}
