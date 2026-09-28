import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { AudioEngine } from '../audio/AudioEngine';
import { Radio } from '../audio/Radio';
import { DEFAULT_ORIGIN, DEFAULT_SPAWN } from '../config';
import { EventBus } from '../core/EventBus';
import { Input } from '../core/Input';
import { rand } from '../core/math';
import { Character } from '../entities/Character';
import { playerLook } from '../entities/CharacterModel';
import type { Vehicle } from '../entities/Vehicle';
import { Projection, type LatLon } from '../geo/projection';
import { Effects } from '../render/Effects';
import { Hud } from '../ui/Hud';
import type { Blip } from '../ui/Minimap';
import { Screens } from '../ui/Screens';
import { World } from '../world/World';
import { CameraRig } from './CameraRig';
import { Combat } from './Combat';
import { Entities } from './Entities';
import type { GameContext, GameEvents } from './GameContext';
import { processVehicleImpacts, resolveInteractions } from './Interactions';
import { Pickups } from './Pickups';
import { PlayerController } from './PlayerController';
import { Police } from './Police';
import { Population } from './Population';
import { Trams } from './Trams';
import { createVehicle, parkedPose } from './spawn';
import { WEAPONS } from './weapons';

type State = 'title' | 'loading' | 'playing' | 'paused' | 'wasted' | 'busted';

/** Real places used for respawning (default origin only). */
const HOSPITAL: LatLon = { lat: 57.6836, lon: 11.9614 }; // Sahlgrenska
const POLICE_STATION: LatLon = { lat: 57.7014, lon: 11.9958 }; // Polishuset, Ernst Fontells plats

export interface GameOptions {
  origin: LatLon;
  spawn: LatLon;
  placeName: string;
}

