/**
 * Processed, game-ready map data for one square chunk of the world.
 * Coordinates are world meters (see Projection), stored as flat [x0, z0, x1, z1, ...] arrays.
 */

export type RoadKind =
  | 'motorway'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'pedestrian'
  | 'footway'
  | 'cycleway'
  | 'steps';

export type AreaKind =
  | 'water'
  | 'park'
  | 'grass'
  | 'forest'
  | 'sand'
  | 'plaza'
  | 'parking'
  | 'pier'
  | 'pitch'
  | 'industrial'
  | 'residential'
  | 'commercial'
  | 'railway';

export interface RoadData {
  /** OSM way id (several chunk pieces can share it). */
  id: number;
  kind: RoadKind;
  pts: number[];
  /** OSM node ids, parallel to pts; shared ids connect the road graph across ways and chunks. */
  nodes: number[];
  width: number;
  lanes: number;
  oneway: boolean;
  bridge?: boolean;
  name?: string;
}

export interface BuildingData {
  id: number;
  outer: number[];
  holes?: number[][];
  height: number;
  minHeight: number;
  kind: string;
  color?: string;
  roofColor?: string;
  name?: string;
  /** Roof-only structures (canopies, platform roofs) do not block movement. */
  roofOnly?: boolean;
}

export interface AreaData {
  kind: AreaKind;
  outer: number[];
  holes?: number[][];
}

export interface RailData {
  id: number;
  kind: 'tram' | 'rail';
  pts: number[];
  /** OSM node ids, parallel to pts (connects the tram network across ways and chunks). */
  nodes: number[];
}

export interface PlaceData {
  name: string;
  kind: string;
  x: number;
  z: number;
}

export interface ChunkData {
  v: number;
  cx: number;
  cz: number;
  buildings: BuildingData[];
  roads: RoadData[];
  areas: AreaData[];
  rails: RailData[];
  /** Flat [x, z, ...] positions of mapped trees. */
  trees: number[];
  places: PlaceData[];
}

export const chunkKey = (cx: number, cz: number) => `${cx}_${cz}`;
