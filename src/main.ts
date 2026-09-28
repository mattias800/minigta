import '@fontsource/anton/400.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/600.css';
import './style.css';
import { DEFAULT_ORIGIN, DEFAULT_SPAWN } from './config';
import { Game } from './game/Game';

/** Start location: Gothenburg by default, or anywhere via ?lat=..&lon=..&name=.. */
function startOptions() {
  const q = new URLSearchParams(window.location.search);
  const lat = parseFloat(q.get('lat') ?? '');
  const lon = parseFloat(q.get('lon') ?? '');
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) < 85 && Math.abs(lon) <= 180) {
    const p = { lat, lon };
    return { origin: p, spawn: p, placeName: q.get('name') ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  }
  return { origin: DEFAULT_ORIGIN, spawn: DEFAULT_SPAWN, placeName: 'Göteborg' };
}

const app = document.getElementById('app')!;
const game = new Game(app, startOptions());
// Handy for debugging from the console / automated smoke tests.
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
