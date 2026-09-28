import { CHUNK_SIZE } from '../config';
import type { World } from '../world/World';
import { MAP_COLORS } from './minimapTiles';

export interface Blip {
  x: number;
  z: number;
  color: string;
  size?: number;
  /** Draw as a direction arrow with this heading. */
  heading?: number;
}

/** Rotating radar-style minimap drawn from pre-rendered chunk tiles. */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;

  constructor(size = 220) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  /**
   * @param yaw camera yaw; the map rotates so that "up" is where the camera looks.
   * @param metersPerPx zoom level
   */
  draw(world: World, cx: number, cz: number, yaw: number, metersPerPx: number, blips: Blip[], alert: string | null) {
    const ctx = this.ctx;
    const s = this.size;
    ctx.save();
    ctx.clearRect(0, 0, s, s);
    ctx.beginPath();
    ctx.roundRect(0, 0, s, s, 14);
    ctx.clip();
    ctx.fillStyle = MAP_COLORS.background;
    ctx.fillRect(0, 0, s, s);

    // World → screen: translate to center, rotate so camera forward points up, scale.
    ctx.translate(s / 2, s / 2);
    // Camera forward (sin yaw, cos yaw) must map to screen up (0, -1).
    ctx.rotate(Math.PI + yaw);
    const k = 1 / metersPerPx;
    ctx.scale(k, k);
    ctx.translate(-cx, -cz);
    ctx.imageSmoothingEnabled = true;

    const radius = (s / 2) * metersPerPx * 1.5;
    const c0x = Math.floor((cx - radius) / CHUNK_SIZE);
    const c1x = Math.floor((cx + radius) / CHUNK_SIZE);
    const c0z = Math.floor((cz - radius) / CHUNK_SIZE);
    const c1z = Math.floor((cz + radius) / CHUNK_SIZE);
    for (let x = c0x; x <= c1x; x++) {
      for (let z = c0z; z <= c1z; z++) {
        const tile = world.mapTile(x, z);
        if (!tile) continue;
        // Tiles are drawn with +x east and +z south, same as world axes.
        ctx.drawImage(tile, x * CHUNK_SIZE, z * CHUNK_SIZE, CHUNK_SIZE + 0.5, CHUNK_SIZE + 0.5);
      }
    }

    for (const b of blips) {
      const r = (b.size ?? 4) * metersPerPx;
      ctx.fillStyle = b.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = metersPerPx * 1.2;
      if (b.heading !== undefined) {
        ctx.save();
        ctx.translate(b.x, b.z);
        // Heading h points along (sin h, cos h) in world space.
        ctx.rotate(-b.heading);
        ctx.beginPath();
        ctx.moveTo(0, r * 1.6);
        ctx.lineTo(r, -r);
        ctx.lineTo(0, -r * 0.4);
        ctx.lineTo(-r, -r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(b.x, b.z, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Border (flashes red/blue when wanted).
    ctx.lineWidth = 4;
    ctx.strokeStyle = alert ?? 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(2, 2, s - 4, s - 4, 13);
    ctx.stroke();
    // North marker.
    // World north (0, -1) lands at screen direction (-sin yaw, cos yaw).
    const nx = s / 2 - Math.sin(yaw) * (s / 2 - 14);
    const ny = s / 2 + Math.cos(yaw) * (s / 2 - 14);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(nx, ny, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Oswald, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
  }
}
