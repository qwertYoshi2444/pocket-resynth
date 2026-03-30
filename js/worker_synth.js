'use strict';
/**
 * worker_synth.js — Web Worker for High Precision Additive Resynthesis
 * 
 * - 出力WAVの長さは指定された絶対時間（durationSec あるいは endSec - startSec）に固定。
 * - Playback Speed は「オシレータの波形がどれだけ速く進むか」のみに影響するよう分離。
 * - タイムストレッチ時の計算を絶対出力サンプルインデックス基準に改修し、ドロップアウト(隙間)を排除。
 * - ADSRエンベロープは最後に、絶対時間のサンプル数に対して正確に適用。
 */

let sampleRate = 44100;
let hopSize = 512;

self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'INIT') {
    sampleRate = msg.sampleRate;
    hopSize = msg.hopSize;
    return;
  }

  if (msg.type === 'SYNTHESIZE') {
    try {
      const { partials, numFrames, pitchRatioArr, speed, startSec, endSec, adsr, durationSec } = msg;
      
      const startFrame = Math.max(0, Math.min(numFrames - 1, Math.round(startSec * sampleRate / hopSize)));
      
      // 出力される基本波形の長さを秒で確定（Speedに依存しない）
      const reqDurationSec = durationSec !== null ? durationSec : Math.max(0.1, endSec - startSec);
      const reqBaseSamples = Math.floor(reqDurationSec * sampleRate);

      // リリース時間（Speedに依存しない）
      const releaseSec = adsr ? (adsr.r / 1000.0) : 0;
      const releaseSamples = Math.ceil(releaseSec * sampleRate);
      
      const totalSamples = reqBaseSamples + releaseSamples;
      let outBuffer = new Float64Array(totalSamples);
      const twoPi = 2 * Math.PI;

      // 0.0倍 (Freeze) の処理
      if (speed <= 0.001) {
        const active = [];
        for (let i = 0; i < partials.length; i++) {
          const segs = partials[i].segs;
          for (let j = 0; j < segs.length; j++) {
            if (Math.abs(segs[j].fi - startFrame) <= 2 && segs[j].amp > 1e-4) {
              active.push(segs[j]);
              break;
            }
          }
        }

        for (let i = 0; i < active.length; i++) {
          const p = active[i];
          const ratio = pitchRatioArr[p.fi] || 1.0;
          const f = Math.min(p.freq * ratio, sampleRate * 0.49);
          const inc = twoPi * f / sampleRate;
          const a = p.amp;
          
          let phase = p.phase;
          for (let s = 0; s < totalSamples; s++) {
            outBuffer[s] += a * Math.sin(phase);
            phase += inc;
            if (phase > Math.PI) phase -= twoPi;
          }
        }

      // 通常 (Time-Stretch) の処理
      } else {
        const nyq = sampleRate * 0.49;
        const BATCH = Math.max(1, Math.floor(partials.length / 20));

        for (let i = 0; i < partials.length; i++) {
          if (i % BATCH === 0) self.postMessage({ type: 'PROGRESS', value: i / partials.length });
          
          const segs = partials[i].segs;
          if (segs.length < 2) continue;
          
          let phase = segs[0].phase || 0;
          let lastWrittenSample = -1;
          let lastFreq = 0;
          let lastAmp = 0;

          // 絶対出力サンプルインデックス基準のループ
          for (let j = 0; j < segs.length - 1; j++) {
            const s1 = segs[j], s2 = segs[j + 1];

            // 現在のセグメントが出力時間にマッピングされる開始・終了サンプル
            // speed > 1 なら早く終わり、speed < 1 なら遅く終わる
            const s1OutTime = (s1.fi - startFrame) * hopSize / sampleRate / speed;
            const s2OutTime = (s2.fi - startFrame) * hopSize / sampleRate / speed;
            
            const startSample = Math.floor(s1OutTime * sampleRate);
            const endSample = Math.floor(s2OutTime * sampleRate);

            if (endSample < 0) {
              // 再生開始前のセグメント（位相だけ進める）
              const durSamples = s2.fi - s1.fi; // オリジナル時間ベースで進める
              const avgF = (s1.freq + s2.freq) * 0.5;
              phase += twoPi * avgF / sampleRate * durSamples * hopSize;
              while (phase > Math.PI) phase -= twoPi;
              while (phase < -Math.PI) phase += twoPi;
              continue;
            }
            if (startSample >= reqBaseSamples) {
              // 要求された波形長を超えた場合は描画ストップ
              break;
            }

            const r1 = pitchRatioArr[s1.fi] || 1.0;
            const r2 = pitchRatioArr[s2.fi] || 1.0;
            const f1 = Math.min(s1.freq * r1, nyq);
            const f2 = Math.min(s2.freq * r2, nyq);
            const a1 = s1.amp;
            const a2 = s2.amp;

            const writeStart = Math.max(0, startSample);
            const writeEnd = Math.min(reqBaseSamples, endSample);
            const durSamples = endSample - startSample;

            if (durSamples <= 0) continue;

            const invD = 1.0 / durSamples;
            const fStep = (f2 - f1) * invD;
            const aStep = (a2 - a1) * invD;
            
            let currF = f1 + fStep * (writeStart - startSample);
            let currA = a1 + aStep * (writeStart - startSample);

            for (let s = writeStart; s < writeEnd; s++) {
              if (s >= 0 && s < totalSamples) {
                outBuffer[s] += currA * Math.sin(phase);
                lastWrittenSample = s;
                lastFreq = currF;
                lastAmp = currA;
              }
              phase += twoPi * currF / sampleRate;
              if (phase > Math.PI) phase -= twoPi;
              
              currF += fStep;
              currA += aStep;
            }
          }

          // フリーズ延長（Playback Speed が速すぎて指定時間より前に波形が尽きた場合）
          // ＆ リリース領域 (reqBaseSamples以降) への延長
          if (lastWrittenSample >= 0 && lastAmp > 1e-5) {
            const extendSamples = totalSamples - 1 - lastWrittenSample;
            const inc = twoPi * lastFreq / sampleRate;
            for (let s = 1; s <= extendSamples; s++) {
              const idx = lastWrittenSample + s;
              if (idx < totalSamples) {
                outBuffer[idx] += lastAmp * Math.sin(phase);
              }
              phase += inc;
              if (phase > Math.PI) phase -= twoPi;
            }
          }
        }
      }

      // ADSR エンベロープの適用（絶対時間に対して適用）
      if (adsr) {
        const aSamples = Math.floor((adsr.a / 1000) * sampleRate);
        const dSamples = Math.floor((adsr.d / 1000) * sampleRate);
        const susLevel = adsr.s / 100.0;

        for (let i = 0; i < totalSamples; i++) {
          let env = 0.0;
          if (i < aSamples) {
            env = i / Math.max(1, aSamples);
          } else if (i < aSamples + dSamples) {
            const dt = (i - aSamples) / Math.max(1, dSamples);
            env = 1.0 - (1.0 - susLevel) * dt;
          } else if (i < reqBaseSamples) {
            env = susLevel;
          } else {
            // リリース区間
            const rt = (i - reqBaseSamples) / Math.max(1, releaseSamples);
            env = susLevel * (1.0 - rt);
            if (env < 0) env = 0;
          }
          outBuffer[i] *= env;
        }
      }

      // 正規化 (ピークを 0.9 に合わせる)
      let peak = 0;
      for (let i = 0; i < outBuffer.length; i++) {
        const a = Math.abs(outBuffer[i]);
        if (a > peak) peak = a;
      }
      if (peak > 1e-6) {
        const k = 0.9 / peak;
        for (let i = 0; i < outBuffer.length; i++) outBuffer[i] *= k;
      }

      self.postMessage({ type: 'PROGRESS', value: 1.0 });
      self.postMessage({ type: 'DONE', buffer: outBuffer.buffer }, [outBuffer.buffer]);

    } catch (err) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
  }
};