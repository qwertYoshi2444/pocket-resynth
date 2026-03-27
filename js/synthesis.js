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
   */
  async synthesize(analysis, pitchMap, speed = 1.0, onProgress) {
    const { partials, numFrames, hopSize, sampleRate } = analysis;

    // 0.0倍の時はフリーズ処理に移行
    if (speed <= 0.001) {
      return this._synthesizeFreeze(analysis, pitchMap, onProgress);
    }

    // 出力用のフレーム数を計算（Time-Stretch）
    const outFrames = Math.floor(numFrames / speed);
    const totalSamples = (outFrames + 4) * hopSize;
    const out = new Float64Array(totalSamples);

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
        const r1 = pitchMap ? pitchMap(s1.fi, s1.freq) : 1.0;
        const r2 = pitchMap ? pitchMap(s2.fi, s2.freq) : 1.0;

        const f1 = Math.min(s1.freq * r1, nyq);
        const f2 = Math.min(s2.freq * r2, nyq);
        const a1 = s1.amp;
        const a2 = s2.amp;

        // セグメント間の時間をspeedで伸縮
        const frameSpan = (s2.fi - s1.fi) / speed;
        const durSamples = Math.floor(frameSpan * hopSize);
        if (durSamples <= 0) continue;

        if (a1 === 0 && a2 === 0) {
          phase += twoPi * f1 / sampleRate * durSamples;
          phase = wrapPhase(phase);
          continue;
        }

        const baseIdx = Math.floor(s1.fi / speed * hopSize);
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
          if (idx < out.length) out[idx] += amp * Math.sin(phase);
        }
      }
    }

    this._normalize(out, 0.9);
    if (onProgress) onProgress(1.0);
    return out;
  }

  /**
   * フリーズループ処理（解析結果の中心フレームのスペクトルを使って10秒間純粋に伸ばす）
   */
  async _synthesizeFreeze(analysis, pitchMap, onProgress) {
    const { partials, sampleRate, numFrames } = analysis;
    const durSec = 10.0; // 10秒間のWAVを生成
    const totalSamples = durSec * sampleRate;
    const out = new Float64Array(totalSamples);
    
    // 解析結果の中央のフレームをフリーズ対象として選定
    const targetFi = Math.floor(numFrames / 2);

    const active = [];
    for (const p of partials) {
      // ターゲット周辺に存在する倍音成分を抽出
      const seg = p.segs.find(s => Math.abs(s.fi - targetFi) <= 2);
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

    this._normalize(out, 0.9);
    if (onProgress) onProgress(1.0);
    return out;
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