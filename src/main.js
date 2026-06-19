/* =============================================================================
   HTY Sound Design — resonant noise-chord synth
   --------------------------------------------------------------------------
   Chord resonator — white noise through a bank of cascaded band-pass
   resonators tuned to a chord. Played as a drone (Space / keyboard A–K),
   struck, or placed as sustained "Chord" voices on the piano roll, which are
   in turn arranged on the per-board arrangement timeline.

   Built to be stripped back and extended: VOICE_DEFS currently holds just the
   Chord voice; the palette structure remains for adding custom voices later.

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

  // Resonator mode is locked to Bandpass (the Mode selector was removed).
  // Stripped back to the noise-chord engine. The palette keeps its structure
  // (one voice for now) so custom voices can be added later.
  const PALETTE = ['Chord'];
  const VOICE_COLORS = {
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
    // chord fx (per-chord-voice)
    drive: 0,
    tone: 18000,
    delay: 0,
    space: 0,
    // timeline fx (master bus)
    tDrive: 0,
    tTone: 18000,
    tDelay: 0,
    tSpace: 0,
    droneOn: false,
    selectedVoice: null,
    editingKey: null,    // 'step:midi' of the placed chord being edited, or null
    syncing: false,      // true while pushing a snapshot into the sidebar UI
  };

  // ---- Web Audio nodes -----------------------------------------------------

  let ctx = null;
  let noiseBuf = null;       // shared white-noise buffer (one-shots)
  let noiseSource = null;    // looping drone source
  let notes = [];
  let resoBus = null;
  let dryGain = null;

  // Two FX stages: chordFX colors the placed chords only; timelineFX is a
  // master bus stage the whole mix passes through (so future voices get it too).
  //   chords → fxInput(chordFX) → chordFX.out → masterSum(timelineFX) →
  //            timelineFX.out → masterGain → limiter → analyser → out
  let fxInput = null;        // == chordFX.input (voices connect here)
  let chordFX = null;
  let masterSum = null;      // == timelineFX.input
  let timelineFX = null;
  let masterGain = null;
  let limiter = null;
  let analyser = null;
  let freqData = null;

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

  // Build one FX stage: input → drive → tone → [dry | delay | reverb] → output.
  // Returns nodes + an apply(params) that reads {drive,tone,delay,space}.
  function makeFXChain() {
    const input = ctx.createGain();
    const drive = ctx.createWaveShaper();
    drive.curve = makeDriveCurve(0);
    drive.oversample = '2x';
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 18000;
    tone.Q.value = 0.7;

    const dryNode = ctx.createGain();
    dryNode.gain.value = 1;

    const delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.16;
    const delayFb = ctx.createGain();
    delayFb.gain.value = 0;
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0;

    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(1.8, 2.6);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0;

    const output = ctx.createGain();

    input.connect(drive);
    drive.connect(tone);
    tone.connect(dryNode); dryNode.connect(output);
    tone.connect(delaySend);
    delaySend.connect(delayNode);
    delayNode.connect(delayFb);
    delayFb.connect(delayNode);      // feedback loop
    delayNode.connect(output);
    tone.connect(reverbSend);
    reverbSend.connect(convolver);
    convolver.connect(output);

    function apply(p) {
      const t = ctx.currentTime;
      drive.curve = makeDriveCurve(p.drive);
      tone.frequency.setTargetAtTime(p.tone, t, 0.02);
      delaySend.gain.setTargetAtTime((p.delay / 100) * 0.5, t, 0.02);
      delayFb.gain.setTargetAtTime((p.delay / 100) * 0.55, t, 0.02);
      reverbSend.gain.setTargetAtTime((p.space / 100) * 0.7, t, 0.02);
    }

    return { input, output, apply };
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = makeNoiseBuffer(2);

    // chord buses
    resoBus = ctx.createGain();
    dryGain = ctx.createGain();
    dryGain.gain.value = 0;

    // two FX stages in series
    chordFX = makeFXChain();
    timelineFX = makeFXChain();
    fxInput = chordFX.input;          // voices play into the chord FX
    masterSum = timelineFX.input;     // whole mix sums into the timeline FX

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

    // wiring
    resoBus.connect(fxInput);
    dryGain.connect(fxInput);
    chordFX.output.connect(masterSum);
    timelineFX.output.connect(masterGain);
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
    chordFX.apply({ drive: state.drive, tone: state.tone, delay: state.delay, space: state.space });
    timelineFX.apply({ drive: state.tDrive, tone: state.tTone, delay: state.tDelay, space: state.tSpace });
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

  // The per-chord sound-design settings (everything on the Palette tab incl.
  // Chord FX). A placed chord freezes these so later slider changes don't alter
  // it. SNAP_KEYS are copied straight from `state`.
  const SNAP_KEYS = [
    'chord', 'q', 'gain', 'noise', 'volume', 'attack', 'release', 'strum',
    'drive', 'tone', 'delay', 'space',
  ];
  function chordSnapshot() {
    const s = {};
    SNAP_KEYS.forEach((k) => { s[k] = state[k]; });
    return s;
  }
  const snapResoLevel = (p) => dbToLin(p.gain) * Math.sqrt(p.q / 80) * STAGES;

  // Self-contained sustained chord. Spins up its own noise source, filter bank,
  // AND its own Chord-FX chain so the settings captured at placement time are
  // frozen. `snap` is a chordSnapshot(); when omitted, the live `state` is used
  // (e.g. auditioning the "next" chord). The chord routes through its frozen
  // Chord FX, then into `dest` (the master/timeline-FX bus).
  function playChordVoice(dest, t, rootMidi, lenSec, snap) {
    if (!ctx) return;
    const p = snap || chordSnapshot();
    const intervals = CHORDS[p.chord] || CHORDS.Major;
    const level = snapResoLevel(p);
    const atk = p.attack;
    const rel = p.release;
    const hold = Math.max(lenSec, 0.02);
    const tEnd = t + atk + hold + rel;

    // Per-chord Chord-FX chain (frozen), feeding the timeline-FX bus.
    const fx = makeFXChain();
    fx.apply({ drive: p.drive, tone: p.tone, delay: p.delay, space: p.space });
    fx.output.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    const bus = ctx.createGain();          // shared envelope for the whole chord
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(level, t + atk);
    bus.gain.setValueAtTime(level, t + atk + hold);
    bus.gain.linearRampToValueAtTime(0.0001, tEnd);
    bus.connect(fx.input);

    intervals.forEach((iv, i) => {
      const freq = midiToFreq(rootMidi + iv);
      let node = src;
      for (let s = 0; s < STAGES; s++) {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = freq;
        f.Q.value = p.q;
        node.connect(f);
        node = f;
      }
      // optional strum: stagger note entries within the chord's own sub-gain
      if (p.strum > 0) {
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(1, t + i * p.strum + 0.001);
        node.connect(ng);
        ng.connect(bus);
      } else {
        node.connect(bus);
      }
    });

    src.start(t);
    src.stop(tEnd + 0.05);
    // Tear down the per-chord FX chain a bit after the tail (delay/reverb) ends.
    const tail = tEnd + 2.5;
    setTimeout(() => { try { fx.output.disconnect(); } catch (e) {} },
               Math.max((tail - ctx.currentTime) * 1000, 100));
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

  // Live drone, toggled by the Space key (A–K play roots). No button anymore.
  function toggleDrone() {
    if (state.droneOn) {
      state.droneOn = false;
      chordOff();
    } else {
      state.droneOn = true;
      chordOn();
    }
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

  // ---- Voice definitions: params + synthesis -------------------------------
  // Each voice exposes play(dest, t, p, midi). The roll/arrangement place these.

  const VOICE_DEFS = {
    // The resonant noise chord as a placeable voice. It has no params of its
    // own — its sound is the live Resonator / Shape / FX sidebar settings, and
    // its chord type comes from the sidebar Chord selection. The row it sits on
    // is the chord ROOT. It sustains for its block length (handled separately
    // via playLen); a bare play() is a short audition strike.
    Chord: {
      chord: true,
      params: [],
      // dest is the master/timeline-FX bus; `snap` is the note's frozen
      // settings (omit to use live state, e.g. auditioning the next chord).
      play(dest, t, p, midi, snap) {
        const root = midi != null ? midi : baseMidi();
        const atk = (snap || state).attack;
        playChordVoice(dest, t, root, Math.max(atk + 0.12, 0.18), snap);
      },
      playLen(dest, t, midi, lenSec, snap) {
        playChordVoice(dest, t, midi != null ? midi : baseMidi(), lenSec, snap);
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
    const def = VOICE_DEFS[name];
    const dest = def.chord ? masterSum : fxInput;
    def.play(dest, ctx.currentTime + 0.001, voiceParams[name]);
    flashPad(name);
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
    // The per-voice panel was removed from the sidebar (single Chord voice with
    // no own params). Bail if the host elements aren't present.
    const host = $('voice-params');
    if (!host) return;
    const label = $('voice-label');
    if (label) label.textContent = 'Voice — ' + name;
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

    // Root note + Mode are no longer in the sidebar: roots come from the piano
    // board (per note) or the A–K keys; mode is locked to Bandpass.
    // Chord type is a dropdown (too many to show as chips).
    const sel = $('chord-select');
    Object.keys(CHORDS).sort((a, b) => a.localeCompare(b)).forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = state.chord;
    sel.addEventListener('change', () => {
      state.chord = sel.value;
      if (noiseSource) rebuildFilters();
      if (state.droneOn) chordOn();
      updateReadout();
      mirrorToEditing();
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

  // Each entry: key 'step:midi' -> { voice, len, fx } (len in steps, ≥1;
  // fx = frozen chord settings captured when placed).
  function seqTriggerStep(step, when) {
    SEQ.notes.forEach((note, key) => {
      const colon = key.indexOf(':');
      if (parseInt(key.slice(0, colon), 10) !== step) return;
      const midi = parseInt(key.slice(colon + 1), 10);
      const def = VOICE_DEFS[note.voice];
      if (def.chord) {
        def.playLen(masterSum, when, midi, Math.max(note.len, 1) * stepDur(), note.fx);
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
    state.editingKey = null;       // selection doesn't carry across boards
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
      state.editingKey = null;
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
  // `loopEnd` (absolute) cuts the sound off at the loop boundary.
  function fireBoardNote(board, note, midi, when, loopEnd) {
    const def = VOICE_DEFS[note.voice];
    if (def.chord) {
      let len = Math.max(note.len, 1) * boardStepDur(board);
      if (loopEnd != null) len = Math.min(len, loopEnd - when);   // clamp sustain
      if (len > 0.001) def.playLen(masterSum, when, midi, len, note.fx);
    } else {
      def.play(fxInput, when, voiceParams[note.voice], midi);
    }
  }

  // Schedule a single playthrough of `board` starting at absolute time `at`.
  // Notes that would begin at/after `loopEnd` are dropped (cut off).
  function scheduleBoard(board, at, loopEnd) {
    const sd = boardStepDur(board);
    board.notes.forEach((note, key) => {
      const colon = key.indexOf(':');
      const step = parseInt(key.slice(0, colon), 10);
      const midi = parseInt(key.slice(colon + 1), 10);
      if (step >= board.steps) return;
      const when = at + step * sd;
      if (loopEnd != null && when >= loopEnd - 0.0005) return;     // past the bar
      fireBoardNote(board, note, midi, when, loopEnd);
    });
  }

  // One loop is exactly the viewed board's bar. Anything (clip or note) that
  // would sound past this is cut off when the loop wraps.
  function arrLength() {
    return boardLen(activeBoard());
  }

  // Schedule one playthrough of the whole arrangement starting at absolute `at`.
  // The viewed (host) board's own notes play as a layer alongside its clips.
  function arrScheduleCycle(at) {
    const loopEnd = at + arrLength();   // clips/notes are cut off at the bar
    scheduleBoard(activeBoard(), at, loopEnd);
    ARR.lanes.forEach((lane) => lane.forEach((clip) => {
      const b = boardById(clip.boardId);
      if (b) scheduleBoard(b, at + clipStartSec(clip), loopEnd);
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
  // Click empty cell  → add a 1-step note (not auto-selected).
  // Single click note → select it (loads its settings into the sidebar).
  // Double click note → delete it.
  // Drag the first/last step of a note → resize that side; drag the middle → move.
  // Gutter click      → audition the pitch.

  let drag = null;             // active drag descriptor (see rollDown)

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

  // Move/re-key a note to a new (startStep, midi), keeping its data. Returns the
  // new key (or the old one if the target is unchanged/occupied by another note).
  function moveNote(oldKey, newStart, newMidi) {
    newStart = Math.max(0, Math.min(newStart, SEQ.steps - 1));
    const newKey = newStart + ':' + newMidi;
    if (newKey === oldKey) return oldKey;
    const note = SEQ.notes.get(oldKey);
    if (!note) return oldKey;
    // don't clobber a different existing note
    if (SEQ.notes.has(newKey)) return oldKey;
    if (newStart + note.len > SEQ.steps) note.len = SEQ.steps - newStart;
    SEQ.notes.delete(oldKey);
    SEQ.notes.set(newKey, note);
    if (state.editingKey === oldKey) state.editingKey = newKey;
    return newKey;
  }

  // `snap` (optional) is a frozen chord settings object; omit for live state.
  function auditionVoice(voice, midi, snap) {
    resume();
    const def = VOICE_DEFS[voice];
    const atk = (snap || state).attack;
    if (def.chord) def.playLen(masterSum, ctx.currentTime + 0.001, midi, Math.max(atk + 0.2, 0.3), snap);
    else def.play(fxInput, ctx.currentTime + 0.001, voiceParams[voice], midi);
  }

  // ---- Per-chord settings: select + edit ------------------------------------

  // Push a snapshot's values into the Palette-tab sliders / chord select so the
  // sidebar shows the selected (or default) chord's frozen settings.
  function syncPaletteFromSnapshot(p) {
    state.syncing = true;
    const set = (id, v) => { const el = $(id); if (el) { el.value = v; el.dispatchEvent(new Event('input')); } };
    set('s-q', p.q);
    set('s-gain', p.gain);
    set('s-noise', Math.round(p.noise * 100));
    set('s-vol', Math.round(p.volume * 100));
    set('s-attack', Math.round(p.attack * 1000));
    set('s-release', Math.round(p.release * 1000));
    set('s-strum', Math.round(p.strum * 1000));
    set('s-drive', p.drive);
    set('s-tone', p.tone);
    set('s-delay', p.delay);
    set('s-space', p.space);
    const sel = $('chord-select');
    if (sel) { sel.value = p.chord; sel.dispatchEvent(new Event('change')); }
    state.syncing = false;
  }

  // Select a placed chord for editing: load its frozen settings into `state`
  // and reflect them in the sidebar. Sidebar edits then mirror back to it.
  function selectPlacedNote(key) {
    const note = SEQ.notes.get(key);
    if (!note || !note.fx) { state.editingKey = null; return; }
    state.editingKey = key;
    SNAP_KEYS.forEach((k) => { state[k] = note.fx[k]; });
    syncPaletteFromSnapshot(note.fx);
    applyLiveParams();
    applyFX();
    updateReadout();
  }

  // Mirror the current Palette-tab settings into the selected chord (so editing
  // a slider changes that placed chord, not future placements). No-op while
  // loading a snapshot, or when nothing is selected.
  function mirrorToEditing() {
    if (state.syncing || !state.editingKey) return;
    const note = SEQ.notes.get(state.editingKey);
    if (note) note.fx = chordSnapshot();
  }

  function rollDown(e) {
    const canvas = $('roll');
    const c = cellAt(canvas, e.clientX, e.clientY);
    const voice = state.selectedVoice || PALETTE[0];

    if (c.inGutter && c.inRange) { auditionVoice(voice, c.midi); return; }
    if (!c.inRange || c.step < 0 || c.step >= SEQ.steps) return;

    const existing = noteCovering(c.step, c.midi);
    if (existing) {
      const note = SEQ.notes.get(existing);
      const geo = rollGeom(canvas);
      const startStep = parseInt(existing.slice(0, existing.indexOf(':')), 10);
      const noteLeftPx = geo.gut + startStep * geo.stepW;
      const noteWidthPx = note.len * geo.stepW;
      const into = c.x - noteLeftPx;                  // px from the note's left edge
      // Resize zones = one step at each edge (the middle moves). For a 1-step
      // note there's no middle, so split it 50/50 between the two edges.
      let nearLeft, nearRight;
      if (note.len === 1) {
        nearLeft = into <= noteWidthPx / 2;
        nearRight = !nearLeft;
      } else {
        nearLeft = into <= geo.stepW;
        nearRight = into >= noteWidthPx - geo.stepW;
      }

      if (nearLeft && note.len >= 1) {
        drag = { mode: 'left', key: existing, midi: c.midi,
                 endStep: startStep + note.len - 1, moved: false };
      } else if (nearRight) {
        drag = { mode: 'right', key: existing, midi: c.midi,
                 anchorStep: startStep, moved: false };
      } else {
        // body grab → move; remember grab offset so the note doesn't jump
        drag = { mode: 'move', key: existing, grabStepOff: c.step - startStep,
                 moved: false };
      }
    } else {
      // New chord: freeze current Palette settings. NOT auto-selected, and
      // placing clears any prior selection so the sidebar edits "next" defaults.
      const key = c.step + ':' + c.midi;
      const note = { voice, len: 1, fx: chordSnapshot() };
      SEQ.notes.set(key, note);
      state.editingKey = null;
      drag = { mode: 'right', key, midi: c.midi, anchorStep: c.step, moved: false, isNew: true };
      auditionVoice(voice, c.midi, note.fx);
    }
    window.addEventListener('mousemove', rollMove);
    window.addEventListener('mouseup', rollUp);
  }

  function rollMove(e) {
    if (!drag) return;
    const canvas = $('roll');
    const c = cellAt(canvas, e.clientX, e.clientY);
    if (c.step < 0 || c.step >= SEQ.steps) return;

    if (drag.mode === 'left') {
      // Left edge follows cursor; end step fixed. Re-keys the note.
      const newStart = Math.min(c.step, drag.endStep);
      const oldStart = parseInt(drag.key.slice(0, drag.key.indexOf(':')), 10);
      if (newStart !== oldStart) {
        const note = SEQ.notes.get(drag.key);
        SEQ.notes.delete(drag.key);
        note.len = drag.endStep - newStart + 1;
        const newKey = newStart + ':' + drag.midi;
        SEQ.notes.set(newKey, note);
        if (state.editingKey === drag.key) state.editingKey = newKey;
        drag.key = newKey;
        drag.moved = true;
      }
    } else if (drag.mode === 'right') {
      const len = Math.max(1, c.step - drag.anchorStep + 1);
      const note = SEQ.notes.get(drag.key);
      if (note && note.len !== len) { note.len = len; drag.moved = true; }
    } else if (drag.mode === 'move') {
      if (!c.inRange) return;       // keep within the pitch range
      const newStart = c.step - drag.grabStepOff;
      const oldStart = parseInt(drag.key.slice(0, drag.key.indexOf(':')), 10);
      const oldMidi = parseInt(drag.key.slice(drag.key.indexOf(':') + 1), 10);
      if (newStart !== oldStart || c.midi !== oldMidi) {
        const newKey = moveNote(drag.key, newStart, c.midi);
        if (newKey !== drag.key) { drag.key = newKey; drag.moved = true; }
      }
    }
  }

  function rollUp() {
    // A click with no drag = SELECT the note (delete is on dblclick).
    if (drag && !drag.moved && !drag.isNew) {
      selectPlacedNote(drag.key);
    }
    drag = null;
    window.removeEventListener('mousemove', rollMove);
    window.removeEventListener('mouseup', rollUp);
  }

  // Double-click a note to delete it.
  function rollDblClick(e) {
    const canvas = $('roll');
    const c = cellAt(canvas, e.clientX, e.clientY);
    if (c.inGutter || !c.inRange) return;
    const key = noteCovering(c.step, c.midi);
    if (!key) return;
    SEQ.notes.delete(key);
    if (state.editingKey === key) state.editingKey = null;
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
        // outline the chord currently selected for editing
        if (key === state.editingKey) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          g.beginPath();
          g.roundRect ? g.roundRect(x + 1, y + 1, w, hh, r) : g.rect(x + 1, y + 1, w, hh);
          g.stroke();
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

    bindSlider('s-q', 'v-q', (n) => { state.q = n; applyLiveParams(); mirrorToEditing(); });
    bindSlider('s-gain', 'v-gain', (n) => { state.gain = n; applyLiveParams(); mirrorToEditing(); }, (n) => n + 'dB');
    bindSlider('s-noise', 'v-noise', (n) => { state.noise = n / 100; applyLiveParams(); mirrorToEditing(); });
    bindSlider('s-vol', 'v-vol', (n) => { state.volume = n / 100; applyLiveParams(); mirrorToEditing(); });
    bindSlider('s-attack', 'v-attack', (n) => { state.attack = n / 1000; mirrorToEditing(); }, (n) => n + 'ms');
    bindSlider('s-release', 'v-release', (n) => { state.release = n / 1000; mirrorToEditing(); }, (n) => n + 'ms');
    bindSlider('s-strum', 'v-strum', (n) => { state.strum = n / 1000; mirrorToEditing(); }, (n) => n + 'ms');

    const fHzShort = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : n);

    // Chord FX — per-chord-voice (frozen onto the chord when placed/edited)
    bindSlider('s-drive', 'v-drive', (n) => { state.drive = n; applyFX(); mirrorToEditing(); });
    bindSlider('s-tone', 'v-tone', (n) => { state.tone = n; applyFX(); mirrorToEditing(); }, fHzShort);
    bindSlider('s-delay', 'v-delay', (n) => { state.delay = n; applyFX(); mirrorToEditing(); });
    bindSlider('s-space', 'v-space', (n) => { state.space = n; applyFX(); mirrorToEditing(); });

    // Timeline FX — master bus
    bindSlider('s-tdrive', 'v-tdrive', (n) => { state.tDrive = n; applyFX(); });
    bindSlider('s-ttone', 'v-ttone', (n) => { state.tTone = n; applyFX(); }, fHzShort);
    bindSlider('s-tdelay', 'v-tdelay', (n) => { state.tDelay = n; applyFX(); });
    bindSlider('s-tspace', 'v-tspace', (n) => { state.tSpace = n; applyFX(); });

    // sidebar tabs (Chord | Timeline)
    $('side-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.side-tab');
      if (!tab) return;
      const which = tab.dataset.stab;
      document.querySelectorAll('.side-tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('stab-chord').hidden = which !== 'chord';
      $('stab-timeline').hidden = which !== 'timeline';
    });

    // sequencer transport
    $('btn-seq').addEventListener('click', toggleSeq);
    $('btn-clear').addEventListener('click', () => { SEQ.notes.clear(); state.editingKey = null; });
    bindSlider('s-bpm', 'v-bpm', (n) => { SEQ.bpm = n; if (!$('arrange').hidden) renderArrange(); });
    bindSlider('s-steps', 'v-steps', (n) => { setSteps(n); if (!$('arrange').hidden) renderArrange(); });
    $('roll').addEventListener('mousedown', rollDown);
    $('roll').addEventListener('dblclick', rollDblClick);

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
