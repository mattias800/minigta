import * as THREE from 'three';
import { lambertMaterial, paintMaterial, unitBox } from '../render/materialCache';

export type VehicleType = 'hatch' | 'sedan' | 'estate' | 'suv' | 'van' | 'sports' | 'police' | 'taxi' | 'tram';

export interface VehicleSpec {
  type: VehicleType;
  name: string;
  length: number;
  width: number;
  height: number;
  /** Max forward speed in m/s. */
  maxSpeed: number;
  accel: number;
  brake: number;
  /** Lateral grip (1/s); higher = less sliding. */
  grip: number;
  /** Max steering angle (radians). */
  steer: number;
  mass: number;
  health: number;
  /** Side profile: fractions along the length for [hood start, windshield base, roof start, roof end, rear glass base]. */
  profile: [number, number, number, number, number];
  belt: number;
  wheelRadius: number;
}

export const VEHICLE_SPECS: Record<VehicleType, VehicleSpec> = {
  hatch: { type: 'hatch', name: 'Göta Mini', length: 3.9, width: 1.75, height: 1.48, maxSpeed: 40, accel: 8.5, brake: 16, grip: 9, steer: 0.62, mass: 1100, health: 700, profile: [0.94, 0.72, 0.52, 0.1, 0.02], belt: 0.92, wheelRadius: 0.31 },
  sedan: { type: 'sedan', name: 'Svea Sedan', length: 4.7, width: 1.85, height: 1.45, maxSpeed: 45, accel: 9, brake: 17, grip: 8.5, steer: 0.58, mass: 1450, health: 800, profile: [0.95, 0.7, 0.55, 0.26, 0.14], belt: 0.95, wheelRadius: 0.33 },
  estate: { type: 'estate', name: 'Kombi 245', length: 4.85, width: 1.8, height: 1.46, maxSpeed: 42, accel: 8, brake: 16, grip: 8.5, steer: 0.58, mass: 1500, health: 900, profile: [0.95, 0.72, 0.6, 0.06, 0.03], belt: 0.95, wheelRadius: 0.33 },
  suv: { type: 'suv', name: 'Fjäll XC', length: 4.8, width: 1.95, height: 1.75, maxSpeed: 43, accel: 8.5, brake: 15, grip: 8, steer: 0.56, mass: 2000, health: 1000, profile: [0.95, 0.73, 0.6, 0.08, 0.03], belt: 1.12, wheelRadius: 0.38 },
  van: { type: 'van', name: 'Hamnen Transit', length: 5.3, width: 2.0, height: 2.25, maxSpeed: 34, accel: 6, brake: 13, grip: 7.5, steer: 0.55, mass: 2400, health: 1100, profile: [0.97, 0.86, 0.8, 0.02, 0.01], belt: 1.15, wheelRadius: 0.36 },
  sports: { type: 'sports', name: 'Hisingen GT', length: 4.45, width: 1.95, height: 1.22, maxSpeed: 60, accel: 14, brake: 20, grip: 9.5, steer: 0.55, mass: 1350, health: 650, profile: [0.96, 0.66, 0.5, 0.28, 0.12], belt: 0.82, wheelRadius: 0.34 },
  police: { type: 'police', name: 'Polis Kombi', length: 4.85, width: 1.85, height: 1.5, maxSpeed: 52, accel: 12, brake: 18, grip: 9.5, steer: 0.6, mass: 1700, health: 1200, profile: [0.95, 0.72, 0.6, 0.06, 0.03], belt: 0.95, wheelRadius: 0.34 },
  tram: { type: 'tram', name: 'Spårvagn', length: 9.6, width: 2.65, height: 3.4, maxSpeed: 14, accel: 1.2, brake: 3, grip: 20, steer: 0, mass: 30000, health: 1e9, profile: [1, 1, 1, 0, 0], belt: 1.3, wheelRadius: 0.35 },
  taxi: { type: 'taxi', name: 'Taxi', length: 4.7, width: 1.85, height: 1.45, maxSpeed: 44, accel: 9, brake: 17, grip: 8.5, steer: 0.58, mass: 1450, health: 800, profile: [0.95, 0.7, 0.55, 0.26, 0.14], belt: 0.95, wheelRadius: 0.33 },
};

const PAINTS = ['#b3261e', '#1f4e9c', '#e8e8e8', '#1b1b1d', '#6d7178', '#a9aeb4', '#2f6b3a', '#7a1f2b', '#d9a620', '#12304f', '#5a3d2b', '#c96f1a', '#3b8fb5', '#f2efe6'];

