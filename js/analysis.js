'use strict';
/**
 * analysis.js — Spectral Analysis Engine (High Precision Rollback)
 * 
 * - Deterministic (Peak) トラッキングに加え、
 * - Stochastic (Noise/Residual) の成分を 64 バンドで抽出し、
 *   isNoise フラグ付きのパーシャルとして出力する機能を追加。
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

    // ノイズ（残差）抽出用バンド設定 (広帯域: 500Hz 〜 Nyquist)
    this.noiseBands = 64;
    this.noiseFreqs = this._logSpacedFreqs(500, this.sampleRate * 0.49, this.noiseBands);
    this.noiseBins  = this.noiseFreqs.map(f => Math.round(f * this.fftSize / this.sampleRate));
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

    for (let fi = 0; fi < numFrames; fi++) {
      if (fi % BATCH === 0) {
        if (onProgress) onProgress(fi / numFrames * 0.5);
        await yieldToUI();
      }

      const offset = fi * hop;
      for (let i = 0; i < N; i++) {
        const s = (offset + i < len) ? audio[offset + i] : 0;
        this._real[i] = s * this.window[i];
        this._imag[i] = 0;
      }
      this.fft.forward(this._real, this._imag);

      const mag = new Float64Array(halfN);
      for (let i = 1; i < halfN; i++) {
        const re = this._real[i], im = this._imag[i];
        mag[i] = Math.sqrt(re * re + im * im) * 2 / this.winSum;
      }

      const band = new Float32Array(this.spectBands);
      for (let b = 0; b < this.spectBands; b++) {
        const bin = this._spectBins[b];
        if (bin > 0 && bin < halfN) band[b] = mag[bin];
      }
      spectrogram.push(band);

      // ピーク検出
      const peaks = this._detectPeaks(this._real, this._imag, mag);
      const time  = (offset + N / 2) / sr;
      
      // Residual (ノイズ) 成分の抽出 (Spectral Subtraction近似)
      const resMag = new Float64Array(mag);
      for (const p of peaks) {
        const bin = Math.round(p.bin);
        const pMag = p.amp * (this.winSum / 2);
        
        // Hann窓のメインローブ幅（約±2ビン）に対して近似減算
        for(let i = Math.max(1, bin - 2); i <= Math.min(halfN - 1, bin + 2); i++) {
          const dist = Math.abs(i - p.bin);
          const windowShape = Math.max(0, 0.5 * (1 + Math.cos(Math.PI * dist / 2)));
          const subMag = pMag * windowShape;
          resMag[i] = Math.max(0, resMag[i] - subMag);
        }
      }

      // 残差エネルギーをノイズバンドに割り振る
      const noiseAmpBand = new Float32Array(this.noiseBands);
      for (let b = 0; b < this.noiseBands; b++) {
        const startBin = b === 0 ? Math.round(500 * N / sr) : this.noiseBins[b-1];
        const endBin = this.noiseBins[b];
        let sum = 0, count = 0;
        for (let i = startBin; i < endBin && i < halfN; i++) {
          sum += resMag[i] * resMag[i];
          count++;
        }
        // RMS平均振幅
        noiseAmpBand[b] = count > 0 ? Math.sqrt(sum / count) : 0;
      }

      frames.push({ fi, time, peaks, noiseAmpBand });
    }

    // 正弦波（ピーク）のトラッキング
    const partials = await this._trackPartials(frames, numFrames, p => {
      if (onProgress) onProgress(0.5 + p * 0.45);
    });

    // ノイズバンドを特殊パーシャル (isNoise: true) として追加
    let noiseIdCounter = 10000;
    for (let b = 0; b < this.noiseBands; b++) {
      const segs = [];
      const freq = this.noiseFreqs[b];
      for (let fi = 0; fi < numFrames; fi++) {
        segs.push({ fi, freq, amp: frames[fi].noiseAmpBand[b], phase: 0 });
      }
      partials.push({ id: noiseIdCounter++, isNoise: true, segs });
    }

    const f0Data = this._estimateF0(partials, numFrames);

    if (onProgress) onProgress(1.0);

    return {
      sampleRate: sr, fftSize: N, hopSize: hop, numFrames, duration: numFrames * hop / sr,
      frames, partials, spectrogram, spectFreqs: this._spectFreqs, f0Data
    };
  }

  _estimateF0(partials, numFrames) {
    const f0 = new Float32Array(numFrames);
    const activeAt = Array.from({ length: numFrames }, () => []);
    
    for (const p of partials) {
      if (p.isNoise) continue; // ノイズパーシャルはF0推定から除外
      for (const s of p.segs) {
        activeAt[s.fi].push(s);
      }
    }
    
    for (let fi = 0; fi < numFrames; fi++) {
      const active = activeAt[fi];
      if (active.length === 0) continue;
      
      active.sort((a, b) => b.amp - a.amp);
      const tops = active.slice(0, 10).filter(s => s.freq > 60 && s.freq < 1200);
      
      if (tops.length > 0) {
        tops.sort((a, b) => a.freq - b.freq);
        f0[fi] = tops[0].freq;
      }
    }
    
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

  _detectPeaks(real, imag, mag) {
    const halfN = this.fftSize >> 1, sr = this.sampleRate, N = this.fftSize;
    const peaks = [];
    const baseThreshSq = this.thresh * this.thresh;

    for (let i = 2; i < halfN - 2; i++) {
      const m0 = mag[i] * mag[i] * (this.winSum / 2) * (this.winSum / 2); // Squared magnitude

      // 低域保護: 500Hz以下は閾値を最大12dB(約0.25倍)まで緩める
      const freqEst = i * sr / N;
      let localThreshSq = baseThreshSq;
      if (freqEst < 500) {
        const factor = Math.max(0.25, freqEst / 500);
        localThreshSq *= factor;
      }

      if (m0 <= localThreshSq) continue;
      
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
      const ph0  = Math.atan2(imag[i], real[i]);
      const phR  = Math.atan2(imag[i+1], real[i+1]);
      const ph   = ph0 + p * unwrapAngle(phR - ph0);

      peaks.push({ freq, amp, phase: ph, bin: bin });
    }

    peaks.sort((a, b) => b.amp - a.amp);
    return peaks.slice(0, this.maxPartials);
  }

  async _trackPartials(frames, numFrames, onProgress) {
    const completed = [];
    const active = new Map();
    let nextId   = 0;
    const tol    = this.freqTol;
    const BATCH  = 128;
    const MAX_SLEEP = 2; // 最大2フレームの消失を許容

    for (let fi = 0; fi < frames.length; fi++) {
      if (fi % BATCH === 0) {
        if (onProgress) onProgress(fi / frames.length);
        await yieldToUI();
      }

      const peaks = [...frames[fi].peaks].sort((a, b) => a.freq - b.freq);
      const matched = new Uint8Array(peaks.length);
      const nextActive = new Map();

      const activeArr = Array.from(active.values())
        .map(p => ({
          id: p.id,
          segs: p.segs,
          lastFreq: p.segs[p.segs.length - 1].freq,
          lastAmp: p.segs[p.segs.length - 1].amp,
          sleep: p.sleep || 0
        }))
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
          nextActive.set(ap.id, { id: ap.id, segs: ap.segs, sleep: 0 }); // 復活・継続
        } else {
          // 見失った場合、MAX_SLEEPまでは仮想的に減衰させて保持（Gap充填）
          if (ap.sleep < MAX_SLEEP) {
            const last = ap.segs[ap.segs.length - 1];
            ap.segs.push({ fi, freq: last.freq, amp: last.amp * 0.5, phase: last.phase });
            nextActive.set(ap.id, { id: ap.id, segs: ap.segs, sleep: ap.sleep + 1 });
          } else {
            // 完全に見失った
            const last = ap.segs[ap.segs.length - 1];
            ap.segs.push({ fi, freq: last.freq, amp: 0, phase: last.phase });
            if (ap.segs.length >= this.minFrames) completed.push({ id: ap.id, segs: ap.segs });
          }
        }
      }

      for (let pi = 0; pi < peaks.length; pi++) {
        if (!matched[pi]) {
          const id = nextId++;
          nextActive.set(id, { id, segs: [{ fi, ...peaks[pi] }], sleep: 0 });
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