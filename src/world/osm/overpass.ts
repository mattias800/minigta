import type { BBox } from '../../geo/projection';
import type { OverpassResponse } from './types';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Builds the Overpass QL query for everything the game renders or simulates. */
export function buildQuery(b: BBox, timeoutSec = 90): string {
  const bb = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',');
  const mp = (filter: string) => `relation["type"="multipolygon"]${filter}(${bb});`;
  return `[out:json][timeout:${timeoutSec}];
(
  way["building"](${bb});
  way["highway"](${bb});
  way["railway"~"^(tram|rail|light_rail|subway)$"](${bb});
  way["natural"~"^(water|wood|scrub|beach|sand|grassland|heath|bare_rock|wetland|coastline)$"](${bb});
  way["waterway"~"^(riverbank|dock|canal)$"](${bb});
  way["landuse"](${bb});
  way["leisure"~"^(park|garden|pitch|playground|common|nature_reserve|marina)$"](${bb});
  way["amenity"="parking"](${bb});
  way["place"="square"](${bb});
  way["man_made"~"^(pier|bridge)$"](${bb});
  ${mp('["building"]')}
  ${mp('["natural"]')}
  ${mp('["landuse"]')}
  ${mp('["leisure"]')}
  ${mp('["waterway"]')}
  ${mp('["place"="square"]')}
  ${mp('["man_made"]')}
  ${mp('["highway"="pedestrian"]')}
  node["natural"="tree"](${bb});
  node["place"~"^(suburb|neighbourhood|quarter)$"](${bb});
);
out geom;`;
}

export interface FetchOptions {
  endpoints?: string[];
  attemptsPerEndpoint?: number;
  /** Extra headers (browsers forbid setting User-Agent, Node needs one). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onRetry?: (endpoint: string, error: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches OSM data for a bbox, cycling through public Overpass mirrors with backoff. */
export async function fetchOverpass(bbox: BBox, opts: FetchOptions = {}): Promise<OverpassResponse> {
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS;
  const attempts = opts.attemptsPerEndpoint ?? 2;
  const body = new URLSearchParams({ data: buildQuery(bbox) }).toString();
  let lastError: unknown;
  for (let round = 0; round < attempts; round++) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...opts.headers },
          signal: opts.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (!text.trimStart().startsWith('{')) throw new Error(`Non-JSON response: ${stripHtml(text).slice(0, 200)}`);
        const json = JSON.parse(text) as OverpassResponse;
        if (json.remark && /runtime error/i.test(json.remark)) throw new Error(json.remark);
        return json;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        lastError = e;
        opts.onRetry?.(endpoint, e);
        await sleep(1500 * (round + 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
