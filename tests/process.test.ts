import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../src/config';
import { Projection } from '../src/geo/projection';
import { OsmChunker, parseLength } from '../src/world/osm/process';
import type { OsmElement } from '../src/world/osm/types';
import { RoadNetwork } from '../src/world/RoadNetwork';

const origin = { lat: 57.7, lon: 11.97 };
const proj = new Projection(origin);
/** Lat/lon for a world position in meters. */
const ll = (x: number, z: number) => proj.toLatLon(x, z);

function way(id: number, nodes: number[], pts: [number, number][], tags: Record<string, string>): OsmElement {
  return { type: 'way', id, nodes, geometry: pts.map(([x, z]) => ll(x, z)), tags };
}

describe('projection', () => {
  it('round-trips lat/lon', () => {
    const w = proj.toWorld(57.71, 11.99);
    const back = proj.toLatLon(w.x, w.z);
    expect(back.lat).toBeCloseTo(57.71, 9);
    expect(back.lon).toBeCloseTo(11.99, 9);
    expect(w.z).toBeLessThan(0); // north is -z
  });
});

describe('OsmChunker', () => {
  it('assigns buildings to the chunk containing their centroid', () => {
    const b = way(1, [1, 2, 3, 4, 1], [[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]], { building: 'yes', 'building:levels': '5' });
    const chunks = new OsmChunker(proj, [b]).buildAll();
    const c = chunks.get('0_0')!;
    expect(c.buildings).toHaveLength(1);
    expect(c.buildings[0].height).toBeGreaterThan(15);
  });

  it('splits roads across chunks while keeping shared node ids', () => {
    const road = way(2, [10, 11, 12], [[100, 5], [CHUNK_SIZE + 100, 5], [CHUNK_SIZE + 150, 5]], { highway: 'residential', name: 'Testgatan' });
    const chunks = new OsmChunker(proj, [road]).buildAll();
    const a = chunks.get('0_0')!.roads[0];
    const b = chunks.get('1_0')!.roads[0];
    expect(a.nodes).toEqual([10, 11]);
    expect(b.nodes).toEqual([11, 12]);

    // Loading both pieces yields one connected graph.
    const net = new RoadNetwork();
    net.addRoads('0_0', [a]);
    net.addRoads('1_0', [b]);
    const path = net.findPath(net.nodes.get(10)!, net.nodes.get(12)!, { respectOneway: true, drivableOnly: true });
    expect(path?.map((n) => n.id)).toEqual([10, 11, 12]);

    net.removeOwner('1_0');
    expect(net.nodes.has(12)).toBe(false);
    expect(net.nodes.has(11)).toBe(true);
  });

  it('clips water areas to each chunk they overlap', () => {
    const lake = way(3, [1, 2, 3, 4, 1], [[-50, 10], [50, 10], [50, 60], [-50, 60], [-50, 10]], { natural: 'water' });
    const chunks = new OsmChunker(proj, [lake]).buildAll();
    expect(chunks.get('0_0')!.areas[0].kind).toBe('water');
    expect(chunks.get('-1_0')!.areas[0].kind).toBe('water');
  });

  it('skips tunnels and reverses oneway=-1', () => {
    const tunnel = way(4, [1, 2], [[0, 0], [10, 0]], { highway: 'primary', tunnel: 'yes' });
    const rev = way(5, [7, 8], [[0, 20], [10, 20]], { highway: 'tertiary', oneway: '-1' });
    const roads = new OsmChunker(proj, [tunnel, rev]).buildAll().get('0_0')!.roads;
    expect(roads).toHaveLength(1);
    expect(roads[0].oneway).toBe(true);
    expect(roads[0].nodes).toEqual([8, 7]);
  });

  it('parses OSM lengths', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12.5 m')).toBe(12.5);
    expect(parseLength('10 ft')).toBeCloseTo(3.048);
    expect(parseLength('tall')).toBeNaN();
  });
});
