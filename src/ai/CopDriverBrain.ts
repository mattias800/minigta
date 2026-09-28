import { copLook } from '../entities/CharacterModel';
import { Character } from '../entities/Character';
import type { Brain } from '../game/Entities';
import type { GameContext } from '../game/GameContext';
import { SPEED_LIMIT } from '../world/RoadNetwork';
import { edgeAtHeight } from '../game/spawn';
import { CopBrain } from './CopBrain';
import { DriverBrain } from './DriverBrain';
import { obstacleAhead, steerTowards } from './driving';
import { LaneFollower } from './LaneFollower';

/**
 * Police driver in pursuit: follows the road network (A*) towards the player and switches to
 * direct pursuit / ramming when close with line of sight. Gets out to chase players on foot.
 */
export class CopDriverBrain implements Brain {
  readonly kind = 'copDriver';
  private follower: LaneFollower | null = null;
  private repath = 0;
  private stuckTime = 0;
  private reverseTime = 0;
  private losTimer = 0;
  private hasLos = false;

  constructor(private readonly me: Character) {}

  update(dt: number, ctx: GameContext) {
    const me = this.me;
    const v = me.vehicle;
    if (!v) return;
    const stars = ctx.wanted();
    v.sirenOn = stars > 0;
    if (stars === 0) {
      ctx.entities.setBrain(me, new DriverBrain(me, null));
      return;
    }
    if (!v.alive || v.state !== 'ok') {
      this.exit(ctx, false);
      return;
    }
    const player = ctx.player;
    const pv = player.vehicle;
    const target = pv ? pv.pos : player.pos;
    const dx = target.x - v.pos.x;
    const dz = target.z - v.pos.z;
    const dist = Math.hypot(dx, dz);

    // Out of the car when the player is on foot nearby, or stopped in a car.
    if ((!pv && dist < 18 && v.speed < 7) || (pv && pv.speed < 1.5 && dist < 9 && v.speed < 3)) {
      this.exit(ctx, stars >= 2);
      return;
    }

    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.3;
      this.hasLos = dist < 70 && ctx.world.collision.lineOfSight(v.pos.x, v.pos.y + 1.2, v.pos.z, target.x, target.y + 1.2, target.z);
    }

    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.controls.throttle = -0.8;
      v.controls.steer = -Math.sign(v.controls.steer || 1);
      v.controls.handbrake = false;
      return;
    }

    const net = ctx.world.roads;
    let tx: number;
    let tz: number;
    let desired: number;
    if (this.hasLos && dist < 55) {
      // Direct pursuit with a little lead.
      const lead = Math.min(1.2, dist / 25);
      const tvx = pv ? pv.vx : player.vel.x;
      const tvz = pv ? pv.vz : player.vel.z;
      tx = target.x + tvx * lead;
      tz = target.z + tvz * lead;
      const targetSpeed = Math.hypot(tvx, tvz);
      desired = Math.min(v.spec.maxSpeed, dist * 0.9 + targetSpeed + 2);
    } else {
      this.repath -= dt;
      if (!this.follower || !this.follower.valid(net) || this.repath <= 0) {
        this.repath = 1.5;
        const q = net.nearestEdge(v.pos.x, v.pos.z, 30, (e) => e.drivable && edgeAtHeight(ctx.world, e, v.pos.y));
        const goal = net.nearestNode(target.x, target.z, 60, (e) => e.drivable);
        if (q && goal) {
          const fwd = Math.sin(v.heading) * q.edge.dx + Math.cos(v.heading) * q.edge.dz >= 0;
          this.follower = new LaneFollower(q.edge, fwd);
          this.follower.respectOneway = false;
          const start = fwd ? q.edge.b : q.edge.a;
          this.follower.setPath(net.findPath(start, goal, { respectOneway: false, drivableOnly: true }, 3000));
        }
      }
      if (this.follower) {
        const t = this.follower.target(v, 6 + Math.abs(v.forwardSpeed) * 0.5, 15 + v.speed);
        tx = t.x;
        tz = t.z;
        desired = Math.min(30, SPEED_LIMIT[this.follower.edge.kind] * 1.8);
        if (t.turn > 0.6) desired = Math.min(desired, 6 + (1 - t.turn / Math.PI) * 10 + t.turnDistance * 0.6);
      } else {
        tx = target.x;
        tz = target.z;
        desired = 12;
      }
    }
    const obs = obstacleAhead(ctx, v, 6 + v.speed * 0.8, 1.2);
    if (!obs.blockerIsPlayer) desired = Math.min(desired, Math.max(obs.maxSpeed, 3));
    steerTowards(v, tx, tz, desired);

    if (v.controls.throttle > 0.2 && Math.abs(v.forwardSpeed) < 0.6) {
      this.stuckTime += dt;
      if (this.stuckTime > 1.5) {
        this.reverseTime = 1.2;
        this.stuckTime = 0;
      }
    } else {
      this.stuckTime = 0;
    }
  }

  private exit(ctx: GameContext, withPartner: boolean) {
    const me = this.me;
    const v = me.vehicle!;
    const door = v.doorPosition(1);
    v.driver = null;
    v.controls.throttle = 0;
    v.controls.handbrake = true;
    v.sirenOn = v.alive;
    me.vehicle = null;
    me.pos.set(door.x, v.pos.y, door.z);
    me.inventory.select('pistol');
    ctx.entities.setBrain(me, new CopBrain(me, v.alive ? v : null));
    if (withPartner && v.alive) {
      const p = v.doorPosition(-1);
      const partner = new Character('cop', copLook());
      partner.pos.set(p.x, v.pos.y, p.z);
      partner.heading = v.heading;
      partner.inventory.give('pistol', 200);
      partner.inventory.select('pistol');
      ctx.entities.addCharacter(partner, new CopBrain(partner, v));
    }
  }
}
