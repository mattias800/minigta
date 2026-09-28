/**
 * Downloads raw OpenStreetMap data for the bake area from Overpass, in tiles, into .cache/osm/.
 * Already-downloaded tiles are skipped, so the script can simply be re-run after failures.
 * Tiles that keep failing (public Overpass servers are often overloaded) are split into quarters.
 *
 *   npm run osm:fetch
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAKE_BOUNDS } from '../src/config';
import type { BBox } from '../src/geo/projection';
import { fetchOverpass } from '../src/world/osm/overpass';

const TILE_LAT = 0.007;
const TILE_LON = 0.0145;
const MAX_SPLIT_DEPTH = 2;
const RAW_DIR = join(process.cwd(), '.cache', 'osm');

const tileFile = (b: BBox) => join(RAW_DIR, `tile_${[b.south, b.west, b.north, b.east].map((v) => v.toFixed(5)).join('_')}.json`);

function quarters(b: BBox): BBox[] {
  const mLat = (b.south + b.north) / 2;
  const mLon = (b.west + b.east) / 2;
  return [
    { south: b.south, west: b.west, north: mLat, east: mLon },
    { south: b.south, west: mLon, north: mLat, east: b.east },
    { south: mLat, west: b.west, north: b.north, east: mLon },
    { south: mLat, west: mLon, north: b.north, east: b.east },
  ];
}

/** True if the tile, or all of its sub-tiles (recursively), are on disk. */
function isDone(b: BBox, depth = 0): boolean {
  if (existsSync(tileFile(b))) return true;
  return depth < MAX_SPLIT_DEPTH && quarters(b).every((q) => isDone(q, depth + 1));
}

async function fetchTile(b: BBox, depth: number, label: string): Promise<void> {
  if (isDone(b, depth)) return;
  const started = Date.now();
  try {
    const data = await fetchOverpass(b, {
      attemptsPerEndpoint: depth === MAX_SPLIT_DEPTH ? 20 : 2,
      headers: { 'User-Agent': 'minigta-bake/0.1 (https://github.com/mattias800/minigta)' },
      onRetry: (ep, e) => console.warn(`  ${label} retry ${new URL(ep).host}: ${String(e).slice(0, 100)}`),
    });
    writeFileSync(tileFile(b), JSON.stringify(data));
    console.log(`${label}: ${data.elements.length} elements in ${Date.now() - started} ms`);
  } catch (e) {
    if (depth >= MAX_SPLIT_DEPTH) throw e;
    console.warn(`${label}: giving up, splitting into quarters`);
    let i = 0;
    for (const q of quarters(b)) await fetchTile(q, depth + 1, `${label}.${i++}`);
  }
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  const tiles: BBox[] = [];
  for (let lat = BAKE_BOUNDS.south; lat < BAKE_BOUNDS.north - 1e-9; lat += TILE_LAT) {
    for (let lon = BAKE_BOUNDS.west; lon < BAKE_BOUNDS.east - 1e-9; lon += TILE_LON) {
      tiles.push({ south: lat, west: lon, north: Math.min(lat + TILE_LAT, BAKE_BOUNDS.north), east: Math.min(lon + TILE_LON, BAKE_BOUNDS.east) });
    }
  }
  const todo = tiles.filter((t) => !isDone(t));
  console.log(`${tiles.length} tiles, ${todo.length} to download`);
  let n = 0;
  for (const t of todo) await fetchTile(t, 0, `[${++n}/${todo.length}]`);
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
