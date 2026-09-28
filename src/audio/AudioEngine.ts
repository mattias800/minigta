import type * as THREE from 'three';
import { clamp } from '../core/math';

type Vec = { x: number; y: number; z: number };

/**
 * All game audio is synthesized with the Web Audio API (no sample assets): gunshots and explosions
 * from filtered noise, engines and sirens from oscillators. Positional sounds use PannerNodes.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly music: GainNode;
  private readonly noise: AudioBuffer;
  private engine: EngineSound | null = null;
  private siren: SirenSound | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    // Gentle compression keeps explosions from clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.music = this.ctx.createGain();
    this.music.gain.value = 0.45;
    this.music.connect(this.master);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setListener(camera: THREE.Camera) {
    const l = this.ctx.listener;
    const p = camera.position;
    const m = camera.matrixWorld.elements;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(-m[8], t, 0.02);
      l.forwardY.setTargetAtTime(-m[9], t, 0.02);
      l.forwardZ.setTargetAtTime(-m[10], t, 0.02);
      l.upX.setTargetAtTime(m[4], t, 0.02);
      l.upY.setTargetAtTime(m[5], t, 0.02);
      l.upZ.setTargetAtTime(m[6], t, 0.02);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
    }
  }

  /**
   * Creates a panner at a world position feeding the sfx bus. One-shot sounds pass a lifetime
   * (seconds) after which the panner is disconnected so the graph doesn't grow.
   */
  panner(pos: Vec, refDistance = 6, lifetime = 3): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = 1.1;
    p.maxDistance = 400;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.sfx);
    if (lifetime > 0) setTimeout(() => p.disconnect(), lifetime * 1000);
    return p;
  }

  private noiseBurst(dest: AudioNode, start: number, duration: number, filterType: BiquadFilterType, freq: number, freqEnd: number, gain: number, q = 0.8) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, start);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + duration);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + duration);
    src.connect(f).connect(g).connect(dest);
    src.start(start, Math.random() * 1.5);
    src.stop(start + duration + 0.05);
  }

  private thump(dest: AudioNode, start: number, f0: number, f1: number, duration: number, gain: number) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, start);
    o.frequency.exponentialRampToValueAtTime(f1, start + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + duration);
    o.connect(g).connect(dest);
    o.start(start);
    o.stop(start + duration + 0.05);
  }

  gunshot(weapon: string, pos: Vec) {
    const t = this.ctx.currentTime;
    const p = this.panner(pos, 8);
    if (weapon === 'shotgun') {
      this.noiseBurst(p, t, 0.45, 'lowpass', 5000, 200, 1.4);
      this.thump(p, t, 140, 40, 0.25, 1.2);
    } else if (weapon === 'smg') {
      this.noiseBurst(p, t, 0.12, 'bandpass', 2600, 700, 1.3, 0.6);
      this.thump(p, t, 180, 60, 0.07, 0.6);
    } else {
      this.noiseBurst(p, t, 0.22, 'lowpass', 6000, 300, 1.2);
      this.thump(p, t, 220, 50, 0.12, 0.9);
    }
    // Urban echo tail.
    this.noiseBurst(p, t + 0.08, 0.5, 'lowpass', 900, 150, 0.12);
  }

  explosion(pos: Vec) {
    const t = this.ctx.currentTime;
    const p = this.panner(pos, 20);
    this.noiseBurst(p, t, 2.2, 'lowpass', 2500, 60, 2.2);
    this.thump(p, t, 90, 25, 1.2, 2.2);
  }

  impact(pos: Vec, strength: number) {
    const t = this.ctx.currentTime;
    const p = this.panner(pos, 6);
    const s = clamp(strength, 0.1, 1.5);
    this.noiseBurst(p, t, 0.25 + s * 0.2, 'lowpass', 1400 + s * 1500, 120, 0.6 * s);
    this.thump(p, t, 120, 40, 0.2, 0.7 * s);
    if (s > 0.5) this.noiseBurst(p, t + 0.02, 0.4, 'highpass', 4000, 2500, 0.15 * s); // glass
  }

  punch(pos: Vec) {
    const t = this.ctx.currentTime;
    const p = this.panner(pos, 4);
    this.thump(p, t, 160, 60, 0.1, 0.9);
    this.noiseBurst(p, t, 0.08, 'lowpass', 1800, 300, 0.4);
  }

  splash(pos: Vec) {
    const t = this.ctx.currentTime;
    this.noiseBurst(this.panner(pos, 8), t, 0.9, 'lowpass', 3000, 200, 1.0);
  }

  horn(pos: Vec, duration = 0.5) {
    const t = this.ctx.currentTime;
    const p = this.panner(pos, 8);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.02);
    g.gain.setValueAtTime(0.18, t + duration);
    g.gain.linearRampToValueAtTime(0, t + duration + 0.05);
    g.connect(p);
    for (const f of [392, 494]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + duration + 0.1);
    }
  }

  /** The classic two-stroke tram bell. */
  tramBell(pos: Vec) {
    const t = this.ctx.currentTime;
    const p = this.panner(pos, 10);
    for (const [i, off] of [0, 0.28].entries()) {
      for (const f of [1320, 1980, 2650]) {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * (i ? 0.98 : 1);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.12 / (f / 1320), t + off);
        g.gain.exponentialRampToValueAtTime(0.001, t + off + 0.7);
        o.connect(g).connect(p);
        o.start(t + off);
        o.stop(t + off + 0.75);
      }
    }
  }

  pickup() {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.connect(this.sfx);
    [880, 1320].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const gg = this.ctx.createGain();
      gg.gain.setValueAtTime(0.2, t + i * 0.07);
      gg.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.2);
      o.connect(gg).connect(g);
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.25);
    });
  }

  /** Short UI stinger (wanted level up, mission text, ...). */
  stinger(up: boolean) {
    const t = this.ctx.currentTime;
    const notes = up ? [392, 523] : [523, 392];
    notes.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const flt = this.ctx.createBiquadFilter();
      flt.frequency.value = 1500;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.1, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.3);
      o.connect(flt).connect(g).connect(this.sfx);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.35);
    });
  }

  /** Continuous engine sound for the player's vehicle. */
  setEngine(active: boolean, speed = 0, throttle = 0, maxSpeed = 40) {
    if (active && !this.engine) this.engine = new EngineSound(this.ctx, this.sfx);
    if (!active && this.engine) {
      this.engine.stop();
      this.engine = null;
    }
    this.engine?.update(speed, throttle, maxSpeed);
  }

  /** Siren of the nearest pursuing police car; volume 0 disables it. */
  setSiren(pos: Vec | null) {
    if (pos && !this.siren) this.siren = new SirenSound(this);
    if (!pos && this.siren) {
      this.siren.stop();
      this.siren = null;
    }
    if (pos) this.siren?.setPosition(pos);
  }
}

