/** Raw Overpass API JSON (`out geom`) types. */

export interface OsmPoint {
  lat: number;
  lon: number;
}

export type OsmTags = Record<string, string>;

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: OsmTags;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: OsmPoint[];
  tags?: OsmTags;
}

export interface OsmRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: (OsmPoint | null)[];
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmRelationMember[];
  tags?: OsmTags;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  version?: number;
  remark?: string;
  elements: OsmElement[];
}
