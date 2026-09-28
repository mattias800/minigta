import * as THREE from 'three';
import { rand } from '../core/math';
import { glowTexture, smokeTexture } from './textures';

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  gravity: number;
  drag: number;
}

const VERT = `
attribute float size;
attribute vec4 tint;
varying vec4 vTint;
uniform float uScale;
void main() {
  vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform sampler2D uMap;
varying vec4 vTint;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vTint.rgb * t.rgb, t.a * vTint.a);
  if (gl_FragColor.a < 0.01) discard;
  #include <colorspace_fragment>
}`;

/** A fixed-size pool of camera-facing point particles sharing one texture and blend mode. */
class ParticlePool {
  readonly points: THREE.Points;
  private readonly particles: Particle[];
  private readonly positions: Float32Array;
  private readonly sizes: Float32Array;
  private readonly tints: Float32Array;
  private cursor = 0;
  private readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, texture: THREE.Texture, additive: boolean) {
    this.particles = Array.from({ length: capacity }, () => ({
      alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1, gravity: 0, drag: 0,
    }));
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.tints = new Float32Array(capacity * 4);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('tint', new THREE.BufferAttribute(this.tints, 4).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uMap: { value: texture }, uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geom, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
  }

  setViewportHeight(h: number) {
    this.material.uniforms.uScale.value = h * 0.9;
  }

  spawn(p: Partial<Particle> & { x: number; y: number; z: number }) {
    const q = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.particles.length;
    Object.assign(q, { vx: 0, vy: 0, vz: 0, size0: 0.5, size1: 0.5, r: 1, g: 1, b: 1, alpha: 1, gravity: 0, drag: 0, maxLife: 1 }, p);
    q.life = q.maxLife;
    q.alive = true;
  }

  update(dt: number, ground: (x: number, z: number) => number) {
    const ps = this.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.alive) {
        this.sizes[i] = 0;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.sizes[i] = 0;
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k - p.gravity * dt;
      p.vz *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const g = p.gravity > 0 ? ground(p.x, p.z) + 0.02 : -Infinity;
      if (p.y < g) {
        p.y = g;
        p.vy *= -0.2;
        p.vx *= 0.5;
        p.vz *= 0.5;
      }
      const t = 1 - p.life / p.maxLife;
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
      this.sizes[i] = p.size0 + (p.size1 - p.size0) * t;
      this.tints[i * 4] = p.r;
      this.tints[i * 4 + 1] = p.g;
      this.tints[i * 4 + 2] = p.b;
      this.tints[i * 4 + 3] = p.alpha * Math.min(1, (1 - t) * 2.5);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.tint.needsUpdate = true;
  }
}

interface Tracer {
  life: number;
  maxLife: number;
}

/** Visual effects: particles, bullet tracers, flash lights, blood pools and camera shake. */
export class Effects {
  readonly group = new THREE.Group();
  private readonly glow = new ParticlePool(1500, glowTexture(), true);
  private readonly smoke = new ParticlePool(1500, smokeTexture(), false);
  private readonly tracerPositions: Float32Array;
  private readonly tracerColors: Float32Array;
  private readonly tracers: Tracer[];
  private readonly tracerLines: THREE.LineSegments;
  private tracerCursor = 0;
  private readonly lights: { light: THREE.PointLight; life: number; maxLife: number; intensity: number }[] = [];
  private lightCursor = 0;
  private readonly decals: THREE.Mesh[] = [];
  private decalCursor = 0;
  private readonly decalGeom = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
  /** Ground height lookup (set by the game) so debris bounces on the terrain. */
  ground: (x: number, z: number) => number = () => 0;
  /** Camera shake amount, decays over time; read by the camera rig. */
  shake = 0;

