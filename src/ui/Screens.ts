import { CHUNK_SIZE } from '../config';
import type { Projection } from '../geo/projection';
import type { World } from '../world/World';
import { MAP_COLORS } from './minimapTiles';

export interface ScreenCallbacks {
  onPlay: () => void;
  onResume: () => void;
  onTeleport: (lat: number, lon: number, name: string) => void;
}

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move / drive'],
  ['Mouse', 'Look / aim'],
  ['Left click', 'Shoot / punch'],
  ['Right click', 'Aim'],
  ['Shift', 'Sprint'],
  ['Space', 'Jump / handbrake'],
  ['F', 'Enter / exit / hijack vehicle'],
  ['1–4 / wheel', 'Switch weapon'],
  ['R', 'Reload'],
  ['H', 'Horn'],
  ['Q', 'Next radio station'],
  ['M', 'Map'],
  ['Esc', 'Pause'],
];

export const TELEPORTS: { name: string; lat: number; lon: number }[] = [
  { name: 'Göteborg', lat: 57.7072, lon: 11.9668 },
  { name: 'Stockholm', lat: 59.3251, lon: 18.0711 },
  { name: 'Malmö', lat: 55.605, lon: 13.0007 },
  { name: 'Copenhagen', lat: 55.6786, lon: 12.5695 },
  { name: 'London', lat: 51.5116, lon: -0.1318 },
  { name: 'Paris', lat: 48.8584, lon: 2.3470 },
  { name: 'New York', lat: 40.758, lon: -73.9855 },
  { name: 'Tokyo', lat: 35.6595, lon: 139.7005 },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

function controlsGrid(parent: HTMLElement) {
  const grid = el('div', 'controls', parent);
  for (const [k, v] of CONTROLS) el('div', '', grid, `<b>${k}</b> ${v}`);
}

/** Title, loading, pause and full-map overlays. */
export class Screens {
  private readonly title: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly map: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly loadingPlace: HTMLElement;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly mapCaption: HTMLElement;

  constructor(parent: HTMLElement, cb: ScreenCallbacks) {
    this.title = el('div', 'screen', parent);
    el('div', 'logo', this.title, '<span class="l1">Grand Theft</span><span class="l2">Göteborg</span>');
    el('div', 'tagline', this.title, 'A tiny open-world crime game on real OpenStreetMap streets');
    const play = el('button', 'btn', this.title, 'Play');
    play.addEventListener('click', () => cb.onPlay());
    controlsGrid(this.title);

    this.loading = el('div', 'screen hidden', parent);
    el('div', 'logo', this.loading, '<span class="l1">Loading</span>');
    this.loadingPlace = el('div', 'tagline', this.loading);
    this.progressBar = el('div', '', el('div', 'progress', this.loading));
    this.status = el('div', 'status', this.loading);

    this.pause = el('div', 'screen hidden', parent);
    el('div', 'pause-title', this.pause, 'PAUSED');
    const resume = el('button', 'btn', this.pause, 'Resume');
    resume.addEventListener('click', () => cb.onResume());
    controlsGrid(this.pause);
    el('div', 'tagline', this.pause, 'Travel to another city (streams live map data)').style.marginTop = '30px';
    const tp = el('div', 'teleports', this.pause);
    for (const t of TELEPORTS) {
      const b = el('button', 'btn small', tp, t.name);
      b.addEventListener('click', () => cb.onTeleport(t.lat, t.lon, t.name));
    }

    this.map = el('div', 'fullmap hidden', parent);
    this.map.style.display = 'none';
    this.mapCanvas = el('canvas', '', this.map);
    this.mapCaption = el('div', 'caption-map', this.map);

    const attr = el('div', 'attribution', parent, 'Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>');
    attr.title = 'Open Database License (ODbL)';
  }

  hideAll() {
    for (const s of [this.title, this.loading, this.pause]) s.classList.add('hidden');
  }

  showLoading(place: string) {
    this.hideAll();
    this.loadingPlace.textContent = place;
    this.loading.classList.remove('hidden');
  }

  setProgress(p: number, status: string) {
    this.progressBar.style.width = `${Math.round(p * 100)}%`;
    this.status.textContent = status;
  }

  showPause() {
    this.hideAll();
    this.pause.classList.remove('hidden');
  }

  /** Full-screen map of all loaded chunks (north up). Pass null to close. */
  showMap(opts: { world: World; x: number; z: number; heading: number; projection: Projection } | null) {
    if (!opts) {
      this.map.style.display = 'none';
      return;
    }
    const { world, x, z, heading, projection } = opts;
    const chunks = [...world.loadedChunks()];
    if (!chunks.length) return;
    const minCx = Math.min(...chunks.map((c) => c.cx));
    const maxCx = Math.max(...chunks.map((c) => c.cx));
    const minCz = Math.min(...chunks.map((c) => c.cz));
    const maxCz = Math.max(...chunks.map((c) => c.cz));
    const worldW = (maxCx - minCx + 1) * CHUNK_SIZE;
    const worldH = (maxCz - minCz + 1) * CHUNK_SIZE;
    const size = Math.min(window.innerWidth * 0.9, window.innerHeight * 0.82);
    const scale = size / Math.max(worldW, worldH);
    const c = this.mapCanvas;
    c.width = worldW * scale;
    c.height = worldH * scale;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = MAP_COLORS.background;
    ctx.fillRect(0, 0, c.width, c.height);
    for (const ch of chunks) {
      const tile = world.mapTile(ch.cx, ch.cz);
      if (tile) ctx.drawImage(tile, (ch.cx - minCx) * CHUNK_SIZE * scale, (ch.cz - minCz) * CHUNK_SIZE * scale, CHUNK_SIZE * scale + 1, CHUNK_SIZE * scale + 1);
    }
    const px = (x - minCx * CHUNK_SIZE) * scale;
    const pz = (z - minCz * CHUNK_SIZE) * scale;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-heading);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(8, -8);
    ctx.lineTo(0, -3);
    ctx.lineTo(-8, -8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    const ll = projection.toLatLon(x, z);
    this.mapCaption.textContent = `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)} — press M to close`;
    this.map.style.display = 'flex';
  }
}
