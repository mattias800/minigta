import * as THREE from 'three';
import type { Character } from '../entities/Character';
import { lambertMaterial } from '../render/materialCache';
import { WEAPONS, type WeaponId } from './weapons';

export type PickupKind = 'cash' | 'weapon' | 'health' | 'armor';

interface Pickup {
  kind: PickupKind;
  amount: number;
  weapon?: WeaponId;
  mesh: THREE.Object3D;
  age: number;
  /** Respawning pickups reappear after being collected (seconds, 0 = one-shot). */
  respawn: number;
  hiddenFor: number;
  ttl: number;
}

const cashGeom = new THREE.BoxGeometry(0.5, 0.08, 0.25);
const boxGeom = new THREE.BoxGeometry(0.6, 0.35, 0.35);
const crossGeom = new THREE.BoxGeometry(0.5, 0.16, 0.16);

function glowMaterial(color: string) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false });
}

/** Collectable items: dropped cash, weapons and health/armor. */
export class Pickups {
  readonly group = new THREE.Group();
  private readonly items: Pickup[] = [];
  private readonly beamGeom = new THREE.CylinderGeometry(0.45, 0.45, 2.2, 12, 1, true);
  /** Ground height lookup (set by the game). */
  ground: (x: number, z: number) => number = () => 0;

  add(kind: PickupKind, x: number, z: number, amount: number, weapon?: WeaponId, respawn = 0) {
    const g = new THREE.Group();
    if (kind === 'cash') {
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(cashGeom, lambertMaterial('#3fae49'));
        m.position.y = i * 0.09;
        m.rotation.y = i * 0.4;
        g.add(m);
      }
    } else if (kind === 'weapon') {
      g.add(new THREE.Mesh(boxGeom, lambertMaterial('#2b2b2e')));
      const stripe = new THREE.Mesh(boxGeom, lambertMaterial('#e6b422'));
      stripe.scale.set(1.02, 0.25, 1.02);
      g.add(stripe);
    } else {
      const color = kind === 'health' ? '#e53935' : '#1e88e5';
      const a = new THREE.Mesh(crossGeom, lambertMaterial(color));
      const b = a.clone();
      b.rotation.z = Math.PI / 2;
      g.add(a, b);
    }
    const beamColor = kind === 'cash' ? '#57e36a' : kind === 'weapon' ? '#ffd24a' : kind === 'health' ? '#ff5252' : '#4fa3ff';
    const beam = new THREE.Mesh(this.beamGeom, glowMaterial(beamColor));
    beam.position.y = 0.6;
    const holder = new THREE.Group();
    holder.add(g, beam);
    g.position.y = 0.6;
    holder.position.set(x, this.ground(x, z), z);
    this.group.add(holder);
    this.items.push({ kind, amount, weapon, mesh: holder, age: Math.random() * 10, respawn, hiddenFor: 0, ttl: respawn ? Infinity : kind === 'cash' ? 60 : 90 });
  }

  clearDropped() {
    for (const p of [...this.items]) if (!p.respawn) this.remove(p);
  }

  private remove(p: Pickup) {
    this.group.remove(p.mesh);
    this.items.splice(this.items.indexOf(p), 1);
  }

  /** Returns labels of the pickups collected this frame. */
  update(dt: number, player: Character, give: (p: { kind: PickupKind; amount: number; weapon?: WeaponId }) => boolean): string[] {
    const labels: string[] = [];
    for (const p of [...this.items]) {
      p.age += dt;
      p.ttl -= dt;
      if (p.ttl <= 0) {
        this.remove(p);
        continue;
      }
      if (p.hiddenFor > 0) {
        p.hiddenFor -= dt;
        p.mesh.visible = p.hiddenFor <= 0;
        continue;
      }
      const inner = p.mesh.children[0];
      inner.rotation.y = p.age * 2;
      inner.position.y = 0.6 + Math.sin(p.age * 3) * 0.1;
      if (!player.alive || player.vehicle) continue;
      const dx = player.pos.x - p.mesh.position.x;
      const dz = player.pos.z - p.mesh.position.z;
      if (dx * dx + dz * dz > 1.2 || Math.abs(player.pos.y - p.mesh.position.y) > 2) continue;
      if (!give(p)) continue;
      labels.push(p.kind === 'cash' ? `+ ${p.amount} kr` : p.kind === 'weapon' ? `${WEAPONS[p.weapon!].name} (+${p.amount})` : p.kind === 'health' ? 'Health' : 'Body armor');
      if (p.respawn) {
        p.hiddenFor = p.respawn;
        p.mesh.visible = false;
      } else this.remove(p);
    }
    return labels;
  }
}
