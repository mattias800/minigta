import { chance, pick } from '../core/math';
import { Character } from '../entities/Character';
import { copLook, randomCivilianLook } from '../entities/CharacterModel';
import { Vehicle } from '../entities/Vehicle';
import { randomPaint, VEHICLE_SPECS, type VehicleType } from '../entities/VehicleModel';
import { LaneFollower } from '../ai/LaneFollower';
import type { RoadEdge } from '../world/RoadNetwork';

const TRAFFIC_MIX: VehicleType[] = ['sedan', 'sedan', 'estate', 'estate', 'estate', 'hatch', 'hatch', 'suv', 'suv', 'van', 'taxi', 'sports'];

export function randomTrafficType(): VehicleType {
  return pick(TRAFFIC_MIX);
}

export function createVehicle(type: VehicleType, paint?: string): Vehicle {
  const color = paint ?? (type === 'police' ? '#f4f5f7' : type === 'taxi' ? '#1d1d1f' : randomPaint());
  return new Vehicle(VEHICLE_SPECS[type], color);
}

export function createCivilian(): Character {
  const c = new Character('civilian', randomCivilianLook());
  // A few armed civilians make things more interesting.
  if (chance(0.06)) c.inventory.give('pistol', 24);
  return c;
}

export function createCop(): Character {
  const c = new Character('cop', copLook());
  c.inventory.give('pistol', 200);
  c.inventory.select('pistol');
  c.maxHealth = c.health = 120;
  return c;
}

/** Position and heading in the right-hand lane of an edge at fraction t. */
export function lanePose(edge: RoadEdge, forward: boolean, t: number): { x: number; z: number; heading: number } {
  const dx = forward ? edge.dx : -edge.dx;
  const dz = forward ? edge.dz : -edge.dz;
  const from = forward ? edge.a : edge.b;
  const s = edge.length * t;
  const off = LaneFollower.laneOffset(edge);
  return { x: from.x + dx * s - dz * off, z: from.z + dz * s + dx * off, heading: Math.atan2(dx, dz) };
}

/** Pose of a car parked along the kerb (right side). */
export function parkedPose(edge: RoadEdge, forward: boolean, t: number): { x: number; z: number; heading: number } {
  const dx = forward ? edge.dx : -edge.dx;
  const dz = forward ? edge.dz : -edge.dz;
  const from = forward ? edge.a : edge.b;
  const s = edge.length * t;
  const off = edge.width / 2 - 1.1;
  return { x: from.x + dx * s - dz * off, z: from.z + dz * s + dx * off, heading: Math.atan2(dx, dz) };
}