export function randomPaint(): string {
  return PAINTS[Math.floor(Math.random() * PAINTS.length)];
}

const extrudeCache = new Map<string, { body: THREE.BufferGeometry; glass: THREE.BufferGeometry }>();

/** Extruded side-profile body + glasshouse geometry, shared per vehicle type. */
function bodyGeometry(spec: VehicleSpec) {
  const cached = extrudeCache.get(spec.type);
  if (cached) return cached;
  const L = spec.length;
  const H = spec.height;
  const W = spec.width;
  const bevel = 0.06;
  const [hood, ws, roofStart, roofEnd, rear] = spec.profile;
  // Profile in (x = along length from rear, y = height). Front is +x.
  const x = (f: number) => -L / 2 + f * L;
  const bottom = 0.28;
  const belt = spec.belt;
  const body = new THREE.Shape();
  body.moveTo(x(0) + bevel, bottom + bevel);
  body.lineTo(x(1) - bevel, bottom + bevel);
  body.lineTo(x(1) - bevel, belt - 0.12);
  body.lineTo(x(hood) - bevel, belt - bevel);
  body.lineTo(x(ws), belt);
  body.lineTo(x(roofStart), H - bevel);
  body.lineTo(x(roofEnd), H - bevel);
  body.lineTo(x(rear), belt);
  body.lineTo(x(0) + bevel, belt - 0.05);
  body.closePath();
  const depth = W - bevel * 2;
  const opts = { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 1 };
  const bodyGeom = new THREE.ExtrudeGeometry(body, opts);
  bodyGeom.translate(0, 0, -depth / 2);
  bodyGeom.rotateY(-Math.PI / 2);

  // Glass: the cabin polygon, pushed slightly outwards so it sits on top of the body surface.
  const g = new THREE.Shape();
  const o = 0.035;
  g.moveTo(x(ws) + 0.08 + o, belt + 0.04);
  g.lineTo(x(roofStart) + o * 0.6, H - bevel - 0.07);
  g.lineTo(x(roofEnd) - o * 0.6, H - bevel - 0.07);
  g.lineTo(x(rear) - 0.06 - o, belt + 0.04);
  g.closePath();
  const gDepth = W + 0.03;
  const glassGeom = new THREE.ExtrudeGeometry(g, { depth: gDepth, bevelEnabled: false });
  glassGeom.translate(0, 0, -gDepth / 2);
  glassGeom.rotateY(-Math.PI / 2);
  const res = { body: bodyGeom, glass: glassGeom };
  extrudeCache.set(spec.type, res);
  return res;
}

const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 14).rotateZ(Math.PI / 2);
const hubGeom = new THREE.CylinderGeometry(0.6, 0.6, 1.02, 8).rotateZ(Math.PI / 2);

/** Visual representation of a vehicle: body, glass, wheels, lights and (for police) a light bar. */
export class VehicleModel {
  readonly root = new THREE.Group();
  readonly bodyGroup = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  private readonly frontWheels: THREE.Group[] = [];
  private readonly bodyMesh: THREE.Mesh;
  private readonly lightBar: THREE.Mesh[] = [];
  private readonly brakeLights: THREE.Mesh[] = [];
  private wheelSpin = 0;

