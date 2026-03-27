'use strict';
/**
 * analysis.js — Spectral Analysis Engine
 */
class SpectralAnalyzer {
  constructor(opts = {}) {
    this.fftSize      = opts.fftSize      || 4096;
    this.hopSize      = opts.hopSize      || (this.fftSize >> 3);
    this.sampleRate   = opts.sampleRate   || 44100;
    this.maxPartials  = opts.maxPartials  || 200;
    this.threshDb     = opts.threshDb     || -70;
    this.minFrames    = opts.minFrames    || 3;
    this.freqTol      = opts.freqTol      || 0.05;
    this.spectBands   = opts.spectBands   || 256;

    this.fft     = new FFT(this.fftSize);
    this.window  = this._hann(this.fftSize);
    this.winSum  = this.window.reduce((a, b) => a + b, 0);
    this.thresh  = (this.winSum / 2) * Math.pow(10, this.threshDb / 20);

    this._real = new Float64Array(this.fftSize);
    this._imag = new Float64Array(this.fftSize);

    this._spectFreqs = this._logSpacedFreqs(20, this.sampleRate / 2, this.spectBands);
    this._spectBins  = this._spectFreqs.map(f => Math.round(f * this.fftSize / this.sampleRate));
  }

  async analyze(audio, onProgress) {
    const N        = this.fftSize;
    const hop      = this.hopSize;
    const sr       = this.sampleRate;
    const halfN    = N >> 1;
    const len      = audio.length;
    const numFrames = Math.max(1, Math.floor((len - N) / hop) + 1);

    const frames       = [];
    const spectrogram  = [];
    const BATCH        = 64;

    // ---- Pass 1: STFT frame analysis ----
    for (let fi = 0; fi < numFrames; fi++) {
      if (fi % BATCH === 0) {
        if (onProgress) onProgress(fi / numFrames * 0.5); // STFT pass (50%)
        await yieldToUI();
      }

      const offset = fi * hop;
      for (let i = 0; i < N; i++) {
        const s = (offset + i < len) ? audio[offset + i] : 0;
        this._real[i] = s * this.window[i];
        this._imag[i] = 0;
      }
      this.fft.forward(this._real, this._imag);

      const band = new Float32Array(this.spectBands);
      for (let b = 0; b < this.spectBands; b++) {
        const bin = this._spectBins[b];
        if (bin > 0 && bin < halfN) {
          const re = this._real[bin], im = this._imag[bin];
          band[b] = Math.sqrt(re * re + im * im) * 2 / this.winSum;
        }
      }
      spectrogram.push(band);

      const peaks = this._detectPeaks(this._real, this._imag);
      const time  = (offset + N / 2) / sr;
      frames.push({ fi, time, peaks });
    }

    // ---- Pass 2: Partial tracking ----
    const partials = await this._trackPartials(frames, numFrames, p => {
      if (onProgress) onProgress(0.5 + p * 0.45); // Tracking pass (45%)
    });

    // ---- Pass 3: F0 Estimation (New for Vocal Mode) ----
    const f0Data = this._estimateF0(partials, numFrames);

    if (onProgress) onProgress(1.0);

    return {
      sampleRate: sr,
      fftSize:    N,
      hopSize:    hop,
      numFrames,
      duration:   numFrames * hop / sr,
      frames,
      partials,
      spectrogram,
      spectFreqs: this._spectFreqs,
      f0Data,  // 追加: フレームごとの基本周波数 (Float32Array)
    };
  }

  // -----------------------------------------------------------------------
  // New: F0 (Pitch) Estimation
  // -----------------------------------------------------------------------
  _estimateF0(partials, numFrames) {
    const f0 = new Float32Array(numFrames);
    const activeAt = Array.from({ length: numFrames }, () => []);
    
    // 存在する全partialのセグメントをフレームごとにまとめる
    for (const p of partials) {
      for (const s of p.segs) activeAt[s.fi].push(s);
    }
    
    // 各フレームでボーカル帯域の基音を探す
    for (let fi = 0; fi < numFrames; fi++) {
      const active = activeAt[fi];
      if (active.length === 0) continue;
      
      // 振幅が大きい上位成分を抽出し、60〜1200Hzの範囲で最も低いものをF0とする
      active.sort((a, b) => b.amp - a.amp);
      const tops = active.slice(0, 10).filter(s => s.freq > 60 && s.freq < 1200);
      
      if (tops.length > 0) {
        tops.sort((a, b) => a.freq - b.freq);
        f0[fi] = tops[0].freq;
      }
    }
    
    // メディアンフィルタで突発的な誤検出（スパイク）を除去
    const smooth = new Float32Array(numFrames);
    for (let i = 2; i < numFrames - 2; i++) {
      const w = [f0[i-2], f0[i-1], f0[i], f0[i+1], f0[i+2]].sort((a, b) => a - b);
      smooth[i] = w[2];
    }
    if (numFrames > 0) smooth[0] = f0[0];
    if (numFrames > 1) smooth[1] = f0[1];
    if (numFrames > 2) smooth[numFrames-2] = f0[numFrames-2];
    if (numFrames > 3) smooth[numFrames-1] = f0[numFrames-1];
    
    return smooth;
  }

