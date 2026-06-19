/* =============================================================================
   HTY Sound Design — noise → resonant chord generator
   --------------------------------------------------------------------------
   White noise contains every frequency. A bank of narrow band-pass
   resonators (one per chord note) lets the noise ring out at those pitches,
   so a chord emerges from the hiss. Higher "Tightness" (Q) = purer tone.

   Two modes:
     · Bandpass — only the resonators are heard → clean, pitched chord.
     · EQ Peaks — a bleed of the raw noise rides under the resonant peaks,
       so the pitches read as boosted bands sitting on a noise floor.

   Graph (parallel, so each note has its own envelope):
     noise ─┬─ bandpass[i] ─ noteGain[i] ─┐
            │                              ├─ resoBus ─┐
            └─ dryGain ───────────────────────────────┴─ master ─ limiter ─┬─ analyser ─ out
                                                                            └─ recorder tap
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

  // Computer-keyboard → semitone offset (classic tracker layout).
  const KEY_SEMITONE = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5,
    t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
  };

  // Bandpass stages cascaded per note. One biquad rolls off only 12 dB/oct, so
  // a single filter leaks broadband noise even at huge Q. Stacking N of them
  // multiplies the skirt steepness (≈ N·12 dB/oct) so off-pitch noise is killed
  // while the centre pitch stays at unity.
  const STAGES = 3;

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const dbToLin = (db) => Math.pow(10, db / 20);

  // ---- State ---------------------------------------------------------------

  const state = {
    root: 0,
    octave: 3,
    octaveShift: 0,   // transient shift from keyboard (e.g. 'k' = +1)
    chord: 'Major',
    mode: 'Bandpass',
    q: 80,
    gain: 6,          // peak level in dB
    noise: 0.35,      // raw white-noise bleed (EQ Peaks mode)
    volume: 0.7,
    attack: 0.04,     // seconds
    release: 0.6,     // seconds
    strum: 0,         // seconds between notes
    droneOn: false,
  };

  // ---- Web Audio graph -----------------------------------------------------

  let ctx = null;
  let noiseSource = null;
  let notes = [];        // [{ filter, gain, freq, name, midi }]
  let resoBus = null;
  let dryGain = null;
  let masterGain = null;
  let limiter = null;
  let analyser = null;
  let freqData = null;

  // recording
  let recNode = null;
  let recSink = null;
  let recChunks = [];
  let recording = false;

  function createNoiseBuffer() {
    const len = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    resoBus = ctx.createGain();
    dryGain = ctx.createGain();
    dryGain.gain.value = 0;

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

    resoBus.connect(masterGain);
    dryGain.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function ensureNoise() {
    ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (noiseSource) return;
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = createNoiseBuffer();
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

  // Make-up gain. The cascade of narrow bands passes very little noise energy,
  // so the centre tone needs a big boost; normalised so default Q/peak land
  // near unity and the limiter catches the rest.
  function resoLevel() {
    return dbToLin(state.gain) * Math.sqrt(state.q / 80) * STAGES;
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
      gain.gain.value = 0; // silent until an envelope triggers

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
    notes.forEach((n) => {
      n.filters.forEach((f) => f.Q.setTargetAtTime(state.q, t, 0.02));
    });
    resoBus.gain.setTargetAtTime(resoLevel(), t, 0.02);
    dryGain.gain.setTargetAtTime(state.mode === 'EQ Peaks' ? state.noise : 0, t, 0.02);
    masterGain.gain.setTargetAtTime(state.volume, t, 0.02);
  }

  // ---- Envelope gestures ---------------------------------------------------

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

  // Sustained chord — attack in, hold.
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

  // Pluck — attack then immediate release (one-shot), staggered as a strum.
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
      updatePlayButton();
    } else {
      state.droneOn = true;
      chordOn();
      updatePlayButton();
      drawScope();
    }
  }

  // ---- Recording (WAV via ScriptProcessor tap) -----------------------------

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
    recChunks = [];
    recNode = null;
    recSink = null;
    updateRecordButton();
    downloadBlob(wav, 'noise-chord-' + Date.now() + '.wav');
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
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // mono
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
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- UI ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

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

  function buildControls() {
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

  // ---- Keyboard playing ----------------------------------------------------

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

    chordOn(); // ensures noise, rebuilds, attacks (sustained while held)
    updateReadout();
    drawScope();
  }

  function onKeyUp(e) {
    const k = e.key.toLowerCase();
    if (!(k in KEY_SEMITONE)) return;
    heldKeys.delete(k);
    if (state.droneOn) return;       // drone keeps sounding
    if (heldKeys.size === 0) {
      chordOff();
      // let the release finish, then free the noise source
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
      const minF = 20, maxF = 12000;
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

      const defs = chordNotes();
      g.font = "10px 'Suisse Intl Mono', monospace";
      defs.forEach((n) => {
        if (n.freq < minF || n.freq > maxF) return;
        const x = ((Math.log10(n.freq) - logMin) / (logMax - logMin)) * w;
        g.strokeStyle = 'rgba(255,255,255,0.16)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.fillText(n.name, x + 4, 14);
      });

      rafId = requestAnimationFrame(frame);
    }

    if (rafId) cancelAnimationFrame(rafId);
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

    $('btn-play').addEventListener('click', toggleDrone);
    $('btn-strike').addEventListener('click', strike);
    $('btn-record').addEventListener('click', toggleRecord);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    updateReadout();
    drawScope();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
