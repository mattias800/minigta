import type * as THREE from 'three';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import type { GameContext } from './GameContext';

/** AI controller for a non-player character. */
export interface Brain {
  readonly kind: string;
  update(dt: number, ctx: GameContext): void;
}

/** Registry of all dynamic entities, their AI brains and scene membership. */
export class Entities {
  readonly characters: Character[] = [];
  readonly vehicles: Vehicle[] = [];
  private readonly brains = new Map<Character, Brain>();

  constructor(private readonly scene: THREE.Scene) {}

  addCharacter(c: Character, brain?: Brain): Character {
    this.characters.push(c);
    this.scene.add(c.object);
    if (brain) this.brains.set(c, brain);
    return c;
  }

  removeCharacter(c: Character) {
    const i = this.characters.indexOf(c);
    if (i >= 0) this.characters.splice(i, 1);
    this.scene.remove(c.object);
    this.brains.delete(c);
    if (c.vehicle && c.vehicle.driver === c) c.vehicle.driver = null;
    c.vehicle = null;
  }

  setBrain(c: Character, brain: Brain | null) {
    if (brain) this.brains.set(c, brain);
    else this.brains.delete(c);
  }

  brainOf(c: Character): Brain | undefined {
    return this.brains.get(c);
  }

  addVehicle(v: Vehicle): Vehicle {
    this.vehicles.push(v);
    this.scene.add(v.object);
    return v;
  }

  /** Removes a vehicle and its occupant (if it's an NPC). */
  removeVehicle(v: Vehicle) {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.scene.remove(v.object);
    if (v.driver && v.driver.role !== 'player') this.removeCharacter(v.driver);
    v.driver = null;
  }

  charactersNear(x: number, z: number, r: number, filter?: (c: Character) => boolean): Character[] {
    const r2 = r * r;
    return this.characters.filter((c) => {
      const dx = c.pos.x - x;
      const dz = c.pos.z - z;
      return dx * dx + dz * dz <= r2 && (!filter || filter(c));
    });
  }

  vehiclesNear(x: number, z: number, r: number, filter?: (v: Vehicle) => boolean): Vehicle[] {
    const r2 = r * r;
    return this.vehicles.filter((v) => {
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      return dx * dx + dz * dz <= r2 && (!filter || filter(v));
    });
  }

  updateBrains(dt: number, ctx: GameContext) {
    for (const c of [...this.characters]) {
      const b = this.brains.get(c);
      if (b && c.alive) b.update(dt, ctx);
    }
  }
}
