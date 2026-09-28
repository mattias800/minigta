export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Damage per hit (per pellet for shotguns). */
  damage: number;
  /** Shots per second. */
  rate: number;
  pellets: number;
  /** Cone half-angle in radians. */
  spread: number;
  range: number;
  clip: number;
  reloadTime: number;
  automatic: boolean;
  melee: boolean;
  model: 'none' | 'pistol' | 'smg' | 'shotgun';
  /** How loud the shot is for AI hearing (meters). */
  noise: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: { id: 'fists', name: 'Fists', damage: 12, rate: 2.2, pellets: 1, spread: 0, range: 1.7, clip: Infinity, reloadTime: 0, automatic: false, melee: true, model: 'none', noise: 8 },
  pistol: { id: 'pistol', name: 'Pistol', damage: 28, rate: 4, pellets: 1, spread: 0.012, range: 150, clip: 12, reloadTime: 1.1, automatic: false, melee: false, model: 'pistol', noise: 60 },
  smg: { id: 'smg', name: 'SMG', damage: 16, rate: 12, pellets: 1, spread: 0.035, range: 120, clip: 30, reloadTime: 1.6, automatic: true, melee: false, model: 'smg', noise: 70 },
  shotgun: { id: 'shotgun', name: 'Shotgun', damage: 14, rate: 1.2, pellets: 8, spread: 0.075, range: 45, clip: 6, reloadTime: 2.2, automatic: false, melee: false, model: 'shotgun', noise: 80 },
};

export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'smg', 'shotgun'];

interface Slot {
  /** Rounds in the magazine. */
  clip: number;
  /** Reserve rounds. */
  reserve: number;
}

/** Weapons and ammo carried by a character, plus fire-rate and reload timing. */
export class Inventory {
  private readonly slots = new Map<WeaponId, Slot>([['fists', { clip: Infinity, reserve: 0 }]]);
  current: WeaponId = 'fists';
  private cooldown = 0;
  private reloading = 0;

  get def(): WeaponDef {
    return WEAPONS[this.current];
  }

  get clip(): number {
    return this.slots.get(this.current)?.clip ?? 0;
  }

  get reserve(): number {
    return this.slots.get(this.current)?.reserve ?? 0;
  }

  get isReloading(): boolean {
    return this.reloading > 0;
  }

  has(id: WeaponId): boolean {
    return this.slots.has(id);
  }

  give(id: WeaponId, rounds: number) {
    const slot = this.slots.get(id);
    if (slot) {
      slot.reserve += rounds;
      if (slot.clip === 0) this.reload();
    } else {
      const clip = Math.min(WEAPONS[id].clip, rounds);
      this.slots.set(id, { clip, reserve: rounds - clip });
    }
  }

  clear() {
    for (const id of [...this.slots.keys()]) if (id !== 'fists') this.slots.delete(id);
    this.current = 'fists';
  }

  select(id: WeaponId): boolean {
    if (!this.slots.has(id) || id === this.current) return false;
    this.current = id;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.2);
    return true;
  }

  /** Cycles through owned weapons. */
  cycle(dir: number) {
    const owned = WEAPON_ORDER.filter((w) => this.slots.has(w));
    const i = owned.indexOf(this.current);
    this.select(owned[(i + dir + owned.length) % owned.length]);
  }

  update(dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const slot = this.slots.get(this.current)!;
        const n = Math.min(this.def.clip - slot.clip, slot.reserve);
        slot.clip += n;
        slot.reserve -= n;
      }
    }
  }

  reload(): boolean {
    const slot = this.slots.get(this.current);
    if (!slot || this.def.melee || this.reloading > 0 || slot.clip >= this.def.clip || slot.reserve <= 0) return false;
    this.reloading = this.def.reloadTime;
    return true;
  }

  /** Consumes one shot if the weapon is ready. Auto-reloads on an empty magazine. */
  tryFire(): boolean {
    if (this.cooldown > 0 || this.reloading > 0) return false;
    const slot = this.slots.get(this.current)!;
    if (slot.clip <= 0) {
      if (!this.reload() && slot.reserve <= 0 && this.current !== 'fists') this.cycle(-1);
      return false;
    }
    slot.clip -= 1;
    this.cooldown = 1 / this.def.rate;
    if (slot.clip <= 0) this.reload();
    return true;
  }
}
