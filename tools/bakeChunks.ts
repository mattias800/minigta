/**
 * Converts the raw OSM tiles in .cache/osm/ (see fetchOsm.ts) into game chunks in public/data/.
 * Only chunks that lie completely inside the downloaded area are written; everything else is
 * streamed live from Overpass by the game.
 *
 *   npm run osm:bake
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAKE_BOUNDS, CHUNK_SIZE, DATA_VERSION, DEFAULT_ORIGIN } from '../src/config';
import { Projection } from '../src/geo/projection';
import { chunkKey } from '../src/world/chunkTypes';
import { OsmChunker } from '../src/world/osm/process';
import type { OsmElement, OverpassResponse } from '../src/world/osm/types';

const RAW_DIR = join(process.cwd(), '.cache', 'osm');
const OUT_DIR = join(process.cwd(), 'public', 'data');

function main() {
  const proj = new Projection(DEFAULT_ORIGIN);
  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'));
  const elements: OsmElement[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')) as OverpassResponse;
    for (const el of data.elements) elements.push(el);
  }
  console.log(`${files.length} raw tiles, ${elements.length} elements (with duplicates)`);

  const sw = proj.toWorld(BAKE_BOUNDS.south, BAKE_BOUNDS.west);
  const ne = proj.toWorld(BAKE_BOUNDS.north, BAKE_BOUNDS.east);
  const minCx = Math.ceil(sw.x / CHUNK_SIZE);
  const maxCx = Math.floor(ne.x / CHUNK_SIZE) - 1;
  const minCz = Math.ceil(ne.z / CHUNK_SIZE);
  const maxCz = Math.floor(sw.z / CHUNK_SIZE) - 1;
  const wanted = new Set<string>();
  for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) wanted.add(chunkKey(cx, cz));

  const chunker = new OsmChunker(proj, elements);
  const chunks = chunker.buildAll(wanted);

  rmSync(join(OUT_DIR, 'chunks'), { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, 'chunks'), { recursive: true });
  let bytes = 0;
  const keys: string[] = [];
  for (const key of wanted) {
    const c = chunks.get(key) ?? { v: DATA_VERSION, cx: +key.split('_')[0], cz: +key.split('_')[1], buildings: [], roads: [], areas: [], rails: [], trees: [], places: [] };
    const json = JSON.stringify(c);
    bytes += json.length;
    writeFileSync(join(OUT_DIR, 'chunks', `${key}.json`), json);
    keys.push(key);
  }
  const manifest = {
    v: DATA_VERSION,
    origin: DEFAULT_ORIGIN,
    chunkSize: CHUNK_SIZE,
    bounds: { minCx, maxCx, minCz, maxCz },
    generated: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors, ODbL',
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${keys.length} chunks (${(bytes / 1e6).toFixed(1)} MB) x ${minCx}..${maxCx}, z ${minCz}..${maxCz}`);
}

main();