/** Owns the renderer, the simulation systems and the game-state flow (title → play → wasted …). */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, 1, 0.3, 900);
  private readonly sun = new THREE.DirectionalLight('#fff1dc', 1.7);
  private readonly input: Input;
  private readonly projection: Projection;
  private readonly world: World;
  private readonly entities: Entities;
  private readonly effects = new Effects();
  private readonly events = new EventBus<GameEvents>();
  private readonly pickups = new Pickups();
  private readonly hud: Hud;
  private readonly screens: Screens;
  private readonly rig: CameraRig;
  private audio: AudioEngine | null = null;
  private radio: Radio | null = null;
  private ctx!: GameContext;
  private combat!: Combat;
  private police!: Police;
  private population!: Population;
  private trams!: Trams;
  private controller!: PlayerController;
  private player!: Character;
  private state: State = 'title';
  private stateTime = 0;
  private money = 100;
  private time = 0;
  private lastFrame = performance.now();
  private spawnPoint = new THREE.Vector3();
  private lastVehicle: Vehicle | null = null;
  private mapOpen = false;
  /** Smoothed frames per second (for debugging). */
  fps = 60;

  constructor(
    container: HTMLElement,
    private readonly options: GameOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.domElement.id = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.input = new Input(this.renderer.domElement);
    this.projection = new Projection(options.origin);
    this.world = new World(this.projection);
    this.entities = new Entities(this.scene);
    this.rig = new CameraRig(this.camera);
    this.hud = new Hud(container);
    this.screens = new Screens(container, {
      onPlay: () => this.start(),
      onResume: () => this.resume(),
      onTeleport: (lat, lon, name) => {
        const url = new URL(window.location.href);
        url.search = '';
        if (lat !== DEFAULT_ORIGIN.lat || lon !== DEFAULT_ORIGIN.lon) {
          url.searchParams.set('lat', lat.toFixed(5));
          url.searchParams.set('lon', lon.toFixed(5));
          url.searchParams.set('name', name);
        }
        window.location.href = url.toString();
      },
    });

    this.setupScene();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    document.addEventListener('pointerlockchange', () => {
      if (!this.input.pointerLocked && this.state === 'playing') this.pause();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP' && this.state === 'playing') document.exitPointerLock();
    });

    void this.world.init();
    requestAnimationFrame(() => this.frame());
  }

  private setupScene() {
    const scene = this.scene;
    scene.add(this.world.group, this.effects.group, this.pickups.group);
    this.effects.ground = (x, z) => this.world.groundHeight(x, z);
    this.pickups.ground = (x, z) => this.world.groundHeight(x, z);

    // The sky is drawn first, without depth, so its size can stay inside the camera's far plane.
    const sky = new Sky();
    sky.scale.setScalar(500);
    sky.material.depthWrite = false;
    sky.material.depthTest = false;
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    const u = sky.material.uniforms;
    u.turbidity.value = 5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    const elevation = THREE.MathUtils.degToRad(38);
    const azimuth = THREE.MathUtils.degToRad(215);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);
    u.sunPosition.value.copy(sunDir);
    scene.add(sky);
    this.sky = sky;

    // Image-based lighting from the sky for glossy car paint.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const skyScene = new THREE.Scene();
    const skyClone = new Sky();
    skyClone.scale.setScalar(4000);
    skyClone.material.uniforms.sunPosition.value.copy(sunDir);
    skyScene.add(skyClone);
    scene.environment = pmrem.fromScene(skyScene).texture;
    scene.environmentIntensity = 0.5;

    scene.fog = new THREE.Fog('#bccbd8', 170, 520);
    scene.add(new THREE.HemisphereLight('#c9dcf5', '#6b6150', 0.75));
    this.sun.position.copy(sunDir).multiplyScalar(120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);
    this.sunOffset.copy(sunDir).multiplyScalar(160);
  }

  private readonly sunOffset = new THREE.Vector3();
  private sky: Sky | null = null;

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects.setViewportHeight(h * this.renderer.getPixelRatio());
  }

  // --- State flow ---------------------------------------------------------------------------

  private start() {
    this.audio = new AudioEngine();
    this.audio.resume();
    this.radio = new Radio(this.audio);
    this.createSystems();
    this.state = 'loading';
    this.stateTime = 0;
    this.input.requestPointerLock();
    this.screens.showLoading(this.options.placeName);
  }

  private createSystems() {
    const player = new Character('player', playerLook());
    player.inventory.give('pistol', 72);
    player.inventory.select('pistol');
    this.player = player;
    const ctx: GameContext = {
      scene: this.scene,
      world: this.world,
      entities: this.entities,
      effects: this.effects,
      audio: this.audio!,
      events: this.events,
      combat: null!,
      player,
      wanted: () => this.police.stars,
      time: 0,
    };
    this.combat = new Combat(ctx);
    ctx.combat = this.combat;
    this.ctx = ctx;
    this.police = new Police(ctx);
    this.population = new Population(ctx, this.camera);
    this.trams = new Trams(ctx);
    this.controller = new PlayerController(ctx, this.input, this.rig);
    this.controller.onRadioNext = () => {
      if (this.radio) this.hud.showRadio(this.radio.next());
    };

    const spawn = this.projection.toWorld(this.options.spawn.lat, this.options.spawn.lon);
    this.spawnPoint.set(spawn.x, 0, spawn.z);
    player.pos.copy(this.spawnPoint);

    this.police.onBusted = () => this.busted();
    this.police.onStarsChanged = (s, prev) => {
      this.audio?.stinger(s > prev);
    };
    this.events.on('death', (e) => {
      if (e.victim === this.player) {
        this.wasted();
        return;
      }
      // Loot.
      const v = e.victim;
      if (v.role === 'cop') this.pickups.add('weapon', v.pos.x + 0.4, v.pos.z, 12, 'pistol');
      if (Math.random() < 0.8) this.pickups.add('cash', v.pos.x, v.pos.z + 0.3, Math.round(rand(10, v.role === 'cop' ? 120 : 70)));
      if (v.inventory.has('pistol') && v.role !== 'cop') this.pickups.add('weapon', v.pos.x - 0.4, v.pos.z, 12, 'pistol');
    });
    this.events.on('injure', (e) => {
      if (e.victim === this.player) this.lastPlayerDamage = this.time;
    });
    this.events.on('vehicleDestroyed', (e) => {
      if (e.by === this.player) this.money += 50;
    });
  }

  /** Once the area around the spawn has loaded: place the player on a sidewalk and a car nearby. */
  private enterWorld() {
    const net = this.world.roads;
    const p = this.player;
    const sidewalk = net.nearestEdge(this.spawnPoint.x, this.spawnPoint.z, 80, (e) => e.drivable && e.kind !== 'motorway');
    if (sidewalk) {
      const e = sidewalk.edge;
      const off = e.width / 2 + 1.4;
      const sx = sidewalk.x - e.dz * off;
      const sz = sidewalk.z + e.dx * off;
      p.pos.set(sx, this.world.groundHeight(sx, sz), sz);
      p.heading = Math.atan2(e.dx, e.dz);
      this.rig.yaw = p.heading;
      // A nice car parked right there.
      const pose = parkedPose(e, true, Math.min(0.95, sidewalk.t + 3.5 / e.length));
      const car = createVehicle('sports');
      car.pos.set(pose.x, this.world.groundHeight(pose.x, pose.z), pose.z);
      car.heading = pose.heading;
      car.persistent = true;
      this.entities.addVehicle(car);
    } else {
      p.pos.copy(this.spawnPoint);
    }
    // Resolve out of any building.
    this.world.collision.resolveCircle(p.pos, 0.5, p.pos.y + 0.4, p.pos.y + 1.8);
    this.entities.addCharacter(p);
    this.placeStartPickups();
    this.population.prime();
    this.rig.snapBehind(this.rig.yaw);
    this.state = 'playing';
    this.stateTime = 0;
    this.screens.hideAll();
    this.hud.setVisible(true);
    this.hud.subtitleText(`Welcome to ${this.options.placeName}. Steal a car (F), make some money, and stay away from the Polis.`, 7);
  }

  private placeStartPickups() {
    const p = this.player.pos;
    const net = this.world.roads;
    const spots: [('weapon' | 'health' | 'armor'), number, 'smg' | 'shotgun' | undefined][] = [
      ['weapon', 90, 'smg'],
      ['weapon', 8, 'shotgun'],
      ['health', 100, undefined],
      ['armor', 100, undefined],
    ];
    spots.forEach(([kind, amount, weapon], i) => {
      const a = (i / spots.length) * Math.PI * 2 + 0.5;
      const q = net.nearestEdge(p.x + Math.sin(a) * 45, p.z + Math.cos(a) * 45, 60, (e) => !e.drivable);
      if (!q) return;
      this.pickups.add(kind, q.x, q.z, amount, weapon, 60);
    });
  }

  private pause() {
    this.state = 'paused';
    this.radio?.stop();
    this.audio?.setEngine(false);
    this.audio?.setSiren(null);
    this.screens.showPause();
  }

  private resume() {
    this.input.requestPointerLock();
    this.state = 'playing';
    this.screens.hideAll();
    this.audio?.resume();
  }

  private wasted() {
    if (this.state !== 'playing') return;
    this.state = 'wasted';
    this.stateTime = 0;
    this.hud.bigText('WASTED', 'wasted');
    this.renderer.domElement.classList.add('desaturate');
    this.radio?.stop();
    this.audio?.setEngine(false);
  }

  private busted() {
    if (this.state !== 'playing') return;
    this.state = 'busted';
    this.stateTime = 0;
    this.hud.bigText('BUSTED', 'busted');
    this.renderer.domElement.classList.add('desaturate');
    this.radio?.stop();
    this.audio?.setEngine(false);
    const p = this.player;
    if (p.vehicle) {
      p.vehicle.driver = null;
      p.vehicle = null;
    }
    p.moveX = p.moveZ = 0;
    p.aiming = false;
  }

  private respawn(where: 'hospital' | 'police') {
    const p = this.player;
    // Clear the streets; the population system refills them.
    for (const c of [...this.entities.characters]) if (c !== p) this.entities.removeCharacter(c);
    this.trams.clear();
    for (const v of [...this.entities.vehicles]) this.entities.removeVehicle(v);
    this.pickups.clearDropped();
    this.effects.clearDecals();
    this.police.clear();
    if (where === 'police') {
      p.inventory.clear();
      this.money = Math.max(0, this.money - 250);
    } else {
      this.money = Math.max(0, this.money - 500);
    }
    const isDefault = this.options.origin === DEFAULT_ORIGIN;
    const ll = isDefault ? (where === 'hospital' ? HOSPITAL : POLICE_STATION) : this.options.spawn;
    const w = this.projection.toWorld(ll.lat, ll.lon);
    p.pos.set(w.x, 0, w.z);
    p.vel.set(0, 0, 0);
    p.health = p.maxHealth;
    p.armor = 0;
    p.alive = true;
    p.downTime = 0;
    p.vehicle = null;
    this.renderer.domElement.classList.remove('desaturate');
    this.hud.bigText(null);
    this.state = 'loading';
    this.stateTime = 0;
    this.respawning = true;
    this.hud.setVisible(false);
    this.screens.showLoading(where === 'hospital' ? 'Sahlgrenska' : 'Polishuset');
  }

  private respawning = false;
  private lastPlayerDamage = -100;

  // --- Main loop ----------------------------------------------------------------------------

  private frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const rawDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = Math.min(rawDt, 1 / 20);
    this.fps += (1 / Math.max(rawDt, 1e-3) - this.fps) * 0.05;
    this.time += dt;
    this.stateTime += dt;

    switch (this.state) {
      case 'title':
        this.titleCamera(dt);
        break;
      case 'loading':
        this.updateLoading(dt);
        break;
      case 'playing':
      case 'wasted':
      case 'busted':
        this.simulate(dt);
        break;
      case 'paused':
        break;
    }
    this.sky?.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private titleCamera(dt: number) {
    // Slow orbit above the spawn while the title screen shows.
    const s = this.projection.toWorld(DEFAULT_SPAWN.lat, DEFAULT_SPAWN.lon);
    const target = this.options.origin === DEFAULT_ORIGIN ? s : { x: 0, z: 0 };
    this.world.update(dt, target.x, target.z, 8);
    const a = this.time * 0.05;
    const ty = this.world.groundHeight(target.x, target.z);
    this.camera.position.set(target.x + Math.sin(a) * 160, ty + 90, target.z + Math.cos(a) * 160);
    this.camera.lookAt(target.x, ty, target.z);
    this.sun.position.set(target.x, ty, target.z).add(this.sunOffset);
    this.sun.target.position.set(target.x, ty, target.z);
    this.effects.update(dt);
  }

  private updateLoading(dt: number) {
    const p = this.player.pos;
    this.world.update(dt, p.x, p.z, 30);
    const progress = this.world.loadProgress(p.x, p.z, 1);
    const live = this.world.pendingLive;
    const err = this.world.source.lastError;
    this.screens.setProgress(
      progress,
      live ? `Downloading map data from OpenStreetMap… (${live} request${live > 1 ? 's' : ''})${err ? ` — retrying: ${err.slice(0, 80)}` : ''}` : 'Building the city…',
    );
    const gy = this.world.groundHeight(p.x, p.z);
    this.camera.position.set(p.x + 60, gy + 70, p.z + 60);
    this.camera.lookAt(p.x, gy, p.z);
    if (progress >= 1 && this.stateTime > 0.3) {
      if (this.respawning) {
        this.respawning = false;
        const q = this.world.roads.nearestEdge(p.x, p.z, 60, (e) => !e.drivable || e.kind === 'residential');
        if (q) this.player.pos.set(q.x, 0, q.z);
        const pp = this.player.pos;
        pp.y = this.world.groundHeight(pp.x, pp.z);
        this.world.collision.resolveCircle(pp, 0.5, pp.y + 0.4, pp.y + 1.8);
        this.population.prime();
        this.state = 'playing';
        this.screens.hideAll();
        this.hud.setVisible(true);
        this.input.requestPointerLock();
        this.rig.snapBehind(this.rig.yaw);
      } else {
        this.enterWorld();
      }
    }
  }

  private simulate(dt: number) {
    const ctx = this.ctx;
    ctx.time = this.time;
    const p = this.player;
    const playing = this.state === 'playing';
    this.input.enabled = playing;

    if (playing) {
      if (this.input.wasPressed('KeyM')) this.toggleMap();
      this.controller.update(dt);
    } else {
      p.moveX = p.moveZ = 0;
      p.aiming = false;
      if (p.vehicle) {
        p.vehicle.controls.throttle = 0;
        p.vehicle.controls.handbrake = true;
      }
    }

    this.entities.updateBrains(dt, ctx);
    for (const c of this.entities.characters) c.update(dt, this.world);
    for (const v of this.entities.vehicles) {
      v.update(dt, this.world);
      processVehicleImpacts(ctx, this.combat, v);
    }
    // Keep occupants with their vehicles.
    for (const c of this.entities.characters) if (c.vehicle) c.pos.copy(c.vehicle.pos);
    resolveInteractions(ctx, this.combat);
    this.combat.updateVehicles(dt);
    if (playing) this.police.update(dt);
    this.population.update(dt);
    this.trams.update(dt);
    this.updatePickups(dt);
    // Like GTA V: health slowly regenerates to half after a while without taking damage.
    if (p.alive && p.health < p.maxHealth * 0.5 && this.time - this.lastPlayerDamage > 6) {
      p.health = Math.min(p.maxHealth * 0.5, p.health + dt * 2);
    }

    const focus = p.vehicle ? p.vehicle.pos : p.pos;
    this.world.update(dt, focus.x, focus.z);
    this.effects.update(dt);

    this.rig.update(dt, this.input, p, this.world, this.effects.shake);
    this.sun.position.copy(focus).add(this.sunOffset);
    this.sun.target.position.copy(focus);
    this.updateAudio();
    this.updateHud(dt);

    if ((this.state === 'wasted' || this.state === 'busted') && this.stateTime > 4.5) {
      this.respawn(this.state === 'wasted' ? 'hospital' : 'police');
    }
  }

  private updatePickups(dt: number) {
    const p = this.player;
    const labels = this.pickups.update(dt, p, (item) => {
      switch (item.kind) {
        case 'cash':
          this.money += item.amount;
          return true;
        case 'weapon':
          p.inventory.give(item.weapon!, item.amount);
          if (p.inventory.current === 'fists') p.inventory.select(item.weapon!);
          return true;
        case 'health':
          if (p.health >= p.maxHealth) return false;
          p.health = p.maxHealth;
          return true;
        case 'armor':
          if (p.armor >= 100) return false;
          p.armor = 100;
          return true;
      }
    });
    for (const l of labels) {
      this.hud.notify(l);
      this.audio?.pickup();
    }
  }

  private updateAudio() {
    const audio = this.audio;
    if (!audio) return;
    audio.setListener(this.camera);
    const p = this.player;
    const v = p.vehicle;
    if (v !== this.lastVehicle) {
      if (v) {
        this.hud.showVehicle(v.spec.name);
        if (this.radio && !this.radio.isOn) this.hud.showRadio(this.radio.next());
      } else {
        this.radio?.stop();
        audio.setEngine(false);
      }
      this.lastVehicle = v;
    }
    if (!v) audio.setEngine(false);
    // Nearest siren.
    let best: Vehicle | null = null;
    let bestD = 160;
    for (const c of this.entities.vehicles) {
      if (!c.sirenOn || !c.alive) continue;
      const d = c.pos.distanceTo(this.camera.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    audio.setSiren(best ? best.pos : null);
  }

  private updateHud(dt: number) {
    const p = this.player;
    const inv = p.inventory;
    const focus = p.vehicle ? p.vehicle.pos : p.pos;
    const stars = this.police.stars;
    this.hud.update(
      dt,
      {
        health: p.health,
        maxHealth: p.maxHealth,
        armor: p.armor,
        money: this.money,
        stars,
        starsFlashing: stars > 0 && !this.police.seen,
        weapon: inv.current,
        clip: inv.clip,
        reserve: inv.reserve,
        reloading: inv.isReloading,
        crosshair: !p.vehicle && p.alive && (p.aiming || this.input.isMouseDown(0)) && !WEAPONS[inv.current].melee,
        hint: this.state === 'playing' ? this.controller.hint : null,
        loading: this.world.pendingLive > 0 ? 'Streaming map data…' : null,
      },
      this.time,
    );

    const road = this.world.roads.nearestEdge(focus.x, focus.z, 14, (e) => !!e.name);
    const place = this.world.nearestPlace(focus.x, focus.z);
    this.hud.setLocation(road?.edge.name ?? null, place?.name ?? null);

    const blips: Blip[] = [];
    const flash = Math.floor(this.time * 4) % 2 === 0;
    for (const c of this.entities.characters) {
      if (c.role !== 'cop' || !c.alive || stars === 0) continue;
      const pos = c.vehicle ? c.vehicle.pos : c.pos;
      blips.push({ x: pos.x, z: pos.z, color: flash ? '#e53935' : '#1e63e5', size: c.vehicle ? 5 : 3.5 });
    }
    const heading = p.vehicle ? p.vehicle.heading : p.heading;
    blips.push({ x: focus.x, z: focus.z, color: '#ffffff', size: 5, heading });
    const speed = p.vehicle ? p.vehicle.speed : 0;
    const mpp = 0.9 + Math.min(speed, 40) * 0.025;
    const alert = stars > 0 ? (flash ? '#e53935' : '#1e63e5') : null;
    this.hud.drawMinimap(this.world, focus.x, focus.z, this.rig.yaw, mpp, blips, alert);
  }

  private toggleMap() {
    this.mapOpen = !this.mapOpen;
    this.screens.showMap(this.mapOpen ? { world: this.world, x: this.player.pos.x, z: this.player.pos.z, heading: this.player.heading, projection: this.projection } : null);
  }
}
