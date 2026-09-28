import type * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { EventBus } from '../core/EventBus';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import type { Effects } from '../render/Effects';
import type { World } from '../world/World';
import type { Combat } from './Combat';
import type { Entities } from './Entities';
import type { WeaponId } from './weapons';

export interface GameEvents {
  gunshot: { shooter: Character; x: number; z: number; weapon: WeaponId; noise: number };
  injure: { victim: Character; attacker: Character | null };
  death: { victim: Character; killer: Character | null; cause: 'bullet' | 'melee' | 'vehicle' | 'explosion' | 'other' };
  vehicleDestroyed: { vehicle: Vehicle; by: Character | null };
  carjack: { vehicle: Vehicle; thief: Character; victim: Character };
  explosion: { x: number; z: number; by: Character | null };
  pickup: { kind: string; label: string };
}

/** Shared services passed to game systems and AI (instead of globals). */
export interface GameContext {
  scene: THREE.Scene;
  world: World;
  entities: Entities;
  effects: Effects;
  audio: AudioEngine;
  events: EventBus<GameEvents>;
  combat: Combat;
  player: Character;
  /** Current wanted level 0..5 (read-only for AI; owned by Police). */
  wanted: () => number;
  time: number;
}