  // -----------------------------------------------------------------------
  // Peak Detection (Existing)
  // -----------------------------------------------------------------------
  _detectPeaks(real, imag) {
    const halfN = this.fftSize >> 1, sr = this.sampleRate, N = this.fftSize;
    const peaks = [];

    for (let i = 2; i < halfN - 2; i++) {
      const re0 = real[i], im0 = imag[i];
      const m0  = re0 * re0 + im0 * im0;

      if (m0 <= this.thresh * this.thresh) continue;
      const m_1 = real[i-1]*real[i-1] + imag[i-1]*imag[i-1];
      const m_2 = real[i-2]*real[i-2] + imag[i-2]*imag[i-2];
      const mp1 = real[i+1]*real[i+1] + imag[i+1]*imag[i+1];
      const mp2 = real[i+2]*real[i+2] + imag[i+2]*imag[i+2];

      if (!(m0 > m_1 && m0 > mp1 && m0 >= m_2 && m0 >= mp2)) continue;

      const lm  = 0.5 * Math.log(Math.max(m_1, 1e-40));
      const lc  = 0.5 * Math.log(Math.max(m0,  1e-40));
      const lr  = 0.5 * Math.log(Math.max(mp1, 1e-40));
      const den = lm - 2 * lc + lr;
      const p   = den !== 0 ? 0.5 * (lm - lr) / den : 0;
      if (Math.abs(p) > 1) continue;

      const bin  = i + p;
      const freq = bin * sr / N;
      if (freq < 20 || freq > sr * 0.49) continue;

      const logAmp = lc - 0.25 * (lm - lr) * p;
      const amp    = Math.exp(logAmp) * 2 / this.winSum;
      const ph0  = Math.atan2(im0, re0);
      const phR  = Math.atan2(imag[i+1], real[i+1]);
      const ph   = ph0 + p * unwrapAngle(phR - ph0);

      peaks.push({ freq, amp, phase: ph, bin: i });
    }

    peaks.sort((a, b) => b.amp - a.amp);
    return peaks.slice(0, this.maxPartials);
  }

  // -----------------------------------------------------------------------
  // Partial Tracking (Existing)
  // -----------------------------------------------------------------------
  async _trackPartials(frames, numFrames, onProgress) {
    const completed = [];
    const active = new Map();
    let nextId   = 0;
    const tol    = this.freqTol;
    const BATCH  = 128;

    for (let fi = 0; fi < frames.length; fi++) {
      if (fi % BATCH === 0) {
        if (onProgress) onProgress(fi / frames.length);
        await yieldToUI();
      }

      const peaks = [...frames[fi].peaks].sort((a, b) => a.freq - b.freq);
      const matched = new Uint8Array(peaks.length);
      const nextActive = new Map();

      const activeArr = Array.from(active.values())
        .map(p => ({ id: p.id, segs: p.segs, lastFreq: p.segs[p.segs.length - 1].freq }))
        .sort((a, b) => a.lastFreq - b.lastFreq);

      for (const ap of activeArr) {
        const lf  = ap.lastFreq;
        let best  = -1, bestDist = Infinity;

        for (let pi = 0; pi < peaks.length; pi++) {
          if (matched[pi]) continue;
          const rel = Math.abs(peaks[pi].freq - lf) / lf;
          if (rel < tol && rel < bestDist) { bestDist = rel; best = pi; }
        }

        if (best >= 0) {
          matched[best] = 1;
          ap.segs.push({ fi, ...peaks[best] });
          nextActive.set(ap.id, { id: ap.id, segs: ap.segs });
        } else {
          const last = ap.segs[ap.segs.length - 1];
          ap.segs.push({ fi, freq: last.freq, amp: 0, phase: last.phase });
          if (ap.segs.length >= this.minFrames) completed.push({ id: ap.id, segs: ap.segs });
        }
      }

      for (let pi = 0; pi < peaks.length; pi++) {
        if (!matched[pi]) {
          const id = nextId++;
          nextActive.set(id, { id, segs: [{ fi, ...peaks[pi] }] });
        }
      }

      active.clear();
      for (const [k, v] of nextActive) active.set(k, v);
    }

    for (const ap of active.values()) {
      if (ap.segs.length >= this.minFrames) completed.push({ id: ap.id, segs: ap.segs });
    }
    return completed;
  }

  _hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  _logSpacedFreqs(fMin, fMax, n) {
    const logMin = Math.log(fMin), logMax = Math.log(fMax);
    return Array.from({ length: n }, (_, i) => Math.exp(logMin + (logMax - logMin) * i / (n - 1)));
  }
}

function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }
function unwrapAngle(d) {
  while (d >  Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}