class EngineSound {
  private readonly osc1: OscillatorNode;
  private readonly osc2: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(private readonly ctx: AudioContext, dest: AudioNode) {
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 3;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.osc1.connect(this.filter);
    this.osc2.connect(g2).connect(this.filter);
    this.filter.connect(this.gain).connect(dest);
    this.osc1.start();
    this.osc2.start();
    this.gain.gain.setTargetAtTime(0.09, ctx.currentTime, 0.2);
  }

  update(speed: number, throttle: number, maxSpeed: number) {
    // Fake a 5-speed gearbox: rpm rises within each gear band.
    const ratio = clamp(Math.abs(speed) / maxSpeed, 0, 1);
    const gears = 5;
    const g = Math.min(gears - 1, Math.floor(ratio * gears));
    const inGear = ratio * gears - g;
    const rpm = 0.25 + inGear * 0.65 + (g === 0 ? 0 : 0.1);
    const f = 38 + rpm * 70;
    const t = this.ctx.currentTime;
    this.osc1.frequency.setTargetAtTime(f, t, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.filter.frequency.setTargetAtTime(300 + rpm * 900 + Math.abs(throttle) * 600, t, 0.05);
    this.gain.gain.setTargetAtTime(0.06 + Math.abs(throttle) * 0.06, t, 0.1);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.1);
    this.osc1.stop(t + 0.5);
    this.osc2.stop(t + 0.5);
  }
}

class SirenSound {
  private readonly osc: OscillatorNode;
  private readonly lfo: OscillatorNode;
  private readonly panner: PannerNode;
  private readonly gain: GainNode;

  constructor(private readonly audio: AudioEngine) {
    const ctx = audio.ctx;
    this.panner = audio.panner({ x: 0, y: 0, z: 0 }, 15, 0);
    this.osc = ctx.createOscillator();
    this.osc.type = 'triangle';
    this.osc.frequency.value = 900;
    // "Wail": slow sweep between ~650 and ~1350 Hz.
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.32;
    const depth = ctx.createGain();
    depth.gain.value = 350;
    this.lfo.connect(depth).connect(this.osc.frequency);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.22;
    this.osc.connect(this.gain).connect(this.panner);
    this.osc.start();
    this.lfo.start();
  }

  setPosition(p: Vec) {
    const t = this.audio.ctx.currentTime;
    this.panner.positionX.setTargetAtTime(p.x, t, 0.05);
    this.panner.positionY.setTargetAtTime(p.y, t, 0.05);
    this.panner.positionZ.setTargetAtTime(p.z, t, 0.05);
  }

  stop() {
    const t = this.audio.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.1);
    this.osc.stop(t + 0.5);
    this.lfo.stop(t + 0.5);
  }
}
