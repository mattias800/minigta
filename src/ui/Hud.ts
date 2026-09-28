import { WEAPONS, type WeaponId } from '../game/weapons';
import { Minimap, type Blip } from './Minimap';
import type { World } from '../world/World';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export interface HudState {
  health: number;
  maxHealth: number;
  armor: number;
  money: number;
  stars: number;
  starsFlashing: boolean;
  weapon: WeaponId;
  clip: number;
  reserve: number;
  reloading: boolean;
  crosshair: boolean;
  hint: string | null;
  loading: string | null;
}

/** DOM heads-up display: wanted stars, money, weapon, health, minimap and GTA-style captions. */
export class Hud {
  readonly root: HTMLElement;
  readonly minimap = new Minimap(210);
  private readonly stars: HTMLElement[] = [];
  private readonly money: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly ammo: HTMLElement;
  private readonly healthBar: HTMLElement;
  private readonly armorBar: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly street: HTMLElement;
  private readonly district: HTMLElement;
  private readonly vehicleName: HTMLElement;
  private readonly radio: HTMLElement;
  private readonly big: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly subtitle: HTMLElement;
  private streetTimer = 0;
  private vehicleTimer = 0;
  private radioTimer = 0;
  private subtitleTimer = 0;
  private lastStreet = '';
  private lastDistrict = '';
  private moneyShown = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud hidden', parent);
    const tr = el('div', 'hud-tr', this.root);
    const starRow = el('div', 'stars', tr);
    for (let i = 0; i < 5; i++) this.stars.push(el('span', 'star', starRow, '★'));
    this.money = el('div', 'money', tr, '0 kr');
    const wrow = el('div', 'weapon-row', tr);
    this.weapon = el('div', 'weapon', wrow);
    this.ammo = el('div', 'ammo', wrow);

    const bl = el('div', 'hud-bl', this.root);
    bl.appendChild(this.minimap.canvas);
    const bars = el('div', 'bars', bl);
    this.healthBar = el('div', 'bar-fill health', el('div', 'bar', bars));
    this.armorBar = el('div', 'bar-fill armor', el('div', 'bar', bars));

    const br = el('div', 'hud-br', this.root);
    this.vehicleName = el('div', 'vehicle-name caption', br);
    this.radio = el('div', 'radio caption', br);
    this.district = el('div', 'district caption', br);
    this.street = el('div', 'street caption', br);

    this.crosshair = el('div', 'crosshair', this.root);
    this.hint = el('div', 'hint', this.root);
    this.big = el('div', 'big-text', this.root);
    this.feed = el('div', 'feed', this.root);
    this.subtitle = el('div', 'subtitle', this.root);
    this.loading = el('div', 'loading-pill', this.root);
  }

  update(dt: number, s: HudState, time: number) {
    // Wanted stars: filled up to level; flash while the police search for you.
    this.stars.forEach((e, i) => {
      const on = i < s.stars;
      e.classList.toggle('on', on && (!s.starsFlashing || Math.floor(time * 3) % 2 === 0));
      e.classList.toggle('dim', on && s.starsFlashing);
    });
    // Money counts up like in the games.
    const diff = s.money - this.moneyShown;
    this.moneyShown += Math.abs(diff) < 2 ? diff : diff * Math.min(1, dt * 6);
    this.money.textContent = `${Math.round(this.moneyShown).toLocaleString('sv-SE')} kr`;

    const def = WEAPONS[s.weapon];
    this.weapon.textContent = def.name;
    this.ammo.textContent = def.melee ? '' : s.reloading ? 'reloading…' : `${s.clip} / ${s.reserve}`;
    this.healthBar.style.width = `${Math.max(0, (s.health / s.maxHealth) * 100)}%`;
    this.healthBar.classList.toggle('low', s.health < s.maxHealth * 0.25);
    this.armorBar.style.width = `${Math.max(0, Math.min(100, s.armor))}%`;
    this.crosshair.style.display = s.crosshair ? 'block' : 'none';
    this.hint.textContent = s.hint ?? '';
    this.hint.style.display = s.hint ? 'block' : 'none';
    this.loading.textContent = s.loading ?? '';
    this.loading.style.display = s.loading ? 'block' : 'none';

    for (const [e, key] of [
      [this.street, 'streetTimer'],
      [this.district, 'streetTimer'],
      [this.vehicleName, 'vehicleTimer'],
      [this.radio, 'radioTimer'],
      [this.subtitle, 'subtitleTimer'],
    ] as const) {
      e.style.opacity = this[key] > 0 ? String(Math.min(1, this[key])) : '0';
    }
    this.streetTimer -= dt;
    this.vehicleTimer -= dt;
    this.radioTimer -= dt;
    this.subtitleTimer -= dt;
  }

  setVisible(visible: boolean) {
    this.root.classList.toggle('hidden', !visible);
  }

  drawMinimap(world: World, x: number, z: number, yaw: number, metersPerPx: number, blips: Blip[], alert: string | null) {
    this.minimap.draw(world, x, z, yaw, metersPerPx, blips, alert);
  }

  /** Shows street/district captions when they change. */
  setLocation(street: string | null, district: string | null) {
    const st = street ?? '';
    const di = district ?? '';
    if (st !== this.lastStreet || di !== this.lastDistrict) {
      if (st && st !== this.lastStreet) this.streetTimer = 5;
      if (di !== this.lastDistrict) this.streetTimer = 5;
      this.lastStreet = st || this.lastStreet;
      this.lastDistrict = di;
      this.street.textContent = this.lastStreet;
      this.district.textContent = di;
    }
  }

  showVehicle(name: string) {
    this.vehicleName.textContent = name;
    this.vehicleTimer = 4;
  }

  showRadio(name: string) {
    this.radio.textContent = name;
    this.radioTimer = 4;
  }

  subtitleText(text: string, seconds = 5) {
    this.subtitle.textContent = text;
    this.subtitleTimer = seconds;
  }

  /** Big centered caption like WASTED / BUSTED. */
  bigText(text: string | null, cls = '') {
    this.big.textContent = text ?? '';
    this.big.className = `big-text ${cls} ${text ? 'show' : ''}`;
  }

  notify(text: string) {
    const n = el('div', 'feed-item', this.feed, text);
    setTimeout(() => n.classList.add('fade'), 2500);
    setTimeout(() => n.remove(), 3200);
  }
}
