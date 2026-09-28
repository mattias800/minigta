import { describe, expect, it } from 'vitest';
import { centroid, cleanRing, clipRingToRect, joinRings, pointInPolygon, signedArea } from '../src/geo/polygon';

const square = [0, 0, 10, 0, 10, 10, 0, 10];

describe('polygon helpers', () => {
  it('computes signed area and centroid', () => {
    expect(Math.abs(signedArea(square))).toBe(100);
    expect(centroid(square)).toEqual({ x: 5, z: 5 });
  });

  it('tests points against polygons with holes', () => {
    const hole = [4, 4, 6, 4, 6, 6, 4, 6];
    expect(pointInPolygon(1, 1, square)).toBe(true);
    expect(pointInPolygon(5, 5, square, [hole])).toBe(false);
    expect(pointInPolygon(11, 5, square)).toBe(false);
  });

  it('clips rings to a rectangle', () => {
    const clipped = clipRingToRect(square, { minX: 5, minZ: -5, maxX: 20, maxZ: 5 });
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(25);
    expect(clipRingToRect(square, { minX: 20, minZ: 20, maxX: 30, maxZ: 30 })).toEqual([]);
  });

  it('joins multipolygon fragments into closed rings, reversing where needed', () => {
    const rings = joinRings([
      [0, 0, 10, 0],
      [10, 10, 10, 0], // reversed
      [10, 10, 0, 10, 0, 0],
    ]);
    expect(rings).toHaveLength(1);
    expect(Math.abs(signedArea(rings[0]))).toBe(100);
  });

  it('cleans duplicate and closing points', () => {
    expect(cleanRing([0, 0, 0, 0, 1, 0, 1, 1, 0, 0])).toEqual([0, 0, 1, 0, 1, 1]);
  });
});
