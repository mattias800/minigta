import * as THREE from 'three';
import { clamp, lerp } from '../core/math';
import { lambertMaterial, unitBox } from '../render/materialCache';

export interface CharacterLook {
  skin: string;
  shirt: string;
  pants: string;
  hair: string;
  shoes: string;
  hat?: string;
  /** 0.9..1.1 body scale. */
  size: number;
}

export type Pose = 'stand' | 'aim' | 'dead' | 'down' | 'swim' | 'punch';

function box(color: string, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(unitBox, lambertMaterial(color));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Blocky low-poly humanoid built from boxes, with a procedural walk/run/aim animation. */
export class CharacterModel {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly gun: THREE.Mesh;
  private phase = Math.random() * 10;
  private lie = 0;
  private punchT = 0;

  constructor(look: CharacterLook) {
    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = 0.95;
    this.hips.add(this.torso);

    this.torso.add(box(look.shirt, 0.48, 0.62, 0.27, 0, 0.33, 0));
    this.torso.add(box(look.pants, 0.46, 0.14, 0.26, 0, 0.02, 0));

    this.head.position.y = 0.66;
    this.torso.add(this.head);
    this.head.add(box(look.skin, 0.13, 0.08, 0.13, 0, 0.04, 0)); // neck
    this.head.add(box(look.skin, 0.25, 0.27, 0.25, 0, 0.21, 0));
    this.head.add(box(look.hair, 0.27, 0.08, 0.27, 0, 0.36, -0.01));
    this.head.add(box(look.hair, 0.27, 0.14, 0.06, 0, 0.27, -0.12));
    this.head.add(box('#1a1a1a', 0.04, 0.03, 0.02, -0.06, 0.24, 0.125)); // eyes
    this.head.add(box('#1a1a1a', 0.04, 0.03, 0.02, 0.06, 0.24, 0.125));
    if (look.hat) {
      this.head.add(box(look.hat, 0.29, 0.08, 0.29, 0, 0.39, 0));
      this.head.add(box(look.hat, 0.27, 0.03, 0.14, 0, 0.36, 0.18)); // cap brim
    }

    for (const [arm, side] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as const) {
      arm.position.set(side * 0.31, 0.6, 0);
      arm.add(box(look.shirt, 0.14, 0.3, 0.15, 0, -0.13, 0));
      arm.add(box(look.skin, 0.12, 0.3, 0.12, 0, -0.42, 0));
      arm.add(box(look.skin, 0.12, 0.1, 0.13, 0, -0.6, 0.01));
      this.torso.add(arm);
    }
    this.gun = box('#1c1c1e', 0.07, 0.12, 0.3, 0, -0.62, 0.1);
    this.gun.visible = false;
    this.armR.add(this.gun);

    for (const [leg, side] of [
      [this.legL, -1],
      [this.legR, 1],
    ] as const) {
      leg.position.set(side * 0.12, 0, 0);
      leg.add(box(look.pants, 0.18, 0.9, 0.2, 0, -0.45, 0));
      leg.add(box(look.shoes, 0.19, 0.1, 0.3, 0, -0.9, 0.05));
      this.hips.add(leg);
    }
    this.root.scale.setScalar(look.size);
  }

  setGun(kind: 'none' | 'pistol' | 'smg' | 'shotgun') {
    this.gun.visible = kind !== 'none';
    const len = kind === 'shotgun' ? 0.75 : kind === 'smg' ? 0.45 : 0.28;
    this.gun.scale.z = len;
    this.gun.position.z = 0.02 + len / 2;
  }

  punch() {
    this.punchT = 0.3;
  }

  /**
   * @param speed ground speed in m/s
   * @param aimPitch radians, positive = up
   */
  animate(dt: number, speed: number, pose: Pose, aimPitch = 0) {
    const lying = pose === 'dead' || pose === 'down';
    this.lie = lerp(this.lie, lying ? 1 : 0, clamp(dt * (lying ? 7 : 3), 0, 1));
    this.body.rotation.x = -this.lie * Math.PI * 0.5;
    this.body.position.y = this.lie * 0.16;
    this.body.position.z = -this.lie * 0.2;
    if (lying) {
      this.armL.rotation.set(0, 0, -0.9 * this.lie);
      this.armR.rotation.set(0, 0, 0.9 * this.lie);
      this.legL.rotation.set(0, 0, -0.15);
      this.legR.rotation.set(0, 0, 0.15);
      return;
    }

    const running = speed > 3.2;
    this.phase += dt * (running ? 1.9 : 2.4) * Math.min(speed, 8);
    const swing = Math.sin(this.phase);
    const amp = clamp(speed / 3, 0, 1) * (running ? 0.95 : 0.55);
    this.legL.rotation.x = swing * amp;
    this.legR.rotation.x = -swing * amp;
    this.hips.position.y = 0.95 + Math.abs(Math.cos(this.phase)) * amp * 0.06;
    this.torso.rotation.x = running ? 0.18 : 0.03;
    this.armL.rotation.set(-swing * amp * 0.9, 0, -0.06);
    this.armR.rotation.set(swing * amp * 0.9, 0, 0.06);

    if (pose === 'aim') {
      this.armR.rotation.set(-Math.PI / 2 - aimPitch + this.torso.rotation.x * -1, 0, 0);
      this.armL.rotation.set(-Math.PI / 2.2 - aimPitch, 0, 0.55);
    }
    if (this.punchT > 0) {
      this.punchT -= dt;
      const t = Math.sin(clamp(this.punchT / 0.3, 0, 1) * Math.PI);
      this.armR.rotation.set(-Math.PI / 2 * t - 0.2, 0, 0);
    }
    if (pose === 'swim') {
      this.torso.rotation.x = 1.2;
      this.armL.rotation.set(-2.5 + swing * 0.8, 0, -0.3);
      this.armR.rotation.set(-2.5 - swing * 0.8, 0, 0.3);
      this.body.position.y = -1.0;
    } else {
      this.body.position.y = this.lie * 0.16;
    }
    // Idle breathing.
    if (speed < 0.1) this.torso.scale.y = 1 + Math.sin(this.phase * 0.2 + performance.now() * 0.002) * 0.01;
  }
}

const SKINS = ['#f1c7a5', '#e0ac85', '#c68863', '#8d5a3c', '#5c3a26', '#f6d7c0'];
const HAIR = ['#2b1d14', '#4a3222', '#a07040', '#d9c07a', '#1a1a1a', '#6b6b6b', '#8a3b1e'];
const SHIRTS = ['#c0392b', '#2c3e50', '#27ae60', '#8e44ad', '#f39c12', '#ecf0f1', '#16a085', '#34495e', '#d35400', '#7f8c8d', '#e84393', '#1e3799', '#f5f6fa', '#2d3436'];
const PANTS = ['#2c3e50', '#1e272e', '#34495e', '#4b4b4b', '#6d4c41', '#3d5a80', '#222222', '#c8b99a'];
const SHOES = ['#111111', '#3e2723', '#dddddd', '#5d4037'];

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function randomCivilianLook(): CharacterLook {
  return { skin: pick(SKINS), hair: pick(HAIR), shirt: pick(SHIRTS), pants: pick(PANTS), shoes: pick(SHOES), size: 0.92 + Math.random() * 0.16 };
}

export function copLook(): CharacterLook {
  return { skin: pick(SKINS), hair: pick(HAIR), shirt: '#1f2f4f', pants: '#16213a', shoes: '#0d0d0d', hat: '#15213b', size: 1 };
}

export function playerLook(): CharacterLook {
  return { skin: '#e0ac85', hair: '#2b1d14', shirt: '#f2f2f2', pants: '#2f4a6d', shoes: '#1b1b1b', size: 1.02 };
}
