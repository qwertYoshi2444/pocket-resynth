'use strict';
class AdditiveSynthesizer {
  constructor(sampleRate, hopSize) {
    this.sampleRate = sampleRate;
    this.hopSize    = hopSize;
  }

  // speed 引数を追加
  async synthesize(analysis, pitchMap, speed = 1.0, onProgress) {
    const { partials, numFrames, hopSize, sampleRate } = analysis;
    
    // スピード0.0の場合は10秒フリーズの専用合成処理へ
    if (speed <= 0.001) {
       return this._synthesizeFreeze(analysis, pitchMap, onProgress);
    }

    const outFrames = Math.floor(numFrames / speed);
    const totalSamples = (outFrames + 4) * hopSize;
    const out = new Float64Array(totalSamples);

    let count = 0;
    for (const p of partials) {
      if (++count % 20 === 0) { if (onProgress) onProgress(count / partials.length); await yieldToUI(); }
      const segs = p.segs;
      if (segs.length < 2) continue;
      let phase = segs[0].phase || 0;

      for (let i = 0; i < segs.length - 1; i++) {
        const s1 = segs[i], s2 = segs[i+1];
        const r1 = pitchMap ? pitchMap(s1.fi, s1.freq) : 1.0;
        const r2 = pitchMap ? pitchMap(s2.fi, s2.freq) : 1.0;
        const f1 = Math.min(s1.freq * r1, sampleRate * 0.49);
        const f2 = Math.min(s2.freq * r2, sampleRate * 0.49);
        
        // Time-stretch: セグメント間のフレーム数をスピードで割る
        const frameSpan = (s2.fi - s1.fi) / speed;
        const durSamples = Math.floor(frameSpan * hopSize);
        if (durSamples <= 0) continue;

        const baseIdx = Math.floor(s1.fi / speed * hopSize);
        const invD = 1.0 / durSamples;

        for (let s = 0; s < durSamples; s++) {
          const t = s * invD;
          const f = f1 + (f2 - f1) * t;
          const amp = s1.amp + (s2.amp - s1.amp) * t;
          phase += 2 * Math.PI * f / sampleRate;
          const idx = baseIdx + s;
          if (idx < out.length) out[idx] += amp * Math.sin(phase);
        }
      }
    }
    this._normalize(out, 0.9);
    if (onProgress) onProgress(1.0);
    return out;
  }

  // 0.0倍時の解析ベース・フリーズループ生成 (10秒固定)
  async _synthesizeFreeze(analysis, pitchMap, onProgress) {
    const { partials, sampleRate, numFrames } = analysis;
    const durSec = 10.0;
    const totalSamples = durSec * sampleRate;
    const out = new Float64Array(totalSamples);
    
    // フリーズ抽出位置 (全体のエネルギーが一番高いフレームを採用)
    const targetFi = Math.floor(numFrames / 2); // 簡略化して中央のフレームを採用

    // 抽出位置における各Partialの状態を取得
    const active = [];
    for (const p of partials) {
      const seg = p.segs.find(s => Math.abs(s.fi - targetFi) <= 2);
      if (seg && seg.amp > 1e-4) active.push(seg);
    }

    let count = 0;
    for (const p of active) {
      if (++count % 50 === 0) { if (onProgress) onProgress(count / active.length); await yieldToUI(); }
      let phase = p.phase;
      const ratio = pitchMap ? pitchMap(p.fi, p.freq) : 1.0;
      const f = p.freq * ratio;
      const inc = 2 * Math.PI * f / sampleRate;
      const a = p.amp;
      for (let i = 0; i < totalSamples; i++) {
        out[i] += a * Math.sin(phase);
        phase += inc;
      }
    }
    this._normalize(out, 0.9);
    if (onProgress) onProgress(1.0);
    return out;
  }

  _normalize(out, target) {
    let peak = 0;
    for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
    if (peak > 1e-6) { const k = target / peak; for (let i = 0; i < out.length; i++) out[i] *= k; }
  }
}
function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }