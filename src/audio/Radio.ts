import type { AudioEngine } from './AudioEngine';

interface Station {
  name: string;
  bpm: number;
  swing: number;
  /** Chord progression, each chord as MIDI notes; one chord per bar. */
  chords: number[][];
  kick: string;
  snare: string;
  hat: string;
  bass: string;
  /** Arp/lead pattern: indices into the current chord (-1 = rest), 16 steps. */
  lead: number[];
  leadWave: OscillatorType;
  bassWave: OscillatorType;
  padWave: OscillatorType | null;
  leadOctave: number;
  bassCutoff: number;
}

// Step patterns: 16 sixteenth notes per bar. 'x' = hit, '.' = rest, 'o' = accent/ghost variations.
const STATIONS: Station[] = [
  {
    name: 'Radio Göta 104.5 — Synthwave',
    bpm: 98,
    swing: 0,
    chords: [
      [57, 60, 64],
      [53, 57, 60],
      [48, 52, 55],
      [55, 59, 62],
    ],
    kick: 'x...x...x...x...',
    snare: '....x.......x...',
    hat: '..x...x...x...x.',
    bass: 'x.xxx.xxx.xxx.xx',
    lead: [0, -1, 1, -1, 2, -1, 1, -1, 0, -1, 1, -1, 2, 1, 0, -1],
    leadWave: 'sawtooth',
    bassWave: 'sawtooth',
    padWave: 'sawtooth',
    leadOctave: 12,
    bassCutoff: 500,
  },
  {
    name: 'Hisingen Techno FM',
    bpm: 128,
    swing: 0,
    chords: [
      [45, 48, 52],
      [45, 48, 52],
      [43, 47, 50],
      [41, 45, 48],
    ],
    kick: 'x...x...x...x...',
    snare: '....x.......x..x',
    hat: '..x...x...x...xx',
    bass: '..x...x...x.x.x.',
    lead: [0, -1, -1, 0, -1, -1, 2, -1, -1, 1, -1, -1, 0, -1, 2, -1],
    leadWave: 'square',
    bassWave: 'sawtooth',
    padWave: null,
    leadOctave: 24,
    bassCutoff: 900,
  },
  {
    name: 'Vallgraven Lounge — Lo-fi',
    bpm: 78,
    swing: 0.18,
    chords: [
      [50, 53, 57, 60],
      [55, 59, 62, 65],
      [48, 52, 55, 59],
      [45, 48, 52, 55],
    ],
    kick: 'x......x..x.....',
    snare: '....x.......x...',
    hat: 'x.x.x.x.x.x.x.x.',
    bass: 'x.....x...x.....',
    lead: [3, -1, -1, 2, -1, -1, 1, -1, -1, -1, 2, -1, 0, -1, -1, -1],
    leadWave: 'triangle',
    bassWave: 'triangle',
    padWave: 'triangle',
    leadOctave: 12,
    bassCutoff: 400,
  },
];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A procedural in-car radio with a few "stations", scheduled ahead of time with Web Audio. */
export class Radio {
  private station = -1;
  private timer: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private bus: GainNode | null = null;
  private readonly noise: AudioBuffer;

  constructor(private readonly audio: AudioEngine) {
    const ctx = audio.ctx;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  get stationName(): string | null {
    return this.station >= 0 ? STATIONS[this.station].name : null;
  }

  get isOn(): boolean {
    return this.station >= 0;
  }

  /** Switches to the next station (after the last one, the radio turns off). */
  next(): string {
    const n = this.station + 1;
    this.play(n >= STATIONS.length ? -1 : n);
    return this.stationName ?? 'Radio off';
  }

  play(index: number) {
    this.stop();
    this.station = index;
    if (index < 0) return;
    const ctx = this.audio.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.gain.setTargetAtTime(1, ctx.currentTime, 0.3);
    // A touch of "radio" band-limiting.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    this.bus.connect(hp).connect(this.audio.music);
    this.step = 0;
    this.nextStepTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.bus) {
      const bus = this.bus;
      bus.gain.setTargetAtTime(0, this.audio.ctx.currentTime, 0.1);
      setTimeout(() => bus.disconnect(), 600);
    }
    this.bus = null;
    this.station = -1;
  }

  private schedule() {
    const ctx = this.audio.ctx;
    const st = STATIONS[this.station];
    if (!st || !this.bus) return;
    const stepDur = 60 / st.bpm / 4;
    while (this.nextStepTime < ctx.currentTime + 0.15) {
      const s = this.step % 16;
      const bar = Math.floor(this.step / 16);
      const chord = st.chords[bar % st.chords.length];
      const t = this.nextStepTime + (s % 2 === 1 ? st.swing * stepDur : 0);
      if (st.kick[s] === 'x') this.kick(t);
      if (st.snare[s] === 'x') this.snare(t);
      if (st.hat[s] === 'x') this.hat(t, s % 4 === 2 ? 0.07 : 0.04);
      if (st.bass[s] === 'x') this.tone(t, mtof(chord[0] - 12), stepDur * 1.6, st.bassWave, 0.2, st.bassCutoff);
      const li = st.lead[s];
      // Vary the melody every other bar so it's less repetitive.
      if (li >= 0 && !(bar % 4 === 3 && s > 8)) {
        const note = chord[(li + (bar % 2)) % chord.length] + st.leadOctave;
        this.tone(t, mtof(note), stepDur * 1.8, st.leadWave, 0.06, 2600);
      }
      if (s === 0 && st.padWave) {
        for (const n of chord) this.tone(t, mtof(n), stepDur * 16, st.padWave, 0.025, 1200, 0.4);
      }
      this.nextStepTime += stepDur;
      this.step++;
    }
  }

  private tone(t: number, freq: number, dur: number, wave: OscillatorType, gain: number, cutoff: number, attack = 0.01) {
    const ctx = this.audio.ctx;
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.4), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(f).connect(g).connect(this.bus!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number) {
    const ctx = this.audio.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.bus!);
    o.start(t);
    o.stop(t + 0.35);
  }

  private snare(t: number) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(f).connect(g).connect(this.bus!);
    src.start(t);
    src.stop(t + 0.2);
  }

  private hat(t: number, gain: number) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(f).connect(g).connect(this.bus!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.06);
  }
}