  constructor(
    readonly spec: VehicleSpec,
    color: string,
  ) {
    this.root.add(this.bodyGroup);
    if (spec.type === 'tram') {
      this.bodyMesh = this.buildTram(color);
      return;
    }
    const geo = bodyGeometry(spec);
    this.bodyMesh = new THREE.Mesh(geo.body, paintMaterial(color, 0.35, 0.45));
    this.bodyMesh.castShadow = true;
    this.bodyGroup.add(this.bodyMesh);
    const glass = new THREE.Mesh(geo.glass, paintMaterial('#1d2630', 0.08, 0.6));
    this.bodyGroup.add(glass);

    const L = spec.length;
    const W = spec.width;
    const r = spec.wheelRadius;
    const add = (color: string, w: number, h: number, d: number, px: number, py: number, pz: number, emissive = false) => {
      const mat = emissive ? new THREE.MeshBasicMaterial({ color }) : lambertMaterial(color);
      const m = new THREE.Mesh(unitBox, mat);
      m.scale.set(w, h, d);
      m.position.set(px, py, pz);
      this.bodyGroup.add(m);
      return m;
    };
    // Bumpers, lights, grille.
    add('#222326', W * 0.98, 0.18, 0.12, 0, 0.38, L / 2 - 0.02);
    add('#222326', W * 0.98, 0.18, 0.12, 0, 0.38, -L / 2 + 0.02);
    for (const s of [-1, 1]) {
      add('#fff8e0', 0.32, 0.12, 0.04, s * (W / 2 - 0.26), spec.belt - 0.22, L / 2 + 0.005, true);
      this.brakeLights.push(add('#7a0d0d', 0.3, 0.12, 0.04, s * (W / 2 - 0.24), spec.belt - 0.2, -L / 2 - 0.005, true));
    }
    add('#18191b', W * 0.45, 0.12, 0.03, 0, spec.belt - 0.26, L / 2 + 0.01);

    if (spec.type === 'police') {
      // Swedish-style livery: blue and yellow band along the sides.
      for (const s of [-1, 1]) {
        add('#1c4fb8', 0.02, 0.16, L * 0.86, s * (W / 2 + 0.005), spec.belt - 0.3, 0);
        add('#e4d31d', 0.02, 0.1, L * 0.86, s * (W / 2 + 0.005), spec.belt - 0.43, 0);
      }
      const barZ = -L / 2 + L * ((spec.profile[2] + spec.profile[3]) / 2);
      add('#1a1a1a', W * 0.7, 0.06, 0.28, 0, spec.height + 0.02, barZ);
      for (const s of [-1, 1]) this.lightBar.push(add('#0b2a8a', W * 0.33, 0.1, 0.24, s * W * 0.18, spec.height + 0.1, barZ, true));
    }
    if (spec.type === 'taxi') {
      const z = -L / 2 + L * ((spec.profile[2] + spec.profile[3]) / 2);
      add('#f4d21f', 0.5, 0.16, 0.22, 0, spec.height + 0.08, z, true);
    }

    for (const [sx, sz] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * (W / 2 - 0.16), r, sz * (L / 2 - Math.max(0.72, L * 0.17)));
      const tyre = new THREE.Mesh(wheelGeom, lambertMaterial('#161616'));
      tyre.scale.set(0.24, r, r);
      tyre.castShadow = true;
      const hub = new THREE.Mesh(hubGeom, lambertMaterial('#9ea3a8'));
      hub.scale.set(0.24, r, r);
      const spin = new THREE.Group();
      spin.add(tyre, hub);
      pivot.add(spin);
      this.root.add(pivot);
      this.wheels.push(spin);
      if (sz > 0) this.frontWheels.push(pivot);
    }
  }

  /** One articulated tram section in Gothenburg's blue-and-white. */
  private buildTram(accent: string): THREE.Mesh {
    const { length: L, width: W, height: H } = this.spec;
    const box = (color: string, w: number, h: number, d: number, x: number, y: number, z: number, basic = false) => {
      const m = new THREE.Mesh(unitBox, basic ? new THREE.MeshBasicMaterial({ color }) : paintMaterial(color, 0.4, 0.2));
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.bodyGroup.add(m);
      return m;
    };
    const body = box('#f2f4f5', W, H - 0.45, L, 0, 0.45 + (H - 0.45) / 2, 0);
    box(accent, W + 0.02, 0.5, L + 0.02, 0, 0.8, 0);
    box('#1b232c', W + 0.03, 1.1, L - 0.8, 0, 1.95, 0); // window band
    box(accent, W + 0.02, 0.18, L + 0.02, 0, 2.7, 0);
    box('#2a2d31', W * 0.9, 0.35, L - 1.2, 0, 0.3, 0); // bogies/skirt
    box('#50555c', 1.2, 0.25, 2.2, 0, H + 0.12, 0); // roof equipment
    return body;
  }

  /** Burnt-out look after an explosion. */
  setWrecked() {
    this.bodyMesh.material = lambertMaterial('#1c1a19');
    for (const m of this.lightBar) m.visible = false;
  }

  animate(dt: number, forwardSpeed: number, steer: number, braking: boolean, sirenOn: boolean, time: number) {
    this.wheelSpin += (forwardSpeed / this.spec.wheelRadius) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.frontWheels) p.rotation.y = steer * this.spec.steer;
    for (const b of this.brakeLights) (b.material as THREE.MeshBasicMaterial).color.set(braking ? '#ff2a1a' : '#7a0d0d');
    if (this.lightBar.length) {
      const phase = Math.floor(time * 6) % 2;
      this.lightBar.forEach((m, i) => {
        (m.material as THREE.MeshBasicMaterial).color.set(sirenOn && (i === phase) ? '#3d7bff' : sirenOn ? '#0a1d6e' : '#0b2a8a');
      });
    }
  }
}
