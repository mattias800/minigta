import { describe, expect, it } from 'vitest';
import { clipPolylineToRect } from '../src/geo/polygon';
import { nodeLines, vertexId } from '../src/world/mvt/convert';

describe('clipPolylineToRect', () => {
  const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };

  it('clips a crossing line to the rectangle', () => {
    expect(clipPolylineToRect([-5, 5, 15, 5], rect)).toEqual([[0, 5, 10, 5]]);
  });

  it('splits a line that leaves and re-enters', () => {
    const pieces = clipPolylineToRect([2, 2, 2, 20, 8, 20, 8, 2], rect);
    expect(pieces).toEqual([
      [2, 2, 2, 10],
      [8, 10, 8, 2],
    ]);
  });
});

describe('nodeLines', () => {
  const road = { highway: 'residential' };

  it('inserts a shared vertex where two roads cross', () => {
    const [a, b] = nodeLines([
      { pts: [0, 5, 10, 5], tags: road },
      { pts: [5, 0, 5, 10], tags: road },
    ]);
    expect(a.pts).toEqual([0, 5, 5, 5, 10, 5]);
    expect(b.pts).toEqual([5, 0, 5, 5, 5, 10]);
  });

  it('snaps a road ending just short of another onto it (T-junction)', () => {
    const [main, side] = nodeLines([
      { pts: [0, 0, 20, 0], tags: road },
      { pts: [8, 10, 8, 1.5], tags: road },
    ]);
    expect(main.pts).toEqual([0, 0, 8, 0, 20, 0]);
    expect(side.pts.slice(-2)).toEqual([8, 0]);
    expect(vertexId(main.pts[2], main.pts[3])).toBe(vertexId(side.pts[2], side.pts[3]));
  });

  it('does not connect a bridge to the road below it', () => {
    const [a, b] = nodeLines([
      { pts: [0, 5, 10, 5], tags: road },
      { pts: [5, 0, 5, 10], tags: { ...road, bridge: 'yes', layer: '1' } },
    ]);
    expect(a.pts).toHaveLength(4);
    expect(b.pts).toHaveLength(4);
  });
});
