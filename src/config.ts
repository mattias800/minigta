import type { LatLon } from './geo/projection';

/** World origin: Gustaf Adolfs torg, Gothenburg. All world coordinates are meters relative to this point. */
export const DEFAULT_ORIGIN: LatLon = { lat: 57.7072, lon: 11.9668 };

/** Where the player spawns by default: Kungsportsavenyen, just below Götaplatsen. */
export const DEFAULT_SPAWN: LatLon = { lat: 57.6983, lon: 11.9782 };

/** Side length of a world chunk in meters. */
export const CHUNK_SIZE = 250;

/** Chunks within this Chebyshev radius of the player are loaded. */
export const CHUNK_LOAD_RADIUS = 2;
/** Chunks beyond this radius are unloaded (must be > load radius to avoid thrashing). */
export const CHUNK_UNLOAD_RADIUS = 3;

/** Bounding box (lat/lon) of the pre-baked area shipped with the game. */
export const BAKE_BOUNDS = { south: 57.677, west: 11.925, north: 57.726, east: 12.012 };

/** Bump when the chunk format changes; invalidates browser caches of live-fetched chunks. */
export const DATA_VERSION = 3;
