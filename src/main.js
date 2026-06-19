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
  const PALETTE = ['Chord', 'Synth'];
  const VOICE_COLORS = {
    Chord:  '#c5a8ff',
    Synth:  '#7fe0d0',
  };
  const SY_WAVES = ['sine', 'triangle', 'square', 'sawtooth'];

  const KEY_SEMITONE = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5,
    t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
  };

  const STAGES = 3;

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const dbToLin = (db) => Math.pow(10, db / 20);

  // Shared slider value formatters (used by FX_DEFS params).
  const fHz = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : Math.round(n)) + 'Hz';
  const pct = (n) => n + '%';
  const gainDb = (n) => (n > 0 ? '+' : '') + n + 'dB';

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
    // FX racks — ordered lists of effect instances {id,type,enabled,params}.
    // chordRack is frozen onto each placed block; timelineRack is the master bus.
    chordRack: [],
    timelineRack: [],
    // synth voice (osc + noise blend)
    // defaults recreate the old "plop": sine, fast pitch drop, short AD
    syWave: 'sine',
    syDrop: 12,        // start this many semitones above, glide down to pitch
    syDropTime: 9,     // ms for the glide
    syNoise: 0,        // 0 = pure osc, 100 = pure noise
    syCutoff: 18000,   // lowpass on the blended osc+noise
    syAttack: 2,       // ms
    syDecay: 110,      // ms
    syRelease: 60,     // ms
    syLevel: 50,
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
  // Each is a modular rack rebuilt from state.chordRack / state.timelineRack.
  let fxInput = null;        // == chordFX.input (voices connect here)
  let chordFX = null;
  let masterSum = null;      // == timelineFX.input
  let timelineFX = null;
  let masterGain = null;
  let limiter = null;
  let analyser = null;
  let freqData = null;

  // True granular pitch-shifter as an AudioWorklet. A circular buffer is read
  // out at two overlapping positions advancing at the transposition ratio,
  // each Hann-windowed and crossfaded, so the result is genuinely transposed
  // (not the FM-ish artifact a swept DelayNode produces). Registered once per
  // context from a Blob URL so the whole effect stays inside this file.
  const PITCH_WORKLET_SRC = `
    class PitchShifter extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [{ name: 'ratio', defaultValue: 1, minValue: 0.2, maxValue: 4.2,
                  automationRate: 'k-rate' }];
      }
      constructor() {
        super();
        this.size = 8192;                  // circular buffer (~170ms @48k)
        this.buf = new Float32Array(this.size);
        this.writePos = 0;
        this.grainSize = 2048;
        // two grains offset by half a grain so their Hann windows overlap
        this.read = [-this.grainSize, -this.grainSize / 2];
        this.phase = [0, this.grainSize / 2];
      }
      process(inputs, outputs, params) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || !output.length) return true;
        const inCh = input && input.length ? input[0] : null;
        const n = output[0].length;
        const ratio = params.ratio[0];
        const gs = this.grainSize;
        const size = this.size;
        const buf = this.buf;

        for (let i = 0; i < n; i++) {
          buf[this.writePos] = inCh ? inCh[i] : 0;

          let out = 0;
          for (let g = 0; g < 2; g++) {
            const ph = this.phase[g];
            // Hann window over the grain (sums to ~1 with the half-offset twin)
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * ph) / gs);
            // linear-interpolated read at the (fractional) grain pointer
            const pos = this.read[g];
            const i0 = Math.floor(pos);
            const frac = pos - i0;
            const a = buf[((i0 % size) + size) % size];
            const b = buf[(((i0 + 1) % size) + size) % size];
            out += (a + (b - a) * frac) * w;

            // advance the grain read pointer at the transposition ratio
            this.read[g] += ratio;
            let np = ph + 1;
            if (np >= gs) {
              np = 0;
              // re-anchor a grain length behind the write head each cycle
              this.read[g] = this.writePos - gs;
            }
            this.phase[g] = np;
          }

          // 0.5 keeps two overlapping Hann grains near unity gain
          for (let ch = 0; ch < output.length; ch++) output[ch][i] = out * 0.5;

          this.writePos = (this.writePos + 1) % size;
        }
        return true;
      }
    }
    registerProcessor('pitch-shifter', PitchShifter);
  `;

  let pitchWorkletReady = false;
  function registerPitchWorklet() {
    if (!ctx || !ctx.audioWorklet) return Promise.resolve(false);
    const blob = new Blob([PITCH_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    return ctx.audioWorklet.addModule(url)
      .then(() => { pitchWorkletReady = true; URL.revokeObjectURL(url); return true; })
      .catch(() => { URL.revokeObjectURL(url); return false; });
  }

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

  // The transfer functions behind the Distortion effect. `x` is the input
  // sample in [-1,1] (already pre-gained by Drive in the audio graph), `bias`
  // is the DC offset that introduces asymmetry → even harmonics.
  function shaperFn(kind, x, bias) {
    const xb = x + bias;
    let y;
    switch (kind) {
      case 'tube':
        // asymmetric soft saturation — warm, tube-like even harmonics
        y = xb >= 0 ? Math.tanh(xb) : Math.tanh(xb * 0.7) * 0.85;
        break;
      case 'hard':
        // hard clip with slightly rounded knee
        y = Math.max(-1, Math.min(1, xb * 1.4));
        break;
      case 'fold':
        // wavefolder — reflects back when it exceeds ±1, rich upper harmonics
        y = Math.sin(xb * Math.PI * 0.5);
        if (Math.abs(xb) > 1) {
          let f = xb;
          while (Math.abs(f) > 1) f = (f > 0 ? 2 : -2) - f;
          y = Math.sin(f * Math.PI * 0.5);
        }
        break;
      case 'fuzz':
        // aggressive: heavily saturated then hard-clipped for square-ish edges
        y = Math.tanh(xb * 3);
        y = Math.max(-0.9, Math.min(0.9, y * 1.3));
        break;
      case 'soft':
      default:
        // classic smooth saturation
        y = Math.tanh(xb);
        break;
    }
    // remove the DC the bias introduced so we don't shift the whole signal
    return y - (bias !== 0 ? shaperBaseline(kind, bias) : 0);
  }

  // The shaper output at x=0 for a given bias — subtracted to re-center.
  function shaperBaseline(kind, bias) {
    switch (kind) {
      case 'tube':  return bias >= 0 ? Math.tanh(bias) : Math.tanh(bias * 0.7) * 0.85;
      case 'hard':  return Math.max(-1, Math.min(1, bias * 1.4));
      case 'fold':  return Math.sin(bias * Math.PI * 0.5);
      case 'fuzz':  return Math.max(-0.9, Math.min(0.9, Math.tanh(bias * 3) * 1.3));
      default:      return Math.tanh(bias);
    }
  }

  // Build a WaveShaper curve for `kind` with `bias` asymmetry. Drive is applied
  // as real pre-gain in the graph (not baked here), so the curve is just the
  // normalized nonlinearity sampled across the input range.
  function makeShaperCurve(kind, drive, bias) {
    const n = 2048;
    const curve = new Float32Array(n);
    const b = (bias / 100) * 0.6;            // bias param 0..100 → ~0..0.6 offset
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.max(-1, Math.min(1, shaperFn(kind, x, b)));
    }
    return curve;
  }

  const SHAPER_KINDS = ['soft', 'tube', 'hard', 'fold', 'fuzz'];
  const SHAPER_LABELS = ['Soft', 'Tube', 'Hard', 'Fold', 'Fuzz'];

  // ---- EQ visualization -----------------------------------------------------
  //
  // Interactive frequency-response graph for the EQ effect: a log-frequency
  // curve (the summed magnitude of the three bands) with three draggable
  // handles — drag horizontally to move a band's frequency (mid only), drag
  // vertically to set its gain. Mirrors values back to inst.params + sliders.

  // Analog biquad magnitude responses (dB) so the drawn curve matches the
  // BiquadFilterNodes in the EQ build(). w = 2π f / fs.
  function biquadShelfDb(type, f, f0, gainDb, fs) {
    // Low/high shelf magnitude approximation via the RBJ cookbook coefficients.
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f0 / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const S = 1; // shelf slope
    const alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const tsa = 2 * Math.sqrt(A) * alpha;
    let b0, b1, b2, a0, a1, a2;
    if (type === 'low') {
      b0 = A * ((A + 1) - (A - 1) * cw + tsa);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - tsa);
      a0 = (A + 1) + (A - 1) * cw + tsa;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - tsa;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + tsa);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - tsa);
      a0 = (A + 1) - (A - 1) * cw + tsa;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - tsa;
    }
    return biquadMagDb(b0, b1, b2, a0, a1, a2, f, fs);
  }

  function biquadPeakDb(f, f0, gainDb, Q, fs) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f0 / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q);
    const b0 = 1 + alpha * A;
    const b1 = -2 * cw;
    const b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A;
    const a1 = -2 * cw;
    const a2 = 1 - alpha / A;
    return biquadMagDb(b0, b1, b2, a0, a1, a2, f, fs);
  }

  function biquadMagDb(b0, b1, b2, a0, a1, a2, f, fs) {
    const w = 2 * Math.PI * f / fs;
    const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const numRe = b0 + b1 * cw + b2 * c2;
    const numIm = -(b1 * sw + b2 * s2);
    const denRe = a0 + a1 * cw + a2 * c2;
    const denIm = -(a1 * sw + a2 * s2);
    const num = Math.hypot(numRe, numIm);
    const den = Math.hypot(denRe, denIm) || 1e-9;
    return 20 * Math.log10(num / den);
  }

  function eqVisual(body, inst, which, syncSliders) {
    const fs = (ctx && ctx.sampleRate) || 48000;
    const W = 252, H = 150;
    const DB = 18;                         // vertical range ±dB
    const FMIN = 20, FMAX = 20000;
    const logMin = Math.log10(FMIN), logMax = Math.log10(FMAX);

    const wrap = document.createElement('div');
    wrap.className = 'eq-graph';
    const canvas = document.createElement('canvas');
    canvas.width = W * 2; canvas.height = H * 2;          // retina
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    wrap.appendChild(canvas);
    body.insertBefore(wrap, body.firstChild);

    const xForF = (f) => ((Math.log10(f) - logMin) / (logMax - logMin)) * W;
    const fForX = (x) => Math.pow(10, logMin + (x / W) * (logMax - logMin));
    const yForDb = (db) => H / 2 - (db / DB) * (H / 2);
    const dbForY = (y) => -((y - H / 2) / (H / 2)) * DB;
    const clampDb = (d) => Math.max(-DB, Math.min(DB, d));

    // Draggable bands. `q` (optional) is the param key for a peak's Q (wheel).
    const bands = [
      { key: 'LS', type: 'lowshelf', fK: 'lowFreq',  gK: 'lowGain',  fMin: 40,  fMax: 600 },
      { key: 'M1', type: 'peak',     fK: 'mid1Freq', gK: 'mid1Gain', qK: 'mid1Q', fMin: 100, fMax: 4000 },
      { key: 'M2', type: 'peak',     fK: 'mid2Freq', gK: 'mid2Gain', qK: 'mid2Q', fMin: 800, fMax: 12000 },
      { key: 'HS', type: 'highshelf', fK: 'highFreq', gK: 'highGain', fMin: 2000, fMax: 16000 },
    ];

    // First-order roll-off (dB) for the HP/LP cuts at frequency f.
    function cutDb(f) {
      let db = 0;
      const hp = inst.params.hpFreq, lp = inst.params.lpFreq;
      if (hp > 20) db += -10 * Math.log10(1 + Math.pow(hp / f, 2));        // HP
      if (lp < 20000) db += -10 * Math.log10(1 + Math.pow(f / lp, 2));     // LP
      return db;
    }
    function totalDb(f) {
      const p = inst.params;
      return cutDb(f)
        + biquadShelfDb('low', f, p.lowFreq, p.lowGain, fs)
        + biquadPeakDb(f, p.mid1Freq, p.mid1Gain, p.mid1Q, fs)
        + biquadPeakDb(f, p.mid2Freq, p.mid2Gain, p.mid2Q, fs)
        + biquadShelfDb('high', f, p.highFreq, p.highGain, fs);
    }

    function draw() {
      const g = canvas.getContext('2d');
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, W, H);

      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      [100, 1000, 10000].forEach((f) => {
        const x = xForF(f);
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      });

      g.beginPath();
      for (let px = 0; px <= W; px++) {
        const y = yForDb(clampDb(totalDb(fForX(px))));
        if (px === 0) g.moveTo(px, y); else g.lineTo(px, y);
      }
      g.strokeStyle = '#c5a8ff';
      g.lineWidth = 1.6;
      g.stroke();
      g.lineTo(W, H / 2); g.lineTo(0, H / 2); g.closePath();
      g.fillStyle = 'rgba(197,168,255,0.10)';
      g.fill();

      bands.forEach((b) => {
        const x = xForF(inst.params[b.fK]);
        const y = yForDb(clampDb(inst.params[b.gK]));
        g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2);
        g.fillStyle = '#ffffff'; g.fill();
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.font = "8px 'Suisse Intl Mono', monospace";
        g.fillText(b.key, x - 6, y - 8);
      });
    }

    let activeBand = null;
    const localXY = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    function pickBand(x, y) {
      let best = null, bestD = 20;
      bands.forEach((b) => {
        const bx = xForF(inst.params[b.fK]);
        const by = yForDb(clampDb(inst.params[b.gK]));
        const d = Math.hypot(bx - x, by - y);
        if (d < bestD) { bestD = d; best = b; }
      });
      return best;
    }
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const { x, y } = localXY(e);
      activeBand = pickBand(x, y);
      if (!activeBand) return;
      onDrag(e);
      window.addEventListener('mousemove', onDrag);
      window.addEventListener('mouseup', onUp);
    });
    function onDrag(e) {
      if (!activeBand) return;
      const { x, y } = localXY(e);
      const b = activeBand;
      inst.params[b.gK] = Math.round(clampDb(dbForY(y)) * 2) / 2;
      const f = Math.max(b.fMin, Math.min(b.fMax, fForX(Math.max(0, Math.min(W, x)))));
      inst.params[b.fK] = Math.round(f / 10) * 10;
      rackParamChanged(which);
      syncSliders();
      draw();
    }
    function onUp() {
      activeBand = null;
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', onUp);
    }
    // scroll over a peak band to change its Q
    canvas.addEventListener('wheel', (e) => {
      const { x, y } = localXY(e);
      const b = pickBand(x, y);
      if (!b || !b.qK) return;
      e.preventDefault();
      const q = Math.max(0.2, Math.min(8, inst.params[b.qK] + (e.deltaY < 0 ? 0.2 : -0.2)));
      inst.params[b.qK] = Math.round(q * 10) / 10;
      rackParamChanged(which);
      syncSliders();
      draw();
    }, { passive: false });

    body.parentElement._syncVisual = draw;
    draw();
  }

  // ---- Distortion transfer-curve visualization ------------------------------
  //
  // Draws the saturator's input→output transfer function (the WaveShaper curve
  // with Drive applied as horizontal input gain), so Type / Drive / Bias are
  // visible at a glance. Read-only — shaping is via the sliders below.

  function distortionVisual(body, inst, which, syncSliders) {
    const W = 252, H = 132;
    const wrap = document.createElement('div');
    wrap.className = 'eq-graph';
    const canvas = document.createElement('canvas');
    canvas.width = W * 2; canvas.height = H * 2;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    wrap.appendChild(canvas);
    body.insertBefore(wrap, body.firstChild);

    function draw() {
      const g = canvas.getContext('2d');
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, W, H);

      // axes (input x, output y), origin centered
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
      g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
      // unity diagonal reference
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke();

      const kind = SHAPER_KINDS[inst.params.character] || 'soft';
      const bias = (inst.params.bias / 100) * 0.6;
      const preGain = dbToLin((inst.params.drive / 100) * 30);

      g.beginPath();
      for (let px = 0; px <= W; px++) {
        const x = (px / W) * 2 - 1;          // input −1..1
        let y = shaperFn(kind, x * preGain, bias);
        y = Math.max(-1, Math.min(1, y));
        const py = H / 2 - y * (H / 2);
        if (px === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokeStyle = '#c5a8ff';
      g.lineWidth = 1.8;
      g.stroke();

      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.font = "8px 'Suisse Intl Mono', monospace";
      g.fillText((SHAPER_LABELS[inst.params.character] || 'Soft').toUpperCase(), 6, 12);
    }

    body.parentElement._syncVisual = draw;
    draw();
  }

  // ---- Modular FX definitions ----------------------------------------------
  //
  // Each effect type exposes:
  //   label    — display name
  //   params   — [{ k, label, min, max, step, def, fmt }]
  //   build(p) — returns { input, output, apply(p) } for an instance, building
  //              its Web Audio subgraph. apply() retunes from a params object.
  //   visual   — optional (body, inst, which, syncSliders) interactive UI.
  // Effects are chained in order; each instance's output feeds the next input.

  const FX_DEFS = {
    reverb: {
      label: 'Reverb',
      params: [
        { k: 'size',    label: 'Size',    min: 0.2, max: 5,   step: 0.1, def: 1.8, fmt: (n) => n.toFixed(1) + 's' },
        { k: 'decay',   label: 'Decay',   min: 0.5, max: 6,   step: 0.1, def: 2.6, fmt: (n) => n.toFixed(1) },
        { k: 'damp',    label: 'Damping', min: 200, max: 18000, step: 100, def: 9000, fmt: fHz },
        { k: 'mix',     label: 'Mix',     min: 0,   max: 100, step: 1,   def: 35,  fmt: pct },
      ],
      build() {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        const conv = ctx.createConvolver();
        let curKey = '';
        input.connect(dry); dry.connect(output);
        input.connect(damp); damp.connect(conv); conv.connect(wet); wet.connect(output);
        function apply(p) {
          const t = ctx.currentTime;
          const key = p.size + '|' + p.decay;
          if (key !== curKey) { conv.buffer = makeImpulse(p.size, p.decay); curKey = key; }
          damp.frequency.setTargetAtTime(p.damp, t, 0.02);
          const m = p.mix / 100;
          wet.gain.setTargetAtTime(m, t, 0.02);
          dry.gain.setTargetAtTime(1 - m * 0.6, t, 0.02);
        }
        return { input, output, apply };
      },
    },

    delay: {
      label: 'Delay / Echo',
      params: [
        { k: 'time',     label: 'Time',     min: 10,  max: 1000, step: 5, def: 160, fmt: (n) => n + 'ms' },
        { k: 'feedback', label: 'Feedback', min: 0,   max: 95,   step: 1, def: 40,  fmt: pct },
        { k: 'tone',     label: 'Tone',     min: 400, max: 16000, step: 100, def: 6000, fmt: fHz },
        { k: 'mix',      label: 'Mix',      min: 0,   max: 100,  step: 1, def: 35,  fmt: pct },
      ],
      build() {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const send = ctx.createGain();
        const delay = ctx.createDelay(1.5);
        const fb = ctx.createGain();
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        const wet = ctx.createGain();
        input.connect(dry); dry.connect(output);
        input.connect(send); send.connect(delay);
        delay.connect(tone); tone.connect(fb); fb.connect(delay);   // damped feedback
        delay.connect(wet); wet.connect(output);
        function apply(p) {
          const t = ctx.currentTime;
          delay.delayTime.setTargetAtTime(p.time / 1000, t, 0.02);
          fb.gain.setTargetAtTime(p.feedback / 100, t, 0.02);
          tone.frequency.setTargetAtTime(p.tone, t, 0.02);
          const m = p.mix / 100;
          wet.gain.setTargetAtTime(m, t, 0.02);
          send.gain.setTargetAtTime(1, t, 0.02);
          dry.gain.setTargetAtTime(1, t, 0.02);
        }
        return { input, output, apply };
      },
    },

    comp: {
      label: 'Compression',
      params: [
        { k: 'threshold', label: 'Threshold', min: -60, max: 0,  step: 1,   def: -24, fmt: (n) => n + 'dB' },
        { k: 'ratio',     label: 'Ratio',     min: 1,   max: 20, step: 0.5, def: 4,   fmt: (n) => n + ':1' },
        { k: 'attack',    label: 'Attack',    min: 0,   max: 200, step: 1,  def: 3,   fmt: (n) => n + 'ms' },
        { k: 'release',   label: 'Release',   min: 20,  max: 1000, step: 10, def: 250, fmt: (n) => n + 'ms' },
        { k: 'makeup',    label: 'Makeup',    min: 0,   max: 24, step: 0.5, def: 0,   fmt: (n) => '+' + n + 'dB' },
      ],
      build() {
        const input = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.knee.value = 6;
        const makeup = ctx.createGain();
        const output = ctx.createGain();
        input.connect(comp); comp.connect(makeup); makeup.connect(output);
        function apply(p) {
          const t = ctx.currentTime;
          comp.threshold.setTargetAtTime(p.threshold, t, 0.01);
          comp.ratio.setTargetAtTime(p.ratio, t, 0.01);
          comp.attack.setTargetAtTime(p.attack / 1000, t, 0.01);
          comp.release.setTargetAtTime(p.release / 1000, t, 0.01);
          makeup.gain.setTargetAtTime(dbToLin(p.makeup), t, 0.02);
        }
        return { input, output, apply };
      },
    },

    eq: {
      label: 'EQ',
      // Full parametric EQ: high-pass, low shelf, two sweepable peaks, high
      // shelf, low-pass. Each band has freq + gain (+ Q for the peaks). The
      // visual lets you drag bands directly; sliders fine-tune.
      params: [
        { group: 'Filters' },
        { k: 'hpFreq',  label: 'HP Freq',  min: 20,  max: 2000, step: 10, def: 20,  fmt: fHz },
        { k: 'lpFreq',  label: 'LP Freq',  min: 1000, max: 20000, step: 100, def: 20000, fmt: fHz },
        { group: 'Low Shelf' },
        { k: 'lowGain', label: 'Gain',     min: -18, max: 18,  step: 0.5, def: 0, fmt: gainDb },
        { k: 'lowFreq', label: 'Freq',     min: 40,  max: 600, step: 10,  def: 120, fmt: fHz },
        { group: 'Mid 1' },
        { k: 'mid1Gain', label: 'Gain',    min: -18, max: 18,  step: 0.5, def: 0, fmt: gainDb },
        { k: 'mid1Freq', label: 'Freq',    min: 100, max: 4000, step: 20, def: 500, fmt: fHz },
        { k: 'mid1Q',    label: 'Q',       min: 0.2, max: 8,   step: 0.1, def: 1, fmt: (n) => n.toFixed(1) },
        { group: 'Mid 2' },
        { k: 'mid2Gain', label: 'Gain',    min: -18, max: 18,  step: 0.5, def: 0, fmt: gainDb },
        { k: 'mid2Freq', label: 'Freq',    min: 800, max: 12000, step: 50, def: 3000, fmt: fHz },
        { k: 'mid2Q',    label: 'Q',       min: 0.2, max: 8,   step: 0.1, def: 1, fmt: (n) => n.toFixed(1) },
        { group: 'High Shelf' },
        { k: 'highGain', label: 'Gain',    min: -18, max: 18,  step: 0.5, def: 0, fmt: gainDb },
        { k: 'highFreq', label: 'Freq',    min: 2000, max: 16000, step: 100, def: 6000, fmt: fHz },
      ],
      build() {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.7;
        const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
        const m1 = ctx.createBiquadFilter(); m1.type = 'peaking';
        const m2 = ctx.createBiquadFilter(); m2.type = 'peaking';
        const high = ctx.createBiquadFilter(); high.type = 'highshelf';
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
        input.connect(hp); hp.connect(low); low.connect(m1); m1.connect(m2);
        m2.connect(high); high.connect(lp); lp.connect(output);
        function apply(p) {
          const t = ctx.currentTime;
          hp.frequency.setTargetAtTime(p.hpFreq, t, 0.02);
          lp.frequency.setTargetAtTime(p.lpFreq, t, 0.02);
          low.frequency.setTargetAtTime(p.lowFreq, t, 0.02);
          low.gain.setTargetAtTime(p.lowGain, t, 0.02);
          m1.frequency.setTargetAtTime(p.mid1Freq, t, 0.02);
          m1.gain.setTargetAtTime(p.mid1Gain, t, 0.02);
          m1.Q.setTargetAtTime(p.mid1Q, t, 0.02);
          m2.frequency.setTargetAtTime(p.mid2Freq, t, 0.02);
          m2.gain.setTargetAtTime(p.mid2Gain, t, 0.02);
          m2.Q.setTargetAtTime(p.mid2Q, t, 0.02);
          high.frequency.setTargetAtTime(p.highFreq, t, 0.02);
          high.gain.setTargetAtTime(p.highGain, t, 0.02);
        }
        return { input, output, apply };
      },
      visual: eqVisual,
    },

    distortion: {
      label: 'Distortion',
      params: [
        { group: 'Drive' },
        { k: 'drive',  label: 'Drive',  min: 0, max: 100, step: 1, def: 40, fmt: pct },
        { k: 'character', label: 'Type', min: 0, max: 4, step: 1, def: 0,
          fmt: (n) => SHAPER_LABELS[n] || 'Soft' },
        { k: 'bias',   label: 'Bias',   min: 0, max: 100, step: 1, def: 0, fmt: pct },
        { group: 'Tone' },
        { k: 'lowcut', label: 'Low Cut', min: 20, max: 2000, step: 10, def: 20, fmt: fHz },
        { k: 'tone',   label: 'High Cut', min: 400, max: 16000, step: 100, def: 8000, fmt: fHz },
        { group: 'Output' },
        { k: 'output', label: 'Output', min: -24, max: 12, step: 0.5, def: 0, fmt: gainDb },
        { k: 'mix',    label: 'Mix',    min: 0, max: 100, step: 1, def: 100, fmt: pct },
      ],
      // Real gain-staged saturator: Low-cut → pre-gain (Drive) → shaper(Type,
      // Bias) → post Tone → Output makeup, blended dry/wet. Drive pushes the
      // signal harder into the nonlinearity (more harmonics), and Output
      // compensates the level — the same interaction as a hardware pedal/preamp.
      build() {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.Q.value = 0.7;
        const pre = ctx.createGain();
        const shaper = ctx.createWaveShaper();
        shaper.oversample = '4x';
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        const post = ctx.createGain();        // output makeup
        const wet = ctx.createGain();
        let curKey = '';
        input.connect(dry); dry.connect(output);
        input.connect(hp); hp.connect(pre); pre.connect(shaper);
        shaper.connect(tone); tone.connect(post); post.connect(wet); wet.connect(output);
        function apply(p) {
          const t = ctx.currentTime;
          const kind = SHAPER_KINDS[p.character] || 'soft';
          const key = kind + '|' + p.bias;
          if (key !== curKey) { shaper.curve = makeShaperCurve(kind, p.drive, p.bias); curKey = key; }
          // Drive 0..100 → 0..+30 dB pre-gain into the shaper.
          pre.gain.setTargetAtTime(dbToLin((p.drive / 100) * 30), t, 0.02);
          hp.frequency.setTargetAtTime(p.lowcut, t, 0.02);
          tone.frequency.setTargetAtTime(p.tone, t, 0.02);
          post.gain.setTargetAtTime(dbToLin(p.output), t, 0.02);
          const m = p.mix / 100;
          wet.gain.setTargetAtTime(m, t, 0.02);
          dry.gain.setTargetAtTime(1 - m, t, 0.02);
        }
        return { input, output, apply };
      },
      visual: distortionVisual,
    },

    pitch: {
      label: 'Pitch Shift',
      params: [
        { k: 'semitones', label: 'Pitch', min: -24, max: 24, step: 1, def: -12,
          fmt: (n) => (n > 0 ? '+' : '') + n + 'st' },
        { k: 'cents', label: 'Fine', min: -100, max: 100, step: 1, def: 0,
          fmt: (n) => (n > 0 ? '+' : '') + n + 'c' },
        { k: 'mix',    label: 'Mix',    min: 0, max: 100, step: 1, def: 100, fmt: pct },
      ],
      // Genuine transposition via the granular pitch-shift AudioWorklet. Falls
      // back to dry until the worklet module finishes registering.
      build() {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        input.connect(dry); dry.connect(output);

        let node = null;
        if (pitchWorkletReady) {
          try {
            node = new AudioWorkletNode(ctx, 'pitch-shifter', {
              channelCount: 2, channelCountMode: 'explicit',
            });
            input.connect(node); node.connect(wet); wet.connect(output);
          } catch (e) { node = null; }
        }
        // Without the worklet, route input straight to wet so the effect is
        // transparent rather than silent.
        if (!node) { input.connect(wet); wet.connect(output); }

        function apply(p) {
          const t = ctx.currentTime;
          // At unity (0 st, 0 cents) or no worklet, pass dry through cleanly —
          // the granular engine would otherwise add slight warble.
          const bypass = !node || (p.semitones === 0 && p.cents === 0);
          if (node) {
            const ratio = Math.pow(2, (p.semitones + p.cents / 100) / 12);
            node.parameters.get('ratio').setTargetAtTime(ratio, t, 0.02);
          }
          const m = p.mix / 100;
          wet.gain.setTargetAtTime(bypass ? 0 : m, t, 0.02);
          dry.gain.setTargetAtTime(bypass ? 1 : 1 - m, t, 0.02);
        }
        return { input, output, apply };
      },
    },
  };

  // Order effect types appear in the picker.
  const FX_ORDER = ['reverb', 'delay', 'comp', 'eq', 'distortion', 'pitch'];

  // Default params object for a fresh instance of `type`.
  function fxDefaults(type) {
    const p = {};
    FX_DEFS[type].params.forEach((pr) => { if (pr.k) p[pr.k] = pr.def; });
    return p;
  }

  let fxRackSeq = 1;
  function makeFXInstance(type) {
    return { id: fxRackSeq++, type, enabled: true, params: fxDefaults(type) };
  }

  // Build a live audio chain from a rack array (list of instances). Returns
  // { input, output, dispose } where input→[enabled effects in order]→output.
  // Disabled effects are bypassed. `rack` instances are mutated in place by the
  // UI; rebuild the chain when the rack's shape (which effects / order) changes,
  // and call apply() (via applyRack) when only param values change.
  function buildRackChain(rack) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const instances = [];
    let node = input;
    rack.forEach((inst) => {
      if (!inst.enabled) return;
      const def = FX_DEFS[inst.type];
      if (!def) return;
      const built = def.build();
      built.apply(inst.params);
      node.connect(built.input);
      node = built.output;
      instances.push({ inst, built });
    });
    node.connect(output);
    function apply() {
      instances.forEach(({ inst, built }) => built.apply(inst.params));
    }
    function dispose() {
      instances.forEach(({ built }) => { if (built.dispose) built.dispose(); });
    }
    return { input, output, apply, dispose, instances };
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = makeNoiseBuffer(2);
    registerPitchWorklet();   // async; pitch effect falls back to dry until ready

    // chord buses
    resoBus = ctx.createGain();
    dryGain = ctx.createGain();
    dryGain.gain.value = 0;

    // two FX stages in series — modular racks, rebuilt as effects are added.
    // A fixed input/output gain frames each rack so the surrounding wiring is
    // stable while the inner chain is swapped out.
    fxInput = ctx.createGain();
    masterSum = ctx.createGain();
    const chordOut = ctx.createGain();
    const timelineOut = ctx.createGain();
    chordFX = { in: fxInput, out: chordOut, chain: null };
    timelineFX = { in: masterSum, out: timelineOut, chain: null };
    rebuildRack('chord');
    rebuildRack('timeline');

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

    // wiring (fxInput→chordOut and masterSum→timelineOut are bridged by the
    // rack chains, rebuilt in rebuildRack)
    resoBus.connect(fxInput);
    dryGain.connect(fxInput);
    chordFX.out.connect(masterSum);
    timelineFX.out.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(ctx.destination);
  }

  // Rebuild one master rack's audio chain from its state array, swapping the
  // live chain between the stage's fixed input and output gains.
  function rebuildRack(which) {
    if (!ctx) return;
    const stage = which === 'chord' ? chordFX : timelineFX;
    const rack = which === 'chord' ? state.chordRack : state.timelineRack;
    if (stage.chain) {
      try { stage.in.disconnect(); } catch (e) {}
      try { stage.chain.output.disconnect(); } catch (e) {}
      if (stage.chain.dispose) stage.chain.dispose();
    } else {
      try { stage.in.disconnect(); } catch (e) {}
    }
    const chain = buildRackChain(rack);
    stage.in.connect(chain.input);
    chain.output.connect(stage.out);
    stage.chain = chain;
  }

  function resume() {
    ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
  }

  // Re-apply param values to the live chains (cheap — no node rebuild).
  function applyFX() {
    if (!ctx) return;
    if (chordFX && chordFX.chain) chordFX.chain.apply();
    if (timelineFX && timelineFX.chain) timelineFX.chain.apply();
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

  // Each voice freezes its own sound-design settings onto every placed block, so
  // later slider changes don't alter blocks already placed. The shared per-block
  // FX (drive/tone/delay/space) is captured for every voice.
  const VOICE_SNAP_KEYS = {
    Chord: ['chord', 'q', 'gain', 'noise', 'volume', 'attack', 'release', 'strum'],
    Synth: ['syWave', 'syDrop', 'syDropTime', 'syNoise', 'syCutoff',
            'syAttack', 'syDecay', 'syRelease', 'syLevel'],
  };

  // Deep-copy the live chord FX rack so each placed block freezes its own copy
  // (later sidebar edits to the rack don't mutate already-placed blocks).
  function cloneRack(rack) {
    return rack.map((inst) => ({
      id: inst.id, type: inst.type, enabled: inst.enabled,
      params: Object.assign({}, inst.params),
    }));
  }

  function voiceSnapshot(voice) {
    const s = { voice, rack: cloneRack(state.chordRack) };
    (VOICE_SNAP_KEYS[voice] || []).forEach((k) => { s[k] = state[k]; });
    return s;
  }
  // Chord-specific snapshot (kept for the chord code paths that call it).
  function chordSnapshot() { return voiceSnapshot('Chord'); }
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

    // Per-chord Chord-FX chain (frozen rack), feeding the timeline-FX bus.
    const fx = buildRackChain(p.rack || []);
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
    setTimeout(() => { try { fx.output.disconnect(); fx.dispose(); } catch (e) {} },
               Math.max((tail - ctx.currentTime) * 1000, 100));
  }

  // Synth voice: oscillator + noise blended by `syNoise`, through a lowpass,
  // shaped by an attack→decay→(sustain over hold)→release envelope, with a
  // pitch that starts `syDrop` semitones above the note and glides down. Like
  // the chord voice it carries its own frozen FX chain. `snap` omitted = live.
  function playSynthVoice(dest, t, midi, lenSec, snap) {
    if (!ctx) return;
    const p = snap || voiceSnapshot('Synth');
    const baseFreq = midiToFreq(midi);
    const startFreq = baseFreq * Math.pow(2, p.syDrop / 12);
    const atk = Math.max(p.syAttack / 1000, 0.0005);
    const dec = Math.max(p.syDecay / 1000, 0.001);
    const rel = Math.max(p.syRelease / 1000, 0.005);
    const hold = Math.max(lenSec, 0.02);
    const level = p.syLevel / 100;
    const sustain = level * 0.4;            // floor the decay rests at
    const tPeak = t + atk;
    const tDecayEnd = tPeak + dec;
    const tHoldEnd = Math.max(tDecayEnd, t + atk + hold);
    const tEnd = tHoldEnd + rel;

    const fx = buildRackChain(p.rack || []);
    fx.output.connect(dest);

    // tone + noise blended into one filtered amp envelope
    const osc = ctx.createOscillator();
    osc.type = p.syWave;
    osc.frequency.setValueAtTime(startFreq, t);
    if (p.syDrop !== 0) {
      osc.frequency.exponentialRampToValueAtTime(baseFreq, t + Math.max(p.syDropTime / 1000, 0.001));
    }
    const oscGain = ctx.createGain();
    oscGain.gain.value = 1 - p.syNoise / 100;

    const nz = ctx.createBufferSource();
    nz.buffer = noiseBuf;
    nz.loop = true;
    const nzGain = ctx.createGain();
    nzGain.gain.value = p.syNoise / 100;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.syCutoff;
    lp.Q.value = 0.7;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(level, tPeak);
    amp.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0002), tDecayEnd);
    amp.gain.setValueAtTime(Math.max(sustain, 0.0002), tHoldEnd);
    amp.gain.linearRampToValueAtTime(0.0001, tEnd);

    osc.connect(oscGain); oscGain.connect(lp);
    nz.connect(nzGain); nzGain.connect(lp);
    lp.connect(amp); amp.connect(fx.input);

    osc.start(t); osc.stop(tEnd + 0.05);
    nz.start(t); nz.stop(tEnd + 0.05);

    const tail = tEnd + 2.5;
    setTimeout(() => { try { fx.output.disconnect(); fx.dispose(); } catch (e) {} },
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

    // Oscillator + noise synth. Dial a sine with a fast pitch drop for a "plop";
    // noise + short decay for a click; low sine for a sub; etc.
    Synth: {
      chord: true,    // routes through the per-block FX bus like the chord voice
      params: [],
      play(dest, t, p, midi, snap) {
        playSynthVoice(dest, t, midi != null ? midi : baseMidi(), 0.18, snap);
      },
      playLen(dest, t, midi, lenSec, snap) {
        playSynthVoice(dest, t, midi != null ? midi : baseMidi(), lenSec, snap);
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

  // Show only the active voice's controls block in the sidebar.
  function showVoiceControls(name) {
    const cc = $('chord-controls'), sc = $('synth-controls');
    if (cc) cc.hidden = name !== 'Chord';
    if (sc) sc.hidden = name !== 'Synth';
  }

  function selectVoice(name) {
    if (state.selectedVoice === name) return;
    state.selectedVoice = name;
    PALETTE.forEach((n) => padButtons[n].classList.toggle('active', n === name));
    showVoiceControls(name);
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

    // Synth oscillator waveform dropdown.
    const wsel = $('sy-wave');
    SY_WAVES.forEach((w) => {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = w;
      wsel.appendChild(opt);
    });
    wsel.value = state.syWave;
    wsel.addEventListener('change', () => { state.syWave = wsel.value; mirrorToEditing(); });
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

  // `snap` (optional) is a frozen settings object; omit for live state.
  function auditionVoice(voice, midi, snap) {
    resume();
    const def = VOICE_DEFS[voice];
    if (def.chord) def.playLen(masterSum, ctx.currentTime + 0.001, midi, 0.35, snap);
    else def.play(fxInput, ctx.currentTime + 0.001, voiceParams[voice], midi);
  }

  // ---- Per-chord settings: select + edit ------------------------------------

  // Push a snapshot's values into the Palette-tab sliders / chord select so the
  // sidebar shows the selected (or default) chord's frozen settings.
  // Push a snapshot's values into the sidebar controls for its voice (and the
  // shared FX), so the sidebar reflects the selected/default block.
  function syncPaletteFromSnapshot(p) {
    state.syncing = true;
    const set = (id, v) => { const el = $(id); if (el) { el.value = v; el.dispatchEvent(new Event('input')); } };
    const setSel = (id, v) => { const el = $(id); if (el) { el.value = v; el.dispatchEvent(new Event('change')); } };

    if (p.voice === 'Synth') {
      setSel('sy-wave', p.syWave);
      set('sy-drop', p.syDrop);
      set('sy-droptime', p.syDropTime);
      set('sy-noise', p.syNoise);
      set('sy-cutoff', p.syCutoff);
      set('sy-attack', p.syAttack);
      set('sy-decay', p.syDecay);
      set('sy-release', p.syRelease);
      set('sy-level', p.syLevel);
    } else {
      set('s-q', p.q);
      set('s-gain', p.gain);
      set('s-noise', Math.round(p.noise * 100));
      set('s-vol', Math.round(p.volume * 100));
      set('s-attack', Math.round(p.attack * 1000));
      set('s-release', Math.round(p.release * 1000));
      set('s-strum', Math.round(p.strum * 1000));
      setSel('chord-select', p.chord);
    }
    // Restore the block's frozen FX rack as the live chord rack, then rebuild.
    // Close any open chord FX windows first — they point at the old instances.
    closeRackWindows('chord');
    state.chordRack = cloneRack(p.rack || []);
    rebuildRack('chord');
    renderRack('chord');
    state.syncing = false;
  }

  // Select a placed block for editing: switch to its voice, load its frozen
  // settings into `state`, and reflect them in the sidebar. Sidebar edits then
  // mirror back to it.
  function selectPlacedNote(key) {
    const note = SEQ.notes.get(key);
    if (!note || !note.fx) { state.editingKey = null; return; }
    state.editingKey = key;
    selectVoice(note.voice);                 // show that voice's controls + pad
    Object.keys(note.fx).forEach((k) => {
      if (k !== 'voice' && k !== 'rack') state[k] = note.fx[k];
    });
    syncPaletteFromSnapshot(note.fx);         // also restores the FX rack
    applyLiveParams();
    applyFX();
    updateReadout();
  }

  // Mirror the current sidebar settings into the selected block (so editing a
  // slider changes that placed block, not future placements). No-op while
  // loading a snapshot or when nothing is selected.
  function mirrorToEditing() {
    if (state.syncing || !state.editingKey) return;
    const note = SEQ.notes.get(state.editingKey);
    if (note) note.fx = voiceSnapshot(note.voice);
  }

  // ============================================================================
  // Modular FX rack UI — add/remove effects + floating settings windows
  // ============================================================================

  const rackEl = (which) => $(which === 'chord' ? 'fx-rack-chord' : 'fx-rack-timeline');
  const rackArr = (which) => (which === 'chord' ? state.chordRack : state.timelineRack);

  // Open windows, keyed by `${which}:${instanceId}`, so they can be refreshed
  // or closed when their effect is removed.
  const fxWindows = {};

  // Called whenever a rack's audio shape changes (add/remove/reorder/toggle):
  // rebuild that chain, re-render its list, and (for the chord rack) freeze the
  // change onto the block being edited.
  function rackChanged(which) {
    rebuildRack(which);
    renderRack(which);
    if (which === 'chord') mirrorToEditing();
  }

  // Called when only a param value changed: cheap re-apply, plus freeze.
  function rackParamChanged(which) {
    if (which === 'chord' && chordFX && chordFX.chain) chordFX.chain.apply();
    else if (which === 'timeline' && timelineFX && timelineFX.chain) timelineFX.chain.apply();
    if (which === 'chord') mirrorToEditing();
  }

  function addEffect(which, type) {
    rackArr(which).push(makeFXInstance(type));
    rackChanged(which);
  }

  function removeEffect(which, inst) {
    const arr = rackArr(which);
    const i = arr.indexOf(inst);
    if (i >= 0) arr.splice(i, 1);
    const key = which + ':' + inst.id;
    if (fxWindows[key]) { fxWindows[key].remove(); delete fxWindows[key]; }
    rackChanged(which);
  }

  function moveEffect(which, inst, dir) {
    const arr = rackArr(which);
    const i = arr.indexOf(inst);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    arr.splice(i, 1);
    arr.splice(j, 0, inst);
    rackChanged(which);
  }

  // Render one rack's list of effect rows + the full-width add button.
  function renderRack(which) {
    const host = rackEl(which);
    if (!host) return;
    host.textContent = '';
    const arr = rackArr(which);

    arr.forEach((inst, idx) => {
      const def = FX_DEFS[inst.type];
      const row = document.createElement('div');
      row.className = 'fx-row' + (inst.enabled ? '' : ' off');

      const power = document.createElement('button');
      power.className = 'fx-row-power' + (inst.enabled ? ' on' : '');
      power.title = inst.enabled ? 'Bypass' : 'Enable';
      power.textContent = '⏻';
      power.addEventListener('click', () => { inst.enabled = !inst.enabled; rackChanged(which); });

      const name = document.createElement('span');
      name.className = 'fx-row-name';
      name.textContent = def.label;

      const up = document.createElement('button');
      up.className = 'fx-row-btn';
      up.textContent = '↑'; up.title = 'Move up';
      up.disabled = idx === 0;
      up.addEventListener('click', () => moveEffect(which, inst, -1));

      const down = document.createElement('button');
      down.className = 'fx-row-btn';
      down.textContent = '↓'; down.title = 'Move down';
      down.disabled = idx === arr.length - 1;
      down.addEventListener('click', () => moveEffect(which, inst, 1));

      const gear = document.createElement('button');
      gear.className = 'fx-row-btn';
      gear.textContent = '⚙'; gear.title = 'Settings';
      gear.addEventListener('click', () => openFXWindow(which, inst));

      const x = document.createElement('button');
      x.className = 'fx-row-btn fx-row-x';
      x.textContent = '×'; x.title = 'Remove';
      x.addEventListener('click', () => removeEffect(which, inst));

      row.appendChild(power);
      row.appendChild(name);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(gear);
      row.appendChild(x);
      host.appendChild(row);
    });

    // Full-width add button — opens the type picker; sits below the list.
    const add = document.createElement('button');
    add.className = 'fx-add';
    add.innerHTML = '<span class="fx-add-plus">+</span>';
    add.addEventListener('click', (e) => { e.stopPropagation(); toggleAddMenu(which, add); });
    host.appendChild(add);
  }

  // A small popover under the add button listing the effect types.
  let openAddMenu = null;
  function closeAddMenu() {
    if (openAddMenu) { openAddMenu.remove(); openAddMenu = null; }
    document.removeEventListener('click', closeAddMenu);
  }
  function toggleAddMenu(which, anchor) {
    if (openAddMenu) { closeAddMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'fx-add-menu';
    FX_ORDER.forEach((type) => {
      const item = document.createElement('button');
      item.className = 'fx-add-item';
      item.textContent = FX_DEFS[type].label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAddMenu();
        addEffect(which, type);
      });
      menu.appendChild(item);
    });
    const r = anchor.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.width = r.width + 'px';
    // Append first so we can measure its height, then place it so it always
    // stays on screen: below the button if it fits, otherwise above it, and
    // clamped to the viewport with a small margin either way.
    document.body.appendChild(menu);
    const gap = 4, margin = 8;
    const h = menu.offsetHeight;
    const below = r.bottom + gap;
    let top;
    if (below + h <= window.innerHeight - margin) {
      top = below;                                  // fits below
    } else if (r.top - gap - h >= margin) {
      top = r.top - gap - h;                        // flip above
    } else {
      // taller than either side: clamp to the viewport (menu CSS lets it scroll)
      top = Math.max(margin, window.innerHeight - margin - h);
    }
    menu.style.top = top + 'px';
    openAddMenu = menu;
    // close on outside click (defer so this click doesn't immediately close it)
    setTimeout(() => document.addEventListener('click', closeAddMenu), 0);
  }

  // ---- Floating, draggable settings window ----------------------------------

  function openFXWindow(which, inst) {
    const key = which + ':' + inst.id;
    if (fxWindows[key]) { bringToFront(fxWindows[key]); return; }
    const def = FX_DEFS[inst.type];

    const win = document.createElement('div');
    win.className = 'fx-window';
    const host = $('fx-windows');
    // stagger position so multiple windows don't stack exactly
    const n = Object.keys(fxWindows).length;
    win.style.left = (140 + n * 24) + 'px';
    win.style.top = (90 + n * 24) + 'px';

    const head = document.createElement('div');
    head.className = 'fx-window-head';
    const title = document.createElement('span');
    title.className = 'fx-window-title';
    title.textContent = def.label + (which === 'timeline' ? ' · Timeline' : '');
    const close = document.createElement('button');
    close.className = 'fx-window-x';
    close.textContent = '×';
    close.addEventListener('click', () => { win.remove(); delete fxWindows[key]; });
    head.appendChild(title);
    head.appendChild(close);

    const body = document.createElement('div');
    body.className = 'fx-window-body';

    // Build the sliders; keep per-key refs so a custom visual can sync them.
    const sliderRefs = {};
    def.params.forEach((pr) => {
      // A { group: 'Name' } entry renders a sub-heading divider, not a slider.
      if (pr.group) {
        const h = document.createElement('p');
        h.className = 'fx-group-label';
        h.textContent = pr.group;
        body.appendChild(h);
        return;
      }
      const rowEl = document.createElement('div');
      rowEl.className = 'slider-row';
      const label = document.createElement('label');
      label.textContent = pr.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = pr.min; input.max = pr.max; input.step = pr.step;
      input.value = inst.params[pr.k];
      const val = document.createElement('span');
      val.className = 'val';
      const fmt = pr.fmt || String;
      val.textContent = fmt(inst.params[pr.k]);
      const refresh = () => { input.value = inst.params[pr.k]; val.textContent = fmt(inst.params[pr.k]); };
      input.addEventListener('input', () => {
        const num = parseFloat(input.value);
        inst.params[pr.k] = num;
        val.textContent = fmt(num);
        rackParamChanged(which);
        if (win._syncVisual) win._syncVisual();
      });
      rowEl.appendChild(label);
      rowEl.appendChild(input);
      rowEl.appendChild(val);
      body.appendChild(rowEl);
      sliderRefs[pr.k] = refresh;
    });

    win.appendChild(head);

    // Optional interactive visualization (e.g. EQ response curve). It lives in
    // its own fixed area ABOVE the scrolling body so it stays visible while you
    // scroll the sliders. The visual edits inst.params directly; syncSliders
    // refreshes the slider rows to match after a drag.
    if (def.visual) {
      const visualHost = document.createElement('div');
      visualHost.className = 'fx-window-visual';
      win.appendChild(visualHost);
      const syncSliders = () => Object.values(sliderRefs).forEach((fn) => fn());
      def.visual(visualHost, inst, which, syncSliders);
    }

    win.appendChild(body);
    host.appendChild(win);
    fxWindows[key] = win;
    bringToFront(win);
    makeDraggable(win, head);
  }

  // Close every open settings window belonging to one rack (used when its
  // instances are swapped out wholesale, e.g. selecting a different block).
  function closeRackWindows(which) {
    Object.keys(fxWindows).forEach((key) => {
      if (key.indexOf(which + ':') === 0) {
        fxWindows[key].remove();
        delete fxWindows[key];
      }
    });
  }

  let fxWinZ = 50;
  function bringToFront(win) { win.style.zIndex = ++fxWinZ; }

  function makeDraggable(win, handle) {
    let dx = 0, dy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('fx-window-x')) return;
      e.preventDefault();
      bringToFront(win);
      const r = win.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      const move = (ev) => {
        win.style.left = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - dx)) + 'px';
        win.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy)) + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
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
      // New block: freeze the active voice's current settings. NOT auto-selected,
      // and placing clears any prior selection so the sidebar edits "next" defaults.
      const key = c.step + ':' + c.midi;
      const note = { voice, len: 1, fx: voiceSnapshot(voice) };
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
    const fSemi = (n) => (n > 0 ? '+' : '') + n;

    // Synth voice — osc + noise blend (frozen onto the block when placed/edited)
    bindSlider('sy-drop', 'vy-drop', (n) => { state.syDrop = n; mirrorToEditing(); }, fSemi);
    bindSlider('sy-droptime', 'vy-droptime', (n) => { state.syDropTime = n; mirrorToEditing(); }, (n) => n + 'ms');
    bindSlider('sy-noise', 'vy-noise', (n) => { state.syNoise = n; mirrorToEditing(); });
    bindSlider('sy-cutoff', 'vy-cutoff', (n) => { state.syCutoff = n; mirrorToEditing(); }, fHzShort);
    bindSlider('sy-attack', 'vy-attack', (n) => { state.syAttack = n; mirrorToEditing(); }, (n) => n + 'ms');
    bindSlider('sy-decay', 'vy-decay', (n) => { state.syDecay = n; mirrorToEditing(); }, (n) => n + 'ms');
    bindSlider('sy-release', 'vy-release', (n) => { state.syRelease = n; mirrorToEditing(); }, (n) => n + 'ms');
    bindSlider('sy-level', 'vy-level', (n) => { state.syLevel = n; mirrorToEditing(); });

    // Modular FX racks — Chord (per-block) + Timeline (master bus)
    renderRack('chord');
    renderRack('timeline');

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
