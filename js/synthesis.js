'use strict';
/**
 * synthesis.js — Additive Resynthesis Engine
 */
class AdditiveSynthesizer {
  constructor(sampleRate, hopSize) {
    this.sampleRate = sampleRate;
    this.hopSize    = hopSize;
  }

  /**
   * @param {object}   analysis
   * @param {Function} pitchMap  (frameIdx, origFreq) → ratio
   * @param {number}   speed     1.0 = normal, 0.0 = freeze
   * @param {number}   startSec  生成を開始する秒数
   * @param {object}   adsr      {a: ms, d: ms, s: %, r: ms}  ※nullの場合は適用しない
   */
  async synthesize(analysis, pitchMap, speed = 1.0, startSec = 0, adsr = null, onProgress) {
    const { partials, numFrames, hopSize, sampleRate } = analysis;
    const startFrame = Math.max(0, Math.min(numFrames - 1, Math.round(startSec * sampleRate / hopSize)));

    let out;
    if (speed <= 0.001) {
      out = await this._synthesizeFreeze(analysis, pitchMap, startFrame, onProgress);
    } else {
      const framesToProcess = numFrames - startFrame;
      if (framesToProcess <= 0) return new Float64Array(0);

      const outFrames = Math.floor(framesToProcess / speed);
      
      // Releaseタイム分の余白を確保（秒換算）
      const releaseSec = adsr ? (adsr.r / 1000.0) : 0;
      const releaseSamples = Math.ceil(releaseSec * sampleRate);
      
      const totalSamples = (outFrames + 4) * hopSize + releaseSamples;
      out = new Float64Array(totalSamples);

      const BATCH = 20;
      const nyq = sampleRate * 0.49;
      const twoPi = 2 * Math.PI;

      for (let i = 0; i < partials.length; i++) {
        if (i % BATCH === 0) {
          if (onProgress) onProgress(i / partials.length);
          await yieldToUI();
        }
        
        const segs = partials[i].segs;
        if (segs.length < 2) continue;
        
        let phase = segs[0].phase || 0;

        for (let j = 0; j < segs.length - 1; j++) {
          const s1 = segs[j], s2 = segs[j + 1];

          if (s2.fi < startFrame) {
            const durSamples = s2.fi - s1.fi;
            const avgF = (s1.freq + s2.freq) * 0.5;
            phase += twoPi * avgF / sampleRate * durSamples * hopSize;
            phase = wrapPhase(phase);
            continue;
          }

          const r1 = pitchMap ? pitchMap(s1.fi, s1.freq) : 1.0;
          const r2 = pitchMap ? pitchMap(s2.fi, s2.freq) : 1.0;
          const f1 = Math.min(s1.freq * r1, nyq);
          const f2 = Math.min(s2.freq * r2, nyq);
          const a1 = s1.amp;
          const a2 = s2.amp;

          const frameSpan = (s2.fi - s1.fi) / speed;
          const durSamples = Math.floor(frameSpan * hopSize);
          if (durSamples <= 0) continue;

          if (a1 === 0 && a2 === 0) {
            phase += twoPi * f1 / sampleRate * durSamples;
            phase = wrapPhase(phase);
            continue;
          }

          const relativeFrame = s1.fi - startFrame;
          const baseIdx = Math.max(0, Math.floor(relativeFrame / speed * hopSize));
          const invD = 1.0 / durSamples;
          const sr = sampleRate;

          for (let s = 0; s < durSamples; s++) {
            const t = s * invD;
            const f = f1 + (f2 - f1) * t;
            const amp = a1 + (a2 - a1) * t;
            phase += twoPi * f / sr;
            
            if (phase > Math.PI)  phase -= twoPi;
            if (phase < -Math.PI) phase += twoPi;
            
            const idx = baseIdx + s;
            if (idx >= 0 && idx < out.length) out[idx] += amp * Math.sin(phase);
          }
        }
      }
    }

    // 正規化の前にADSRエンベロープを適用
    if (adsr) {
      this._applyADSR(out, sampleRate, adsr);
    }

    this._normalize(out, 0.9);
    if (onProgress) onProgress(1.0);
    return out;
  }

  async _synthesizeFreeze(analysis, pitchMap, targetFrame, onProgress) {
    const { partials, sampleRate } = analysis;
    const durSec = 10.0; // フリーズループは一律10秒
    const totalSamples = durSec * sampleRate;
    const out = new Float64Array(totalSamples);
    
    const active = [];
    for (const p of partials) {
      const seg = p.segs.find(s => Math.abs(s.fi - targetFrame) <= 2);
      if (seg && seg.amp > 1e-4) active.push(seg);
    }

    let count = 0;
    const twoPi = 2 * Math.PI;

    for (const p of active) {
      if (++count % 50 === 0) {
        if (onProgress) onProgress(count / active.length);
        await yieldToUI();
      }
      
      let phase = p.phase;
      const ratio = pitchMap ? pitchMap(p.fi, p.freq) : 1.0;
      const f = Math.min(p.freq * ratio, sampleRate * 0.49);
      const inc = twoPi * f / sampleRate;
      const a = p.amp;

      for (let i = 0; i < totalSamples; i++) {
        out[i] += a * Math.sin(phase);
        phase += inc;
        if (phase > Math.PI) phase -= twoPi;
      }
    }
    return out;
  }

  /**
   * 波形データにADSRエンベロープを直接乗算する
   * @param {Float64Array} out 波形データ
   * @param {number} sampleRate サンプルレート
   * @param {object} adsr {a, d, s, r} (a, d, r は ms, s は %)
   */
  _applyADSR(out, sampleRate, adsr) {
    const aSamples = Math.floor((adsr.a / 1000) * sampleRate);
    const dSamples = Math.floor((adsr.d / 1000) * sampleRate);
    const rSamples = Math.floor((adsr.r / 1000) * sampleRate);
    const susLevel = adsr.s / 100.0;

    const totalLen = out.length;
    // Releaseの開始位置は全体の末尾から rSamples 引いた地点
    const sustainEnd = Math.max(0, totalLen - rSamples);

    for (let i = 0; i < totalLen; i++) {
      let env = 0.0;

      if (i < aSamples) {
        // Attack
        env = i / Math.max(1, aSamples);
      } else if (i < aSamples + dSamples) {
        // Decay
        const dt = (i - aSamples) / Math.max(1, dSamples);
        env = 1.0 - (1.0 - susLevel) * dt;
      } else if (i < sustainEnd) {
        // Sustain
        env = susLevel;
      } else {
        // Release
        const rt = (i - sustainEnd) / Math.max(1, rSamples);
        env = susLevel * (1.0 - rt);
        if (env < 0) env = 0;
      }

      out[i] *= env;
    }
  }

  _normalize(out, target) {
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-6) {
      const k = target / peak;
      for (let i = 0; i < out.length; i++) out[i] *= k;
    }
  }
}

function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }
function wrapPhase(p) { const TWO_PI = 2 * Math.PI; while (p > Math.PI) p -= TWO_PI; while (p < -Math.PI) p += TWO_PI; return p; }