  constructor() {
    this.group.add(this.glow.points, this.smoke.points);
    const n = 96;
    this.tracers = Array.from({ length: n }, () => ({ life: 0, maxLife: 1 }));
    this.tracerPositions = new Float32Array(n * 6);
    this.tracerColors = new Float32Array(n * 6);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.tracerPositions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color', new THREE.BufferAttribute(this.tracerColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerLines = new THREE.LineSegments(
      geom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.tracerLines.frustumCulled = false;
    this.group.add(this.tracerLines);
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight('#ffb35c', 0, 18, 1.6);
      this.group.add(light);
      this.lights.push({ light, life: 0, maxLife: 1, intensity: 0 });
    }
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(this.decalGeom, new THREE.MeshLambertMaterial({ color: '#5a0a0a', transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -24 }));
      m.visible = false;
      m.renderOrder = 2;
      this.group.add(m);
      this.decals.push(m);
    }
  }

  setViewportHeight(h: number) {
    this.glow.setViewportHeight(h);
    this.smoke.setViewportHeight(h);
  }

  flash(x: number, y: number, z: number, intensity: number, duration: number, color = '#ffb35c') {
    const l = this.lights[this.lightCursor];
    this.lightCursor = (this.lightCursor + 1) % this.lights.length;
    l.light.position.set(x, y, z);
    l.light.color.set(color);
    l.life = l.maxLife = duration;
    l.intensity = intensity;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.glow.spawn({ x: pos.x + dir.x * 0.15, y: pos.y + dir.y * 0.15, z: pos.z + dir.z * 0.15, maxLife: 0.05, size0: 0.9, size1: 0.3, r: 1, g: 0.8, b: 0.4 });
    this.flash(pos.x, pos.y, pos.z, 6, 0.06);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3) {
    const i = this.tracerCursor;
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
    // Start the visible streak a little ahead of the muzzle.
    const p = this.tracerPositions;
    p.set([from.x, from.y, from.z, to.x, to.y, to.z], i * 6);
    this.tracers[i].life = this.tracers[i].maxLife = 0.07;
  }

  impact(x: number, y: number, z: number, nx: number, nz: number) {
    for (let i = 0; i < 6; i++) {
      this.glow.spawn({ x, y, z, vx: nx * rand(1, 4) + rand(-2, 2), vy: rand(0.5, 4), vz: nz * rand(1, 4) + rand(-2, 2), maxLife: rand(0.15, 0.35), size0: 0.12, size1: 0.04, r: 1, g: 0.75, b: 0.35, gravity: 12 });
    }
    this.smoke.spawn({ x, y, z, vx: nx * 0.8, vy: 0.4, vz: nz * 0.8, maxLife: 0.8, size0: 0.3, size1: 1.2, r: 0.7, g: 0.68, b: 0.64, alpha: 0.5, drag: 1 });
  }

  blood(x: number, y: number, z: number, dx: number, dz: number, amount = 8) {
    for (let i = 0; i < amount; i++) {
      this.smoke.spawn({ x, y, z, vx: dx * rand(0.5, 3) + rand(-1, 1), vy: rand(0, 3), vz: dz * rand(0.5, 3) + rand(-1, 1), maxLife: rand(0.4, 0.8), size0: 0.25, size1: 0.15, r: 0.55, g: 0.02, b: 0.02, alpha: 0.95, gravity: 12 });
    }
  }

  bloodPool(x: number, z: number, y = this.ground(x, z)) {
    const m = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;
    m.position.set(x + rand(-0.2, 0.2), y + 0.07, z + rand(-0.2, 0.2));
    m.scale.setScalar(0.1);
    m.userData.target = rand(0.7, 1.2);
    m.visible = true;
  }

  smokePuff(x: number, y: number, z: number, dark: number, size = 1) {
    const c = 0.75 - dark * 0.6;
    this.smoke.spawn({ x: x + rand(-0.3, 0.3), y, z: z + rand(-0.3, 0.3), vx: rand(-0.4, 0.4), vy: rand(1.5, 3), vz: rand(-0.4, 0.4), maxLife: rand(1.5, 2.5), size0: 0.6 * size, size1: 3.5 * size, r: c, g: c, b: c, alpha: 0.55, drag: 0.6 });
  }

  fire(x: number, y: number, z: number, size = 1) {
    this.glow.spawn({ x: x + rand(-0.5, 0.5) * size, y, z: z + rand(-0.5, 0.5) * size, vx: rand(-0.3, 0.3), vy: rand(2, 4), vz: rand(-0.3, 0.3), maxLife: rand(0.3, 0.6), size0: 1.4 * size, size1: 0.3, r: 1, g: rand(0.35, 0.6), b: 0.1, drag: 1 });
  }

  explosion(x: number, y: number, z: number) {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(3, 14);
      this.glow.spawn({ x, y: y + 0.5, z, vx: Math.cos(a) * s, vy: rand(1, 10), vz: Math.sin(a) * s, maxLife: rand(0.4, 0.9), size0: rand(2, 4), size1: 0.5, r: 1, g: rand(0.4, 0.7), b: 0.15, drag: 3 });
    }
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 5);
      this.smoke.spawn({ x, y: y + 1, z, vx: Math.cos(a) * s, vy: rand(1, 5), vz: Math.sin(a) * s, maxLife: rand(2, 4), size0: 2, size1: 7, r: 0.15, g: 0.14, b: 0.13, alpha: 0.7, drag: 1.2 });
    }
    for (let i = 0; i < 20; i++) {
      this.glow.spawn({ x, y: y + 1, z, vx: rand(-12, 12), vy: rand(4, 16), vz: rand(-12, 12), maxLife: rand(0.8, 1.6), size0: 0.25, size1: 0.1, r: 1, g: 0.7, b: 0.3, gravity: 18 });
    }
    this.flash(x, y + 2, z, 60, 0.6, '#ff9a3c');
    this.shake = Math.max(this.shake, 1);
  }

  dust(x: number, z: number) {
    this.smoke.spawn({ x, y: this.ground(x, z) + 0.2, z, vx: rand(-0.5, 0.5), vy: rand(0.2, 0.8), vz: rand(-0.5, 0.5), maxLife: 1.2, size0: 0.5, size1: 2, r: 0.55, g: 0.55, b: 0.55, alpha: 0.35, drag: 1 });
  }

  splash(x: number, z: number) {
    const y = this.ground(x, z) + 0.1;
    for (let i = 0; i < 20; i++) {
      this.smoke.spawn({ x, y, z, vx: rand(-3, 3), vy: rand(2, 6), vz: rand(-3, 3), maxLife: rand(0.5, 1), size0: 0.5, size1: 1.2, r: 0.8, g: 0.9, b: 1, alpha: 0.7, gravity: 10 });
    }
  }

  update(dt: number) {
    this.glow.update(dt, this.ground);
    this.smoke.update(dt, this.ground);
    this.shake = Math.max(0, this.shake - dt * 1.5);
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      const a = t.life > 0 ? t.life / t.maxLife : 0;
      t.life = Math.max(0, t.life - dt);
      this.tracerColors.set([a * 1, a * 0.85, a * 0.5, a * 0.5, a * 0.4, a * 0.2], i * 6);
    }
    this.tracerLines.geometry.attributes.position.needsUpdate = true;
    this.tracerLines.geometry.attributes.color.needsUpdate = true;
    for (const l of this.lights) {
      l.life = Math.max(0, l.life - dt);
      l.light.intensity = l.life > 0 ? l.intensity * (l.life / l.maxLife) : 0;
    }
    for (const d of this.decals) {
      if (!d.visible) continue;
      const target = d.userData.target as number;
      if (d.scale.x < target) d.scale.setScalar(Math.min(target, d.scale.x + dt * 0.4));
    }
  }

  clearDecals() {
    for (const d of this.decals) d.visible = false;
  }
}
