/* =============================================================================
   HTY Sound Design — resonant chords + UI sound palette
   --------------------------------------------------------------------------
   Two instruments sharing one mix + FX chain:

   1. Chord resonator — white noise through a bank of cascaded band-pass
      resonators tuned to a chord. Drone / Strike / keyboard A–K.

   2. UI sound palette (Studio Dumbar flavour) — one-shot voices triggered by
      pads or number keys 1–5:
        Click  — short hi-passed noise burst (transient)
        Plop   — sine with fast downward pitch drop (membrane "doink")
        Bell   — 2-op FM, metallic short decay
        Sub    — low sine thump + click layer
        Whoosh — band-pass noise with a sweeping cutoff

   Everything feeds a shared FX bus: Drive → Tone → (Dry + Delay + Space) →
   master → limiter → analyser → out (+ recorder tap).
   ============================================================================= */

(function () {
  'use strict';

  // ---- Music theory --------------------------------------------------------

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const CHORDS = {
    'Single':  [0],
    'Power':   [0, 7],
    'Major':   [0, 4, 7],
    'Minor':   [0, 3, 7],
    'Sus2':    [0, 2, 7],
    'Sus4':    [0, 5, 7],
    'Maj7':    [0, 4, 7, 11],
    'Min7':    [0, 3, 7, 10],
    'Dom7':    [0, 4, 7, 10],
    'Dim':     [0, 3, 6],
    'Aug':     [0, 4, 8],
    'Add9':    [0, 4, 7, 14],
  };

  const MODES = ['Bandpass', 'EQ Peaks'];
  const PALETTE = ['Click', 'Plop', 'Bell', 'Sub', 'Whoosh', 'Chord'];
  const VOICE_COLORS = {
    Click:  '#8fd3ff',
    Plop:   '#ff9ecb',
    Bell:   '#ffd66b',
    Sub:    '#ff9b73',
    Whoosh: '#9cf0c0',
    Chord:  '#c5a8ff',
  };

  const KEY_SEMITONE = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5,
    t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
  };

  const STAGES = 3;

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const dbToLin = (db) => Math.pow(10, db / 20);

  // ---- State ---------------------------------------------------------------

  const state = {
    root: 0,
    octave: 3,
    octaveShift: 0,
    chord: 'Major',
    mode: 'Bandpass',
    q: 80,
    gain: 6,
    noise: 0.35,
    volume: 0.7,
    attack: 0.04,
    release: 0.6,
    strum: 0,
    // fx
    drive: 0,
    tone: 18000,
    delay: 0,
    space: 0,
    droneOn: false,
    selectedVoice: null,
  };

  // ---- Web Audio nodes -----------------------------------------------------

  let ctx = null;
  let noiseBuf = null;       // shared white-noise buffer (one-shots)
  let noiseSource = null;    // looping drone source
  let notes = [];
  let resoBus = null;
  let dryGain = null;

  // fx bus
  let fxInput = null;
  let drive = null;
  let tone = null;
  let dryNode = null;
  let delayNode = null;
  let delayFb = null;
  let delaySend = null;
  let convolver = null;
  let reverbSend = null;
  let masterSum = null;
  let masterGain = null;
  let limiter = null;
  let analyser = null;
  let freqData = null;

  // recording
  let recNode = null, recSink = null, recChunks = [], recording = false;

  function makeNoiseBuffer(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function makeImpulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buffer;
  }

  function makeDriveCurve(amount) {
    const k = (amount / 100) * 40;
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = makeNoiseBuffer(2);

    // chord buses
    resoBus = ctx.createGain();
    dryGain = ctx.createGain();
    dryGain.gain.value = 0;

    // fx chain
    fxInput = ctx.createGain();
    drive = ctx.createWaveShaper();
    drive.curve = makeDriveCurve(0);
    drive.oversample = '2x';
    tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = state.tone;
    tone.Q.value = 0.7;

    dryNode = ctx.createGain();
    dryNode.gain.value = 1;

    delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.16;
    delayFb = ctx.createGain();
    delayFb.gain.value = 0;
    delaySend = ctx.createGain();
    delaySend.gain.value = 0;

    convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(1.8, 2.6);
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0;

    masterSum = ctx.createGain();
    masterGain = ctx.createGain();
    masterGain.gain.value = state.volume;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.7;
    freqData = new Uint8Array(analyser.frequencyBinCount);

    // wiring: sources → fxInput → drive → tone → [dry | delay | reverb] → sum
    resoBus.connect(fxInput);
    dryGain.connect(fxInput);
    fxInput.connect(drive);
    drive.connect(tone);

    tone.connect(dryNode);
    dryNode.connect(masterSum);

    tone.connect(delaySend);
    delaySend.connect(delayNode);
    delayNode.connect(delayFb);
    delayFb.connect(delayNode);     // feedback loop
    delayNode.connect(masterSum);

    tone.connect(reverbSend);
    reverbSend.connect(convolver);
    convolver.connect(masterSum);

    masterSum.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(ctx.destination);

    applyFX();
  }

  function resume() {
    ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function applyFX() {
    if (!ctx) return;
    const t = ctx.currentTime;
    drive.curve = makeDriveCurve(state.drive);
    tone.frequency.setTargetAtTime(state.tone, t, 0.02);
    delaySend.gain.setTargetAtTime((state.delay / 100) * 0.5, t, 0.02);
    delayFb.gain.setTargetAtTime((state.delay / 100) * 0.55, t, 0.02);
    reverbSend.gain.setTargetAtTime((state.space / 100) * 0.7, t, 0.02);
  }

  // ============================================================================
  // Chord resonator
  // ============================================================================

  function ensureNoise() {
    resume();
    if (noiseSource) return;
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = makeNoiseBuffer(2);
    noiseSource.loop = true;
    noiseSource.start();
    rebuildFilters();
  }

  function stopNoise() {
    const src = noiseSource;
    noiseSource = null;
    if (src) setTimeout(() => { try { src.stop(); src.disconnect(); } catch (e) {} }, 60);
  }

  function chordNotes() {
    const intervals = CHORDS[state.chord];
    const rootMidi = (state.octave + 1 + state.octaveShift) * 12 + state.root;
    return intervals.map((iv) => {
      const midi = rootMidi + iv;
      return { midi, freq: midiToFreq(midi), name: noteName(midi) };
    });
  }

  function resoLevel() {
    return dbToLin(state.gain) * Math.sqrt(state.q / 80) * STAGES;
  }

  // Self-contained sustained chord, used by the sequencer / palette pad. Unlike
  // the live drone (which shares `notes`), this spins up its own noise source +
  // filter bank so several scheduled chords can overlap. Root pitch comes from
  // `rootMidi`; chord type + tone come from the current sidebar settings. It
  // sustains for `lenSec`, then releases, and cleans itself up.
  function playChordVoice(dest, t, rootMidi, lenSec) {
    if (!ctx) return;
    const intervals = CHORDS[state.chord];
    const level = resoLevel();
    const atk = state.attack;
    const rel = state.release;
    const hold = Math.max(lenSec, 0.02);
    const tEnd = t + atk + hold + rel;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    const bus = ctx.createGain();          // shared envelope for the whole chord
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(level, t + atk);
    bus.gain.setValueAtTime(level, t + atk + hold);
    bus.gain.linearRampToValueAtTime(0.0001, tEnd);
    bus.connect(dest);

    intervals.forEach((iv, i) => {
      const freq = midiToFreq(rootMidi + iv);
      let node = src;
      for (let s = 0; s < STAGES; s++) {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = freq;
        f.Q.value = state.q;
        node.connect(f);
        node = f;
      }
      // optional strum: stagger note entries within the chord's own sub-gain
      if (state.strum > 0) {
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(1, t + i * state.strum + 0.001);
        node.connect(ng);
        ng.connect(bus);
      } else {
        node.connect(bus);
      }
    });

    src.start(t);
    src.stop(tEnd + 0.05);
  }

  function rebuildFilters() {
    if (!ctx || !noiseSource) return;
    notes.forEach((n) => {
      n.filters.forEach((f) => { try { f.disconnect(); } catch (e) {} });
      try { n.gain.disconnect(); } catch (e) {}
    });

    const defs = chordNotes();
    notes = defs.map((d) => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filters = [];
      let node = noiseSource;
      for (let s = 0; s < STAGES; s++) {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = d.freq;
        f.Q.value = state.q;
        node.connect(f);
        node = f;
        filters.push(f);
      }
      node.connect(gain);
      gain.connect(resoBus);
      return Object.assign({ filters, gain }, d);
    });

    applyLiveParams();
    updateReadout();
  }

  function applyLiveParams() {
    if (!ctx) return;
    const t = ctx.currentTime;
    notes.forEach((n) => n.filters.forEach((f) => f.Q.setTargetAtTime(state.q, t, 0.02)));
    resoBus.gain.setTargetAtTime(resoLevel(), t, 0.02);
    dryGain.gain.setTargetAtTime(state.mode === 'EQ Peaks' ? state.noise : 0, t, 0.02);
    masterGain.gain.setTargetAtTime(state.volume, t, 0.02);
  }

  function noteOn(n, when, level) {
    const g = n.gain.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    g.linearRampToValueAtTime(level, when + state.attack);
  }

  function noteOff(n, when) {
    const g = n.gain.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    g.linearRampToValueAtTime(0.0001, when + state.release);
  }

  function chordOn() {
    ensureNoise();
    rebuildFilters();
    const t = ctx.currentTime;
    notes.forEach((n, i) => noteOn(n, t + i * state.strum, 1));
  }

  function chordOff() {
    if (!ctx) return;
    const t = ctx.currentTime;
    notes.forEach((n) => noteOff(n, t));
  }

  function strike() {
    ensureNoise();
    rebuildFilters();
    const t = ctx.currentTime;
    notes.forEach((n, i) => {
      const when = t + i * state.strum;
      noteOn(n, when, 1);
      noteOff(n, when + state.attack);
    });
  }

  function toggleDrone() {
    if (state.droneOn) {
      state.droneOn = false;
      chordOff();
    } else {
      state.droneOn = true;
      chordOn();
    }
    updatePlayButton();
  }

  // ============================================================================
  // UI sound palette (one-shots)
  // ============================================================================

  // Linear up then exponential down — characteristic percussive envelope.
  function ampEnv(g, t, peak, attack, decay) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
  }

  function baseMidi() {
    return (state.octave + 1 + state.octaveShift) * 12 + state.root;
  }

  // Reusable hi-passed noise click (used by Click + Sub).
  function clickBurst(dest, t, level, hp, decay) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(dest);
    ampEnv(g, t, 0.9 * level, 0.0005, decay);
    src.start(t); src.stop(t + decay + 0.04);
  }

  // ---- Voice definitions: params + synthesis -------------------------------
  // Each play(dest, t, p) reads its live params object p.

  const fHz = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
  const fMs = (n) => n + 'ms';
  const fSemi = (n) => (n > 0 ? '+' : '') + n;

  const VOICE_DEFS = {
    Click: {
      params: [
        { k: 'hp', label: 'HP', min: 800, max: 12000, step: 100, def: 3200, fmt: fHz },
        { k: 'decay', label: 'Decay', min: 3, max: 150, step: 1, def: 28, fmt: fMs },
        { k: 'body', label: 'Body', min: 0, max: 100, step: 1, def: 0 },
        { k: 'level', label: 'Level', min: 0, max: 100, step: 1, def: 90 },
      ],
      play(dest, t, p, midi) {
        clickBurst(dest, t, p.level / 100, p.hp, p.decay / 1000);
        if (p.body > 0) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = midiToFreq(midi != null ? midi : baseMidi() + 12);
          const g = ctx.createGain();
          osc.connect(g); g.connect(dest);
          ampEnv(g, t, 0.5 * (p.body / 100) * (p.level / 100), 0.001, p.decay / 1000);
          osc.start(t); osc.stop(t + p.decay / 1000 + 0.04);
        }
      },
    },

    Plop: {
      params: [
        { k: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, def: 12, fmt: fSemi },
        { k: 'drop', label: 'Drop', min: 1, max: 36, step: 1, def: 12, fmt: fSemi },
        { k: 'droptime', label: 'Drop T', min: 2, max: 60, step: 1, def: 9, fmt: fMs },
        { k: 'decay', label: 'Decay', min: 20, max: 500, step: 5, def: 110, fmt: fMs },
        { k: 'level', label: 'Level', min: 0, max: 100, step: 1, def: 90 },
      ],
      play(dest, t, p, midi) {
        const f0 = midiToFreq(midi != null ? midi : baseMidi() + p.pitch);
        const start = f0 * Math.pow(2, p.drop / 12);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const g = ctx.createGain();
        osc.connect(g); g.connect(dest);
        osc.frequency.setValueAtTime(start, t);
        osc.frequency.exponentialRampToValueAtTime(f0, t + p.droptime / 1000);
        ampEnv(g, t, 0.9 * (p.level / 100), 0.002, p.decay / 1000);
        osc.start(t); osc.stop(t + p.decay / 1000 + 0.05);
      },
    },

    Bell: {
      params: [
        { k: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, def: 0, fmt: fSemi },
        { k: 'ratio', label: 'Ratio', min: 0.5, max: 8, step: 0.01, def: 1.41, fmt: (n) => n.toFixed(2) },
        { k: 'index', label: 'Index', min: 0, max: 100, step: 1, def: 50 },
        { k: 'decay', label: 'Decay', min: 80, max: 1500, step: 10, def: 500, fmt: fMs },
        { k: 'level', label: 'Level', min: 0, max: 100, step: 1, def: 70 },
      ],
      play(dest, t, p, midi) {
        const f0 = midiToFreq(midi != null ? midi : baseMidi() + p.pitch);
        const carrier = ctx.createOscillator();
        carrier.type = 'sine';
        carrier.frequency.value = f0;
        const mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = f0 * p.ratio;
        const modGain = ctx.createGain();
        const idx = f0 * p.ratio * (p.index / 10);
        const dec = p.decay / 1000;
        modGain.gain.setValueAtTime(idx, t);
        modGain.gain.exponentialRampToValueAtTime(idx * 0.02 + 1, t + dec * 0.9);
        mod.connect(modGain); modGain.connect(carrier.frequency);
        const g = ctx.createGain();
        carrier.connect(g); g.connect(dest);
        ampEnv(g, t, 0.8 * (p.level / 100), 0.002, dec);
        carrier.start(t); mod.start(t);
        carrier.stop(t + dec + 0.05); mod.stop(t + dec + 0.05);
      },
    },

    Sub: {
      params: [
        { k: 'pitch', label: 'Pitch', min: -12, max: 24, step: 1, def: 0, fmt: fSemi },
        { k: 'drop', label: 'Drop', min: 0, max: 24, step: 1, def: 12, fmt: fSemi },
        { k: 'droptime', label: 'Drop T', min: 5, max: 120, step: 1, def: 50, fmt: fMs },
        { k: 'decay', label: 'Decay', min: 50, max: 800, step: 10, def: 240, fmt: fMs },
        { k: 'click', label: 'Click', min: 0, max: 100, step: 1, def: 60 },
        { k: 'level', label: 'Level', min: 0, max: 100, step: 1, def: 100 },
      ],
      play(dest, t, p, midi) {
        const f0 = midiToFreq(midi != null ? midi : 24 + state.root + p.pitch); // octave 1 region
        const start = f0 * Math.pow(2, p.drop / 12);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const g = ctx.createGain();
        osc.connect(g); g.connect(dest);
        osc.frequency.setValueAtTime(start, t);
        osc.frequency.exponentialRampToValueAtTime(f0, t + p.droptime / 1000);
        ampEnv(g, t, 1.0 * (p.level / 100), 0.004, p.decay / 1000);
        osc.start(t); osc.stop(t + p.decay / 1000 + 0.05);
        if (p.click > 0) clickBurst(dest, t, (p.click / 100) * (p.level / 100), 3200, 0.022);
      },
    },

    Whoosh: {
      params: [
        { k: 'from', label: 'From', min: 100, max: 6000, step: 50, def: 300, fmt: fHz },
        { k: 'to', label: 'To', min: 500, max: 14000, step: 100, def: 6000, fmt: fHz },
        { k: 'q', label: 'Q', min: 0.3, max: 8, step: 0.1, def: 1.2, fmt: (n) => n.toFixed(1) },
        { k: 'dur', label: 'Length', min: 80, max: 800, step: 10, def: 300, fmt: fMs },
        { k: 'level', label: 'Level', min: 0, max: 100, step: 1, def: 70 },
      ],
      play(dest, t, p, midi) {
        const dur = p.dur / 1000;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = p.q;
        const g = ctx.createGain();
        src.connect(bp); bp.connect(g); g.connect(dest);
        bp.frequency.setValueAtTime(p.from, t);
        bp.frequency.exponentialRampToValueAtTime(p.to, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.6 * (p.level / 100), t + dur * 0.4);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        src.start(t); src.stop(t + dur + 0.05);
      },
    },

    // The resonant noise chord as a placeable voice. It has no params of its
    // own — its sound is the live Resonator / Shape / FX sidebar settings, and
    // its chord type comes from the sidebar Chord selection. The row it sits on
    // is the chord ROOT. It sustains for its block length (handled separately
    // via playLen); a bare play() is a short audition strike.
    Chord: {
      chord: true,
      params: [],
      play(dest, t, p, midi) {
        const root = midi != null ? midi : baseMidi();
        playChordVoice(dest, t, root, Math.max(state.attack + 0.12, 0.18));
      },
      playLen(dest, t, midi, lenSec) {
        playChordVoice(dest, t, midi != null ? midi : baseMidi(), lenSec);
      },
    },
  };

  // Per-voice live param values, seeded from defaults.
  const voiceParams = {};
  PALETTE.forEach((name) => {
    voiceParams[name] = {};
    VOICE_DEFS[name].params.forEach((pr) => { voiceParams[name][pr.k] = pr.def; });
  });

  function trigger(name) {
    resume();
    VOICE_DEFS[name].play(fxInput, ctx.currentTime + 0.001, voiceParams[name]);
    flashPad(name);
  }

  // ---- Recording -----------------------------------------------------------

  function startRecording() {
    ensureContext();
    recChunks = [];
    recNode = ctx.createScriptProcessor(4096, 1, 1);
    recSink = ctx.createGain();
    recSink.gain.value = 0;
    recNode.onaudioprocess = (e) => {
      if (!recording) return;
      recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    limiter.connect(recNode);
    recNode.connect(recSink);
    recSink.connect(ctx.destination);
    recording = true;
    updateRecordButton();
  }

  function stopRecording() {
    recording = false;
    try { limiter.disconnect(recNode); } catch (e) {}
    try { recNode.disconnect(); } catch (e) {}
    try { recSink.disconnect(); } catch (e) {}
    const wav = encodeWAV(recChunks, ctx.sampleRate);
    recChunks = []; recNode = null; recSink = null;
    updateRecordButton();
    downloadBlob(wav, 'sound-' + Date.now() + '.wav');
  }

  function toggleRecord() {
    if (recording) stopRecording();
    else startRecording();
  }

  function encodeWAV(chunks, sampleRate) {
    let total = 0;
    chunks.forEach((c) => { total += c.length; });
    const samples = new Float32Array(total);
    let off = 0;
    chunks.forEach((c) => { samples.set(c, off); off += c.length; });

    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let p = 44;
    for (let i = 0; i < samples.length; i++, p += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- UI ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const padButtons = {};

  function chipGroup(gridId, items, get, set) {
    const grid = $(gridId);
    const buttons = items.map((label) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = label;
      b.addEventListener('click', () => {
        set(label);
        buttons.forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
      grid.appendChild(b);
      return b;
    });
    const sync = () => buttons.forEach((b, i) => b.classList.toggle('active', items[i] === get()));
    sync();
    return sync;
  }

  let syncNotes;

  function buildPads() {
    const grid = $('pad-grid');
    PALETTE.forEach((name) => {
      const b = document.createElement('button');
      b.className = 'chip pad';
      b.textContent = name;
      b.addEventListener('click', () => { selectVoice(name); trigger(name); });
      grid.appendChild(b);
      padButtons[name] = b;
    });
  }

  function flashPad(name) {
    const b = padButtons[name];
    if (!b) return;
    b.classList.add('triggered');
    setTimeout(() => b.classList.remove('triggered'), 90);
  }

  function selectVoice(name) {
    if (state.selectedVoice === name) return;
    state.selectedVoice = name;
    PALETTE.forEach((n) => padButtons[n].classList.toggle('active', n === name));
    renderVoicePanel(name);
  }

  function renderVoicePanel(name) {
    $('voice-label').textContent = 'Voice — ' + name;
    const host = $('voice-params');
    host.textContent = '';
    const p = voiceParams[name];

    if (VOICE_DEFS[name].chord) {
      const hint = document.createElement('p');
      hint.className = 'voice-hint';
      hint.textContent = 'Uses the Resonator / Shape / FX settings below and the selected Chord. Paint on the row = chord root; drag a block sideways to set its length.';
      host.appendChild(hint);
      return;
    }

    VOICE_DEFS[name].params.forEach((pr) => {
      const row = document.createElement('div');
      row.className = 'slider-row';

      const label = document.createElement('label');
      label.textContent = pr.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = pr.min; input.max = pr.max; input.step = pr.step;
      input.value = p[pr.k];

      const val = document.createElement('span');
      val.className = 'val';
      const fmt = pr.fmt || String;
      val.textContent = fmt(p[pr.k]);

      input.addEventListener('input', () => {
        const num = parseFloat(input.value);
        p[pr.k] = num;
        val.textContent = fmt(num);
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(val);
      host.appendChild(row);
    });
  }

  function buildControls() {
    buildPads();

    syncNotes = chipGroup('note-grid', NOTE_NAMES, () => NOTE_NAMES[state.root], (v) => {
      state.root = NOTE_NAMES.indexOf(v);
      state.octaveShift = 0;
      if (noiseSource) rebuildFilters();
      if (state.droneOn) chordOn();
      updateReadout();
    });

    chipGroup('chord-grid', Object.keys(CHORDS), () => state.chord, (v) => {
      state.chord = v;
      if (noiseSource) rebuildFilters();
      if (state.droneOn) chordOn();
      updateReadout();
    });

    chipGroup('mode-grid', MODES, () => state.mode, (v) => {
      state.mode = v;
      applyLiveParams();
    });
  }

  function bindSlider(id, valId, onChange, fmt) {
    const s = $(id);
    const v = $(valId);
    const update = () => {
      const num = parseFloat(s.value);
      v.textContent = fmt ? fmt(num) : num;
      onChange(num);
    };
    s.addEventListener('input', update);
    update();
  }

  function updatePlayButton() {
    const b = $('btn-play');
    b.textContent = state.droneOn ? 'Stop' : 'Drone';
    b.classList.toggle('playing', state.droneOn);
  }

  function updateRecordButton() {
    const b = $('btn-record');
    b.textContent = recording ? '■ Stop & Save' : '● Record';
    b.classList.toggle('recording', recording);
  }

  function updateReadout() {
    const defs = chordNotes();
    $('r-chord').textContent = NOTE_NAMES[state.root] + ' ' + state.chord;
    $('r-notes').textContent = defs.map((n) => n.name).join('  ');
    $('r-freqs').textContent = defs.map((n) => Math.round(n.freq) + 'Hz').join('  ');
  }

  // ---- Keyboard ------------------------------------------------------------

  const heldKeys = new Set();

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); toggleDrone(); return; }

    // number keys 1–5 → palette
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= PALETTE.length) { selectVoice(PALETTE[n - 1]); trigger(PALETTE[n - 1]); return; }

    const k = e.key.toLowerCase();
    if (!(k in KEY_SEMITONE) || e.repeat) return;
    e.preventDefault();
    heldKeys.add(k);

    const semi = KEY_SEMITONE[k];
    state.root = ((semi % 12) + 12) % 12;
    state.octaveShift = Math.floor(semi / 12);
    if (syncNotes) syncNotes();

    chordOn();
    updateReadout();
  }

  function onKeyUp(e) {
    const k = e.key.toLowerCase();
    if (!(k in KEY_SEMITONE)) return;
    heldKeys.delete(k);
    if (state.droneOn) return;
    if (heldKeys.size === 0) {
      chordOff();
      setTimeout(() => { if (heldKeys.size === 0 && !state.droneOn) stopNoise(); },
                 state.release * 1000 + 120);
    }
  }

  // ---- Spectrum analyser ---------------------------------------------------

  let rafId = null;

  function drawScope() {
    const canvas = $('scope');

    function frame() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      if (analyser) analyser.getByteFrequencyData(freqData);

      const nyquist = ctx ? ctx.sampleRate / 2 : 22050;
      const minF = 20, maxF = 16000;
      const logMin = Math.log10(minF), logMax = Math.log10(maxF);
      const N = freqData ? freqData.length : 0;

      g.beginPath();
      let started = false;
      for (let x = 0; x <= w; x++) {
        const f = Math.pow(10, logMin + (x / w) * (logMax - logMin));
        const bin = Math.round((f / nyquist) * N);
        const v = freqData ? freqData[Math.min(bin, N - 1)] / 255 : 0;
        const y = h - v * h * 0.95;
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.stroke();

      if (state.droneOn || (ctx && noiseSource)) {
        const defs = chordNotes();
        g.font = "10px 'Suisse Intl Mono', monospace";
        defs.forEach((n) => {
          if (n.freq < minF || n.freq > maxF) return;
          const x = ((Math.log10(n.freq) - logMin) / (logMax - logMin)) * w;
          g.strokeStyle = 'rgba(255,255,255,0.16)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
          g.fillStyle = 'rgba(255,255,255,0.55)';
          g.fillText(n.name, x + 4, 14);
        });
      }

      rafId = requestAnimationFrame(frame);
    }

    if (rafId) cancelAnimationFrame(rafId);
    frame();
  }

  // ============================================================================
  // Piano-roll sequencer
  // ============================================================================

  // Each "piano board" is an independent pattern with its own notes / steps /
  // bpm. Only the active board is shown, edited, and played.
  let boardSeq = 1;
  function makeBoard(name) {
    return {
      id: boardSeq++,
      name: name || ('Board ' + boardSeq),
      notes: new Map(),   // 'step:midi' -> { voice, len }
      steps: 16,
      bpm: 110,
      arrange: [[]],      // this board's OWN arrangement: array of lanes of clips
    };
  }

  const BOARDS = [makeBoard('Board 1')];
  let activeBoardId = BOARDS[0].id;
  const activeBoard = () => BOARDS.find((b) => b.id === activeBoardId) || BOARDS[0];

  const SEQ = {
    low: 36,            // C2
    high: 72,           // C5
    perBeat: 4,         // 16th-note grid
    playing: false,
    currentStep: 0,
    nextTime: 0,
    playStart: 0,
    timer: null,
    // per-board fields proxy to the active board so existing code is unchanged
    get notes() { return activeBoard().notes; },
    get steps() { return activeBoard().steps; },
    set steps(v) { activeBoard().steps = v; },
    get bpm() { return activeBoard().bpm; },
    set bpm(v) { activeBoard().bpm = v; },
  };

  const BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  const isBlack = (m) => BLACK[((m % 12) + 12) % 12];
  const stepDur = () => 60 / SEQ.bpm / SEQ.perBeat;

  function rollGeom(canvas) {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const gut = 36;
    const rows = SEQ.high - SEQ.low + 1;
    return {
      W, H, gut, rows,
      plotW: W - gut,
      stepW: (W - gut) / SEQ.steps,
      rowH: H / rows,
    };
  }

  function cellAt(canvas, clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const g = rollGeom(canvas);
    const x = clientX - r.left;
    const y = clientY - r.top;
    const midi = SEQ.high - Math.floor(y / g.rowH);
    const step = Math.floor((x - g.gut) / g.stepW);
    return { x, y, midi, step, inGutter: x < g.gut, inRange: midi >= SEQ.low && midi <= SEQ.high };
  }

  // Each entry: key 'step:midi' -> { voice, len } (len in steps, ≥1).
  function seqTriggerStep(step, when) {
    SEQ.notes.forEach((note, key) => {
      const colon = key.indexOf(':');
      if (parseInt(key.slice(0, colon), 10) !== step) return;
      const midi = parseInt(key.slice(colon + 1), 10);
      const def = VOICE_DEFS[note.voice];
      if (def.chord) {
        def.playLen(fxInput, when, midi, Math.max(note.len, 1) * stepDur());
      } else {
        def.play(fxInput, when, voiceParams[note.voice], midi);
      }
    });
  }

  function seqScheduler() {
    const ahead = 0.1;
    while (SEQ.nextTime < ctx.currentTime + ahead) {
      seqTriggerStep(SEQ.currentStep, SEQ.nextTime);
      SEQ.nextTime += stepDur();
      SEQ.currentStep = (SEQ.currentStep + 1) % SEQ.steps;
    }
  }

  function seqPlay() {
    resume();
    SEQ.playing = true;
    SEQ.currentStep = 0;
    SEQ.nextTime = ctx.currentTime + 0.06;
    SEQ.playStart = SEQ.nextTime;
    SEQ.timer = setInterval(seqScheduler, 25);
    updateSeqButton();
  }

  function seqStop() {
    SEQ.playing = false;
    if (SEQ.timer) { clearInterval(SEQ.timer); clearTimeout(SEQ.timer); SEQ.timer = null; }
    updateSeqButton();
  }

  function toggleSeq() {
    if (SEQ.playing) { seqStop(); return; }
    // The single transport plays the arrangement when clips exist, otherwise
    // the currently visible board.
    if (arrHasClips()) arrPlay();
    else seqPlay();
  }

  function updateSeqButton() {
    const b = $('btn-seq');
    b.textContent = SEQ.playing ? '■ Stop' : '▶ Play';
    b.classList.toggle('playing', SEQ.playing);
  }

  function setSteps(n) {
    SEQ.steps = n;
    SEQ.notes.forEach((note, key) => {
      const step = parseInt(key.slice(0, key.indexOf(':')), 10);
      if (step >= n) SEQ.notes.delete(key);
      else if (step + note.len > n) note.len = n - step;   // clamp overhang
    });
  }

  // ---- Piano boards (tabs) --------------------------------------------------

  // Push the active board's BPM/Steps into the transport sliders (no audio
  // side-effects beyond what those handlers already do).
  function syncBoardSliders() {
    const bpm = $('s-bpm'), steps = $('s-steps');
    if (bpm) { bpm.value = activeBoard().bpm; bpm.dispatchEvent(new Event('input')); }
    if (steps) { steps.value = activeBoard().steps; $('v-steps').textContent = activeBoard().steps; }
  }

  function switchBoard(id) {
    if (id === activeBoardId) return;
    if (SEQ.playing) seqStop();    // playback follows the visible board
    activeBoardId = id;
    syncBoardSliders();
    renderBoardTabs();
    // arrangement is per-board: show this board's own clips (or hide if none).
    // Show first so renderArrange can measure the panel width.
    refreshArrangeVisibility();
    renderArrange();
  }

  function addBoard() {
    const b = makeBoard('Board ' + (BOARDS.length + 1));
    BOARDS.push(b);
    switchBoard(b.id);
  }

  function deleteBoard(id) {
    if (BOARDS.length === 1) return;   // always keep at least one
    const i = BOARDS.findIndex((b) => b.id === id);
    if (i < 0) return;
    BOARDS.splice(i, 1);
    // drop clips referencing this board from EVERY board's arrangement
    BOARDS.forEach((bd) => bd.arrange.forEach((lane) => {
      for (let j = lane.length - 1; j >= 0; j--) {
        if (lane[j].boardId === id) lane.splice(j, 1);
      }
    }));
    if (activeBoardId === id) {
      if (SEQ.playing) seqStop();
      activeBoardId = BOARDS[Math.max(0, i - 1)].id;
      syncBoardSliders();
    }
    renderBoardTabs();
    renderArrange();
    refreshArrangeVisibility();
  }

  function renameBoard(id, name) {
    const b = BOARDS.find((x) => x.id === id);
    if (b) b.name = name.trim() || b.name;
  }

  function renderBoardTabs() {
    const host = $('board-tabs');
    if (!host) return;
    host.textContent = '';

    BOARDS.forEach((b) => {
      const tab = document.createElement('div');
      tab.className = 'board-tab' + (b.id === activeBoardId ? ' active' : '');
      tab.draggable = true;
      let tabDragged = false;
      // Switch on click, not mousedown, so dragging a tab onto the timeline
      // doesn't first switch to (and thus self-target) that board.
      tab.addEventListener('click', (e) => {
        if (tabDragged) { tabDragged = false; return; }
        if (e.target.classList.contains('board-tab-x')) return;
        if (e.target.classList.contains('board-tab-name') && !e.target.readOnly) return;
        switchBoard(b.id);
      });
      // Drag a tab onto the piano canvas to nest it as a clip in the arrangement.
      tab.addEventListener('dragstart', (e) => {
        tabDragged = true;
        e.dataTransfer.setData('text/board-id', String(b.id));
        e.dataTransfer.effectAllowed = 'copy';
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => tab.classList.remove('dragging'));

      const name = document.createElement('input');
      name.className = 'board-tab-name';
      name.value = b.name;
      name.readOnly = true;
      name.size = Math.max(b.name.length, 3);
      // double-click to rename
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        name.readOnly = false;
        name.focus();
        name.select();
      });
      const commit = () => {
        name.readOnly = true;
        renameBoard(b.id, name.value);
        name.value = BOARDS.find((x) => x.id === b.id).name;
        name.size = Math.max(name.value.length, 3);
      };
      name.addEventListener('blur', commit);
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
        if (e.key === 'Escape') { name.value = b.name; name.blur(); }
        e.stopPropagation();
      });
      tab.appendChild(name);

      if (BOARDS.length > 1) {
        const x = document.createElement('button');
        x.className = 'board-tab-x';
        x.textContent = '×';
        x.title = 'Delete board';
        x.addEventListener('click', (e) => { e.stopPropagation(); deleteBoard(b.id); });
        tab.appendChild(x);
      }

      host.appendChild(tab);
    });

    const add = document.createElement('button');
    add.className = 'board-add';
    add.textContent = '+';
    add.title = 'New board';
    add.addEventListener('click', addBoard);
    host.appendChild(add);
  }

  // ============================================================================
  // Arrangement timeline — nest boards as clips ("precomps") on layered lanes
  // ============================================================================
  //
  // Hidden until a board tab is dropped onto the piano canvas. Each clip points
  // at a note-board (flat — no clip references another arrangement) and plays
  // that board's whole pattern once. Clip width = pattern length in seconds.

  // Each board owns its arrangement (board.arrange). ARR.lanes proxies to the
  // active (host) board, so the timeline always shows that board's own clips.
  const ARR = {
    pxPerSec: 80,         // horizontal time scale
    clipSeq: 1,
    get lanes() { return activeBoard().arrange; },
    set lanes(v) { activeBoard().arrange = v; },
  };
  let arrDragClip = null;  // { clip, grabDX } while dragging a clip

  const boardById = (id) => BOARDS.find((b) => b.id === id);
  const boardStepDur = (b) => 60 / b.bpm / SEQ.perBeat;
  const boardLen = (b) => b ? b.steps * boardStepDur(b) : 0;  // pattern seconds
  const arrHasClips = () => ARR.lanes.some((l) => l.length);

  // Clip positions are stored as an integer STEP index on the host grid, so a
  // clip stays glued to its step when the host BPM changes (BPM only changes
  // pixels-per-step, not the step a clip lives on).
  const stepPxNow = () => boardStepDur(activeBoard()) * ARR.pxPerSec;  // px per step
  const pxToStep = (px) => {
    const sp = stepPxNow();
    return sp > 0 ? Math.max(0, Math.round(px / sp)) : 0;
  };
  const clipStartSec = (clip) => clip.startStep * boardStepDur(activeBoard());

  function showArrange(show) {
    $('arrange').hidden = !show;
  }

  // Show/hide the panel based on whether the visible board has any clips.
  function refreshArrangeVisibility() {
    showArrange(arrHasClips());
  }

  // `startPx` is the drop x in pixels within a lane; snap it to a step index.
  function addClip(boardId, laneIdx, startPx) {
    const lane = ARR.lanes[laneIdx] || ARR.lanes[0];
    lane.push({ id: ARR.clipSeq++, boardId, startStep: pxToStep(startPx) });
    showArrange(true);
    renderArrange();
  }

  function deleteClip(clip) {
    ARR.lanes.forEach((lane) => {
      const i = lane.indexOf(clip);
      if (i >= 0) lane.splice(i, 1);
    });
    renderArrange();
    refreshArrangeVisibility();
  }

  function addLane() { ARR.lanes.push([]); renderArrange(); }

  function clearArrange() {
    if (SEQ.playing) seqStop();
    ARR.lanes = [[]];
    renderArrange();
    showArrange(false);
  }

  function renderArrange() {
    const host = $('arrange-lanes');
    if (!host) return;
    host.textContent = '';

    // The host board's full bar fills the available lane width: derive the
    // time scale so `steps` columns span the whole component. Everything that
    // reads ARR.pxPerSec (clips, drops, playhead) stays in sync.
    const host_b = activeBoard();
    const barSec = boardLen(host_b);                     // host bar in seconds
    const avail = host.clientWidth - 24;                 // minus left/right padding
    ARR.pxPerSec = (barSec > 0 && avail > 0) ? avail / barSec : 80;

    const stepPx = boardStepDur(host_b) * ARR.pxPerSec;
    const beatPx = stepPx * SEQ.perBeat;
    const barPx = stepPx * host_b.steps;                 // == avail, fills width
    const gridBg = stepPx > 1
      ? `repeating-linear-gradient(to right,
           rgba(255,255,255,0.10) 0 1px, transparent 1px ${beatPx}px),
         repeating-linear-gradient(to right,
           rgba(255,255,255,0.04) 0 1px, transparent 1px ${stepPx}px)`
      : 'none';

    ARR.lanes.forEach((lane, laneIdx) => {
      const laneEl = document.createElement('div');
      laneEl.className = 'arrange-lane';
      laneEl.dataset.lane = laneIdx;
      laneEl.style.backgroundImage = gridBg;
      // draw the grid across the host's bar (now == available width)
      laneEl.style.backgroundRepeat = 'no-repeat';
      laneEl.style.backgroundSize = barPx > 0 ? (barPx + 'px 100%') : 'auto';

      // drop targets (tab→clip and clip move)
      laneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        laneEl.classList.add('drop-target');
      });
      laneEl.addEventListener('dragleave', () => laneEl.classList.remove('drop-target'));
      laneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        laneEl.classList.remove('drop-target');
        const rect = laneEl.getBoundingClientRect();
        const dropX = e.clientX - rect.left;
        const boardId = parseInt(e.dataTransfer.getData('text/board-id'), 10);
        if (boardId && boardId !== activeBoardId) addClip(boardId, laneIdx, dropX);
      });

      lane.forEach((clip) => {
        const b = boardById(clip.boardId);
        if (!b) return;
        const el = document.createElement('div');
        el.className = 'arrange-clip';
        el.style.left = (clip.startStep * stepPxNow()) + 'px';
        el.style.width = Math.max(boardLen(b) * ARR.pxPerSec, 28) + 'px';
        el.style.background = '#c5a8ff';
        el.title = b.name + ' — ' + boardLen(b).toFixed(1) + 's';

        const label = document.createElement('span');
        label.textContent = b.name;
        el.appendChild(label);

        const x = document.createElement('button');
        x.className = 'arrange-clip-x';
        x.textContent = '×';
        x.addEventListener('mousedown', (e) => e.stopPropagation());
        x.addEventListener('click', (e) => { e.stopPropagation(); deleteClip(clip); });
        el.appendChild(x);

        // drag clip to move (time + lane) — mouse based for precision
        el.addEventListener('mousedown', (e) => {
          if (e.target === x) return;
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          arrDragClip = { clip, grabDX: e.clientX - rect.left };
          el.classList.add('dragging');
          window.addEventListener('mousemove', arrClipMove);
          window.addEventListener('mouseup', arrClipUp);
        });

        laneEl.appendChild(el);
      });

      host.appendChild(laneEl);
    });
  }

  function arrClipMove(e) {
    if (!arrDragClip) return;
    const host = $('arrange-lanes');
    const lanesEls = Array.from(host.querySelectorAll('.arrange-lane'));
    // which lane is the cursor over?
    let targetLane = -1;
    lanesEls.forEach((le, i) => {
      const r = le.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) targetLane = i;
    });
    const clip = arrDragClip.clip;

    // new start from cursor x within whichever lane row, snapped to a step
    const ref = lanesEls[Math.max(0, targetLane)] || lanesEls[0];
    if (ref) {
      const r = ref.getBoundingClientRect();
      clip.startStep = pxToStep(e.clientX - r.left - arrDragClip.grabDX);
    }

    // move between lanes if changed
    if (targetLane >= 0) {
      const cur = ARR.lanes.findIndex((l) => l.indexOf(clip) >= 0);
      if (cur !== targetLane) {
        ARR.lanes[cur].splice(ARR.lanes[cur].indexOf(clip), 1);
        ARR.lanes[targetLane].push(clip);
      }
    }
    renderArrange();
  }

  function arrClipUp() {
    arrDragClip = null;
    window.removeEventListener('mousemove', arrClipMove);
    window.removeEventListener('mouseup', arrClipUp);
    renderArrange();
  }

  // ---- Roll-frame drop zone (tab → canvas creates first clip) ---------------

  function initRollDropZone() {
    const frame = $('roll-frame');
    frame.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/board-id')) return;
      e.preventDefault();
      frame.classList.add('drop-active');
    });
    frame.addEventListener('dragleave', (e) => {
      if (!frame.contains(e.relatedTarget)) frame.classList.remove('drop-active');
    });
    frame.addEventListener('drop', (e) => {
      e.preventDefault();
      frame.classList.remove('drop-active');
      const boardId = parseInt(e.dataTransfer.getData('text/board-id'), 10);
      if (!boardId || boardId === activeBoardId) return;  // no self-nesting
      showArrange(true);
      // place at start of the first lane
      addClip(boardId, 0, 0);
    });
  }

  // ============================================================================
  // Arrangement playback
  // ============================================================================

  // Fire one note (point or sustained chord) of a given board at absolute time.
  function fireBoardNote(board, note, midi, when) {
    const def = VOICE_DEFS[note.voice];
    if (def.chord) def.playLen(fxInput, when, midi, Math.max(note.len, 1) * boardStepDur(board));
    else def.play(fxInput, when, voiceParams[note.voice], midi);
  }

  // Schedule a single playthrough of `board` starting at absolute time `at`.
  function scheduleBoard(board, at) {
    const sd = boardStepDur(board);
    board.notes.forEach((note, key) => {
      const colon = key.indexOf(':');
      const step = parseInt(key.slice(0, colon), 10);
      const midi = parseInt(key.slice(colon + 1), 10);
      if (step >= board.steps) return;
      fireBoardNote(board, note, midi, at + step * sd);
    });
  }

  // Total arrangement length in seconds, rounded up to a whole host step so the
  // loop wraps cleanly on the grid.
  function arrLength() {
    const host_b = activeBoard();
    let end = boardLen(host_b);   // the host board's own pattern is a layer too
    ARR.lanes.forEach((lane) => lane.forEach((clip) => {
      const b = boardById(clip.boardId);
      if (b) end = Math.max(end, clipStartSec(clip) + boardLen(b));
    }));
    const sd = boardStepDur(host_b);
    if (sd > 0 && end > 0) end = Math.ceil(end / sd - 1e-6) * sd;
    return end;
  }

  // Schedule one playthrough of the whole arrangement starting at absolute `at`.
  // The viewed (host) board's own notes play as a layer alongside its clips.
  function arrScheduleCycle(at) {
    scheduleBoard(activeBoard(), at);
    ARR.lanes.forEach((lane) => lane.forEach((clip) => {
      const b = boardById(clip.boardId);
      if (b) scheduleBoard(b, at + clipStartSec(clip));
    }));
  }

  function arrPlay() {
    resume();
    SEQ.playing = true;
    const t0 = ctx.currentTime + 0.08;
    SEQ.playStart = t0;            // anchor of the very first cycle (for playhead)
    SEQ.arrLoopLen = Math.max(arrLength(), 0.25);
    let cycleAt = t0;

    arrScheduleCycle(cycleAt);

    // Re-arm each cycle so the viewed board's arrangement keeps looping.
    const tick = () => {
      if (!SEQ.playing) return;
      cycleAt += SEQ.arrLoopLen;
      arrScheduleCycle(cycleAt);
    };
    SEQ.timer = setInterval(tick, SEQ.arrLoopLen * 1000);
    updateSeqButton();
    arrAnimate();
  }

  let arrRaf = null;
  function arrAnimate() {
    if (arrRaf) cancelAnimationFrame(arrRaf);
    const host = $('arrange-lanes');
    function frame() {
      // draw a single playhead element across lanes
      let ph = host.querySelector('.arrange-playhead');
      if (SEQ.playing && ctx) {
        // wrap the playhead to the loop length so it restarts each cycle
        const elapsed = ctx.currentTime - SEQ.playStart;
        if (elapsed >= 0) {
          const loop = SEQ.arrLoopLen || 1;
          const pos = elapsed % loop;
          if (!ph) { ph = document.createElement('div'); ph.className = 'arrange-playhead'; host.appendChild(ph); }
          ph.style.left = (pos * ARR.pxPerSec + 12) + 'px';   // +12 ~ lane left padding
        }
        arrRaf = requestAnimationFrame(frame);
      } else if (ph) {
        ph.remove();
      }
    }
    frame();
  }

  // ---- Roll mouse interaction ----------------------------------------------
  //
  // Tap an empty cell to add a 1-step note; tap an existing note to remove it.
  // Drag sideways from a note to set its length (sustained chords hold for that
  // span). Gutter clicks audition the pitch.

  let drag = null;   // { key, anchorStep, midi, moved }

  // Find the note whose span covers (step, midi), returning its anchor key.
  function noteCovering(step, midi) {
    for (const [key, note] of SEQ.notes) {
      const colon = key.indexOf(':');
      const s = parseInt(key.slice(0, colon), 10);
      const m = parseInt(key.slice(colon + 1), 10);
      if (m === midi && step >= s && step < s + note.len) return key;
    }
    return null;
  }

  function auditionVoice(voice, midi) {
    resume();
    const def = VOICE_DEFS[voice];
    if (def.chord) def.playLen(fxInput, ctx.currentTime + 0.001, midi, Math.max(state.attack + 0.2, 0.3));
    else def.play(fxInput, ctx.currentTime + 0.001, voiceParams[voice], midi);
  }

  function rollDown(e) {
    const canvas = $('roll');
    const c = cellAt(canvas, e.clientX, e.clientY);
    const voice = state.selectedVoice || PALETTE[0];

    if (c.inGutter && c.inRange) { auditionVoice(voice, c.midi); return; }
    if (!c.inRange || c.step < 0 || c.step >= SEQ.steps) return;

    const existing = noteCovering(c.step, c.midi);
    if (existing) {
      // Begin resizing this note; a release with no drag deletes it.
      const anchorStep = parseInt(existing.slice(0, existing.indexOf(':')), 10);
      drag = { key: existing, anchorStep, midi: c.midi, moved: false, wasExisting: true };
    } else {
      const key = c.step + ':' + c.midi;
      SEQ.notes.set(key, { voice, len: 1 });
      drag = { key, anchorStep: c.step, midi: c.midi, moved: false, wasExisting: false };
      auditionVoice(voice, c.midi);
    }
    window.addEventListener('mousemove', rollMove);
    window.addEventListener('mouseup', rollUp);
  }

  function rollMove(e) {
    if (!drag) return;
    const canvas = $('roll');
    const c = cellAt(canvas, e.clientX, e.clientY);
    if (c.step < 0 || c.step >= SEQ.steps) return;
    const len = Math.max(1, c.step - drag.anchorStep + 1);
    const note = SEQ.notes.get(drag.key);
    if (note && note.len !== len) { note.len = len; drag.moved = true; }
  }

  function rollUp() {
    // Tap (no drag) on an existing note removes it.
    if (drag && !drag.moved && drag.wasExisting) {
      SEQ.notes.delete(drag.key);
    }
    drag = null;
    window.removeEventListener('mousemove', rollMove);
    window.removeEventListener('mouseup', rollUp);
  }

  // ---- Roll drawing ---------------------------------------------------------

  function drawRoll() {
    const canvas = $('roll');

    function frame() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
      }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const geo = rollGeom(canvas);

      // pitch lanes
      for (let m = SEQ.low; m <= SEQ.high; m++) {
        const y = (SEQ.high - m) * geo.rowH;
        if (isBlack(m)) {
          g.fillStyle = 'rgba(255,255,255,0.035)';
          g.fillRect(geo.gut, y, geo.plotW, geo.rowH);
        }
        g.strokeStyle = (m % 12 === 0) ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(geo.gut, y); g.lineTo(W, y); g.stroke();
        if (m % 12 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.45)';
          g.font = "9px 'Suisse Intl Mono', monospace";
          g.fillText(noteName(m), 4, y + geo.rowH - 2);
        }
      }

      // step columns
      for (let s = 0; s <= SEQ.steps; s++) {
        const x = geo.gut + s * geo.stepW;
        g.strokeStyle = (s % SEQ.perBeat === 0) ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }

      // notes (length spans multiple step columns)
      SEQ.notes.forEach((note, key) => {
        const colon = key.indexOf(':');
        const step = parseInt(key.slice(0, colon), 10);
        const midi = parseInt(key.slice(colon + 1), 10);
        if (step >= SEQ.steps || midi < SEQ.low || midi > SEQ.high) return;
        const len = Math.min(Math.max(note.len, 1), SEQ.steps - step);
        const x = geo.gut + step * geo.stepW;
        const y = (SEQ.high - midi) * geo.rowH;
        g.fillStyle = VOICE_COLORS[note.voice] || '#ffffff';
        const r = 2;
        const w = geo.stepW * len - 2, hh = geo.rowH - 2;
        g.beginPath();
        g.roundRect ? g.roundRect(x + 1, y + 1, w, hh, r) : g.rect(x + 1, y + 1, w, hh);
        g.fill();
        // segment ticks for multi-step notes
        if (len > 1) {
          g.strokeStyle = 'rgba(0,0,0,0.25)';
          g.lineWidth = 1;
          for (let s = 1; s < len; s++) {
            const sx = x + s * geo.stepW;
            g.beginPath(); g.moveTo(sx, y + 1); g.lineTo(sx, y + hh); g.stroke();
          }
        }
      });

      // playhead
      if (SEQ.playing && ctx) {
        const elapsed = ctx.currentTime - SEQ.playStart;
        let pos = (elapsed / stepDur()) % SEQ.steps;
        if (pos < 0) pos += SEQ.steps;
        const x = geo.gut + pos * geo.stepW;
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }

      requestAnimationFrame(frame);
    }
    frame();
  }

  // ---- Init ----------------------------------------------------------------

  function init() {
    buildControls();

    bindSlider('s-octave', 'v-octave', (n) => {
      state.octave = n;
      if (noiseSource) rebuildFilters();
      if (state.droneOn) chordOn();
      updateReadout();
    });
    bindSlider('s-q', 'v-q', (n) => { state.q = n; applyLiveParams(); });
    bindSlider('s-gain', 'v-gain', (n) => { state.gain = n; applyLiveParams(); }, (n) => n + 'dB');
    bindSlider('s-noise', 'v-noise', (n) => { state.noise = n / 100; applyLiveParams(); });
    bindSlider('s-vol', 'v-vol', (n) => { state.volume = n / 100; applyLiveParams(); });
    bindSlider('s-attack', 'v-attack', (n) => { state.attack = n / 1000; }, (n) => n + 'ms');
    bindSlider('s-release', 'v-release', (n) => { state.release = n / 1000; }, (n) => n + 'ms');
    bindSlider('s-strum', 'v-strum', (n) => { state.strum = n / 1000; }, (n) => n + 'ms');

    bindSlider('s-drive', 'v-drive', (n) => { state.drive = n; applyFX(); });
    bindSlider('s-tone', 'v-tone', (n) => { state.tone = n; applyFX(); },
               (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : n));
    bindSlider('s-delay', 'v-delay', (n) => { state.delay = n; applyFX(); });
    bindSlider('s-space', 'v-space', (n) => { state.space = n; applyFX(); });

    $('btn-play').addEventListener('click', toggleDrone);
    $('btn-strike').addEventListener('click', strike);
    $('btn-record').addEventListener('click', toggleRecord);

    // sequencer transport
    $('btn-seq').addEventListener('click', toggleSeq);
    $('btn-clear').addEventListener('click', () => SEQ.notes.clear());
    bindSlider('s-bpm', 'v-bpm', (n) => { SEQ.bpm = n; if (!$('arrange').hidden) renderArrange(); });
    bindSlider('s-steps', 'v-steps', (n) => { setSteps(n); if (!$('arrange').hidden) renderArrange(); });
    $('roll').addEventListener('mousedown', rollDown);

    // piano boards (tabs)
    renderBoardTabs();
    syncBoardSliders();

    // arrangement (drag a tab onto the canvas to reveal it)
    initRollDropZone();
    $('btn-arr-lane').addEventListener('click', addLane);
    $('btn-arr-clear').addEventListener('click', clearArrange);
    renderArrange();
    window.addEventListener('resize', () => { if (!$('arrange').hidden) renderArrange(); });

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    selectVoice(PALETTE[0]);
    updateReadout();
    drawScope();
    drawRoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
