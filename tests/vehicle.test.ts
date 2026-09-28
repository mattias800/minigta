import { describe, expect, it } from 'vitest';
import { Vehicle } from '../src/entities/Vehicle';
import { VEHICLE_SPECS } from '../src/entities/VehicleModel';
import type { World } from '../src/world/World';

const flatWorld = {
  surfaceAt: () => 'ground',
  surfaceHeight: () => 0,
  groundHeight: () => 0,
  collision: { resolveCircle: () => null },
} as unknown as World;

function drive(steer: number): Vehicle {
  const v = new Vehicle(VEHICLE_SPECS.sedan, '#ffffff');
  v.driver = {} as Vehicle['driver'];
  v.heading = 0; // facing +z (south)
  v.controls.throttle = 1;
  v.controls.steer = steer;
  for (let i = 0; i < 120; i++) v.update(1 / 60, flatWorld);
  return v;
}

describe('Vehicle steering', () => {
  // Facing south (+z), the driver's right hand points west (-x).
  it('turns right with positive steer', () => {
    const v = drive(1);
    expect(v.heading).toBeLessThan(0);
    expect(v.pos.x).toBeLessThan(-0.5);
  });

  it('turns left with negative steer', () => {
    const v = drive(-1);
    expect(v.heading).toBeGreaterThan(0);
    expect(v.pos.x).toBeGreaterThan(0.5);
  });
});
