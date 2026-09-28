import { rand } from '../core/math';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import type { Brain } from '../game/Entities';
import type { GameContext } from '../game/GameContext';
import { SPEED_LIMIT, type RoadEdge } from '../world/RoadNetwork';
import { edgeAtHeight } from '../game/spawn';
import { CopDriverBrain } from './CopDriverBrain';
import { obstacleAhead, steerTowards } from './driving';
import { LaneFollower } from './LaneFollower';
import { PedBrain } from './PedBrain';

/** A civilian driving around the road network, obeying (roughly) lanes and speed limits. */
export class DriverBrain implements Brain {
  readonly kind = 'driver';
  private follower: LaneFollower | null;
  private readonly temperament = rand(0.85, 1.12);
  private panic = 0;
  private blockedTime = 0;
  private stuckTime = 0;
  private reverseTime = 0;
  private hornCooldown = 0;

  constructor(
    private readonly me: Character,
    edge: RoadEdge | null,
    forward = true,
  ) {
    this.follower = edge ? new LaneFollower(edge, forward) : null;
  }

  scare(seconds = 8) {
    this.panic = Math.max(this.panic, seconds);
  }

  update(dt: number, ctx: GameContext) {
    const v = this.me.vehicle;
    if (!v) return;
    this.hornCooldown -= dt;
    this.panic = Math.max(0, this.panic - dt);

    // Police in regular traffic join a pursuit when the player is wanted nearby.
    if (this.me.role === 'cop' && ctx.wanted() > 0 && v.pos.distanceTo(ctx.player.pos) < 140) {
      ctx.entities.setBrain(this.me, new CopDriverBrain(this.me));
      return;
    }
    v.sirenOn = false;

    // Bail out of burning or sinking cars.
    if (v.state !== 'ok' || v.health < v.spec.health * 0.12) {
      bailOut(ctx, this.me, v, true);
      return;
    }

    const net = ctx.world.roads;
    if (!this.follower || !this.follower.valid(net)) {
      const q = net.nearestEdge(v.pos.x, v.pos.z, 30, (e) => e.drivable && edgeAtHeight(ctx.world, e, v.pos.y));
      if (!q) {
        v.controls.throttle = 0;
        v.controls.handbrake = true;
        return;
      }
      const fwd = Math.sin(v.heading) * q.edge.dx + Math.cos(v.heading) * q.edge.dz >= 0;
      this.follower = new LaneFollower(q.edge, q.edge.oneway ? true : fwd);
    }
    const f = this.follower;

    const speed = v.forwardSpeed;
    const lookAhead = 5 + Math.abs(speed) * 0.55;
    const t = f.target(v, lookAhead, 12 + Math.abs(speed) * 1.2);
    let desired = SPEED_LIMIT[f.edge.kind] * this.temperament * (this.panic > 0 ? 1.5 : 1);
    // Slow down for sharp turns ahead.
    if (t.turn > 0.5) desired = Math.min(desired, cornerSpeed(t.turn, t.turnDistance));
    const obs = obstacleAhead(ctx, v, 8 + Math.abs(speed) * 1.4);
    desired = Math.min(desired, obs.maxSpeed);

    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.controls.throttle = -0.6;
      v.controls.steer = -v.controls.steer;
      return;
    }
    steerTowards(v, t.x, t.z, desired);
    if (desired < 0.5) {
      v.controls.throttle = speed > 0.3 ? -1 : 0;
      v.controls.handbrake = speed <= 0.3;
    }

    if (obs.maxSpeed < 0.5 && obs.blockerIsPlayer) {
      this.blockedTime += dt;
      if (this.blockedTime > 2 && this.hornCooldown <= 0) {
        ctx.audio.horn(v.pos, rand(0.3, 0.9));
        this.hornCooldown = rand(2, 5);
      }
    } else {
      this.blockedTime = 0;
    }

    // Stuck against something that isn't a car/person: back up.
    if (v.controls.throttle > 0.2 && Math.abs(speed) < 0.4 && obs.maxSpeed > 2) {
      this.stuckTime += dt;
      if (this.stuckTime > 2.5) {
        this.reverseTime = 1.4;
        this.stuckTime = 0;
      }
    } else {
      this.stuckTime = 0;
    }
  }
}

/** Speed allowed when a turn of `turn` radians is `distance` meters ahead. */
export function cornerSpeed(turn: number, distance: number): number {
  const atCorner = 4 + (1 - Math.min(turn, Math.PI) / Math.PI) * 9;
  return atCorner + Math.max(0, distance - 3) * 0.45;
}

/** Makes an NPC leave a vehicle and switches them to a pedestrian brain. */
export function bailOut(ctx: GameContext, c: Character, v: Vehicle, flee: boolean) {
  const door = v.doorPosition(1);
  v.driver = null;
  v.controls.throttle = 0;
  v.controls.steer = 0;
  c.vehicle = null;
  c.pos.set(door.x, v.pos.y, door.z);
  c.vel.set(v.vx * 0.5, 0, v.vz * 0.5);
  c.heading = v.heading + Math.PI / 2;
  const brain = new PedBrain(c);
  if (flee) brain.flee(v.pos.x, v.pos.z, rand(8, 14));
  ctx.entities.setBrain(c, brain);
}
