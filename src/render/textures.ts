import * as THREE from 'three';
import { seededRandom } from '../core/math';

/** Procedurally drawn canvas textures, so the game ships without image assets. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number, size = 1) {
  const rnd = seededRandom(seed);
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      const v = (rnd() - 0.5) * amount;
      ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
      ctx.fillRect(x, y, size, size);
    }
  }
}

function toTexture(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Road surface; u spans the road width, v runs along it (one texture = 12 m). */
export function roadTexture(markings: 'twoWay' | 'oneWay' | 'none'): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 256);
  ctx.fillStyle = '#4a4b4f';
  ctx.fillRect(0, 0, 128, 256);
  noise(ctx, 128, 256, 0.12, 11, 2);
  // Subtle tyre tracks.
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  for (const x of [22, 44, 84, 106]) ctx.fillRect(x - 5, 0, 10, 256);
  if (markings !== 'none') {
    ctx.fillStyle = 'rgba(235,235,225,0.85)';
    ctx.fillRect(4, 0, 3, 256);
    ctx.fillRect(121, 0, 3, 256);
    if (markings === 'twoWay') {
      for (let y = 0; y < 256; y += 64) ctx.fillRect(62, y, 4, 36);
    }
  }
  return toTexture(c);
}

export function sidewalkTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#a3a19b';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.08, 5, 2);
  ctx.strokeStyle = 'rgba(60,60,60,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 128; i += 32) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(64, 0);
  ctx.lineTo(64, 128);
  ctx.stroke();
  // Curb stones along both edges.
  ctx.fillStyle = '#c9c7c0';
  ctx.fillRect(0, 0, 6, 128);
  ctx.fillRect(122, 0, 6, 128);
  return toTexture(c);
}

export function pavingTexture(base: string, seed: number, tile = 16): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  const rnd = seededRandom(seed);
  for (let y = 0; y < 128; y += tile) {
    for (let x = 0; x < 128; x += tile) {
      const v = (rnd() - 0.5) * 0.18;
      ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
      ctx.fillRect(x + 1, y + 1, tile - 2, tile - 2);
    }
  }
  noise(ctx, 128, 128, 0.06, seed + 1, 2);
  return toTexture(c);
}

export function groundTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 256, 0.18, 3, 4);
  noise(ctx, 256, 256, 0.08, 4, 1);
  return toTexture(c);
}

/**
 * One facade bay (3.5 m wide x 3.1 m tall): white wall with a window; tinted by vertex colors.
 * Row 0 of the texture is the bottom of the floor.
 */
export function facadeTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.07, 9, 2);
  // Window frame + glass.
  const wx = 30;
  const wy = 26;
  const ww = 68;
  const wh = 70;
  ctx.fillStyle = '#e9e6de';
  ctx.fillRect(wx - 5, wy - 5, ww + 10, wh + 10);
  const g = ctx.createLinearGradient(0, wy, 0, wy + wh);
  g.addColorStop(0, '#2d3c4f');
  g.addColorStop(1, '#5d7189');
  ctx.fillStyle = g;
  ctx.fillRect(wx, wy, ww, wh);
  ctx.fillStyle = '#e9e6de';
  ctx.fillRect(wx + ww / 2 - 2, wy, 4, wh);
  ctx.fillRect(wx, wy + 22, ww, 3);
  // Sill + a floor band.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(wx - 6, wy + wh + 5, ww + 12, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 124, 128, 4);
  const t = toTexture(c);
  t.flipY = true;
  return t;
}

export function roofTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.16, 21, 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  for (let i = 0; i < 128; i += 16) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  return toTexture(c);
}

/** Small radial "glow" sprite used for particles, lights and muzzle flashes. */
export function glowTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(c, false);
}

export function smokeTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 64);
  const rnd = seededRandom(77);
  for (let i = 0; i < 18; i++) {
    const x = 20 + rnd() * 24;
    const y = 20 + rnd() * 24;
    const r = 8 + rnd() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return toTexture(c, false);
}
