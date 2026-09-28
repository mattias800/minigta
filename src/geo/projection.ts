export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const METERS_PER_DEG_LAT = 111_320;

/**
 * Local equirectangular projection around a fixed origin.
 * World axes (three.js convention): +x = east, +z = south, +y = up.
 * Accurate to well under a percent within tens of kilometres of the origin, which is plenty for a game.
 */
export class Projection {
  readonly origin: LatLon;
  private readonly metersPerDegLon: number;

  constructor(origin: LatLon) {
    this.origin = origin;
    this.metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  }

  toWorld(lat: number, lon: number): { x: number; z: number } {
    return {
      x: (lon - this.origin.lon) * this.metersPerDegLon,
      z: -(lat - this.origin.lat) * METERS_PER_DEG_LAT,
    };
  }

  toLatLon(x: number, z: number): LatLon {
    return {
      lat: this.origin.lat - z / METERS_PER_DEG_LAT,
      lon: this.origin.lon + x / this.metersPerDegLon,
    };
  }

  /** Lat/lon bounding box of a world-space rectangle. */
  bboxOf(minX: number, minZ: number, maxX: number, maxZ: number): BBox {
    const sw = this.toLatLon(minX, maxZ);
    const ne = this.toLatLon(maxX, minZ);
    return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
  }
}
