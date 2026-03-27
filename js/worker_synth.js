'use strict';
/**
 * worker_synth.js — Web Worker for Additive Resynthesis
 * 
 * - Math.sin を廃止し、4096サイズの Wavetable を参照。
 * - Release (Rel) が指定された場合、元の Partial が途切れても最終セグメントの
 *   Sustain レベルを維持したままサイン波を延長し、プツ音を防ぐ。
 * - 生成された波形は ArrayBuffer として Transferable Object でメインスレッドへ返却。
 */

let sampleRate = 44100;
let hopSize = 512;

// 1. Wavetable (LUT) の初期化
const WAVE_TBL_SIZE = 4096;
const WAVE_TBL_MASK = WAVE_TBL_SIZE - 1;
const waveTable = new Float32Array(WAVE_TBL_SIZE);
for (let i = 0; i < WAVE_TBL_SIZE; i++) {
  waveTable[i] = Math.sin((i / WAVE_TBL_SIZE) * 2 * Math.PI);
}

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
      const actualEndSec = durationSec !== null ? (startSec + durationSec) : endSec;
      const endFrame = Math.max(startFrame + 1, Math.min(numFrames - 1, Math.round(actualEndSec * sampleRate / hopSize)));

      let outBuffer;

      // 0.0倍 (Freeze) の処理
      if (speed <= 0.001) {
        const durSec = durationSec || 10.0;
        const totalSamples = Math.floor(durSec * sampleRate);
        outBuffer = new Float64Array(totalSamples);
        
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

        const phaseMult = WAVE_TBL_SIZE / sampleRate;
        for (let i = 0; i < active.length; i++) {
          const p = active[i];
          const ratio = pitchRatioArr[p.fi] || 1.0;
          const f = Math.min(p.freq * ratio, sampleRate * 0.49);
          // 位相増分をインデックス幅に変換
          const inc = f * phaseMult;
          const a = p.amp;
          
          let phaseIdx = (p.phase / (2 * Math.PI)) * WAVE_TBL_SIZE;
          if (phaseIdx < 0) phaseIdx += WAVE_TBL_SIZE;

          for (let s = 0; s < totalSamples; s++) {
            outBuffer[s] += a * waveTable[Math.floor(phaseIdx) & WAVE_TBL_MASK];
            phaseIdx += inc;
          }
        }

      // 通常 (Time-Stretch) の処理
      } else {
        const framesToProcess = endFrame - startFrame;
        if (framesToProcess <= 0) {
          self.postMessage({ type: 'DONE', buffer: new ArrayBuffer(0) });
          return;
        }

        const outFrames = Math.floor(framesToProcess / speed);
        const releaseSec = adsr ? (adsr.r / 1000.0) : 0;
        const releaseSamples = Math.ceil(releaseSec * sampleRate);
        const totalSamples = (outFrames + 4) * hopSize + releaseSamples;
        
        outBuffer = new Float64Array(totalSamples);
        
        const nyq = sampleRate * 0.49;
        const phaseMult = WAVE_TBL_SIZE / sampleRate;
        
        // 進捗報告用のバッチサイズ
        const BATCH = Math.max(1, Math.floor(partials.length / 20));

        for (let i = 0; i < partials.length; i++) {
          if (i % BATCH === 0) self.postMessage({ type: 'PROGRESS', value: i / partials.length });
          
          const segs = partials[i].segs;
          if (segs.length < 2) continue;
          
          // 位相をラジアンから 0〜4095 のインデックス空間へ変換
          let phaseIdx = ((segs[0].phase || 0) / (2 * Math.PI)) * WAVE_TBL_SIZE;
          if (phaseIdx < 0) phaseIdx += WAVE_TBL_SIZE;
          
          let lastWrittenSample = 0;
          let lastFreq = 0;
          let lastAmp = 0;

          for (let j = 0; j < segs.length - 1; j++) {
            const s1 = segs[j], s2 = segs[j + 1];

            // 開始フレームより前は位相だけ進める
            if (s2.fi < startFrame) {
              const durSamples = s2.fi - s1.fi;
              const avgF = (s1.freq + s2.freq) * 0.5;
              phaseIdx += avgF * phaseMult * durSamples * hopSize;
              continue;
            }
            if (s1.fi > endFrame) break;

            const r1 = pitchRatioArr[s1.fi] || 1.0;
            const r2 = pitchRatioArr[s2.fi] || 1.0;
            const f1 = Math.min(s1.freq * r1, nyq);
            const f2 = Math.min(s2.freq * r2, nyq);
            const a1 = s1.amp;
            const a2 = s2.amp;

            const frameSpan = (s2.fi - s1.fi) / speed;
            const durSamples = Math.floor(frameSpan * hopSize);
            if (durSamples <= 0) continue;

            if (a1 === 0 && a2 === 0) {
              phaseIdx += f1 * phaseMult * durSamples;
              continue;
            }

            const relativeFrame = s1.fi - startFrame;
            const baseIdx = Math.max(0, Math.floor(relativeFrame / speed * hopSize));
            const invD = 1.0 / durSamples;

            // 線形補間用の増分
            const fStep = (f2 - f1) * invD;
            const aStep = (a2 - a1) * invD;
            
            let currF = f1;
            let currA = a1;

            for (let s = 0; s < durSamples; s++) {
              const idx = baseIdx + s;
              if (idx >= 0 && idx < totalSamples) {
                outBuffer[idx] += currA * waveTable[Math.floor(phaseIdx) & WAVE_TBL_MASK];
                lastWrittenSample = idx;
                lastFreq = currF;
                lastAmp = currA;
              }
              phaseIdx += currF * phaseMult;
              currF += fStep;
              currA += aStep;
            }
          }

          // ★ 修正: Release (Rel) のプツ音防止
          // 波形が途切れた場合でも、Release区間の最後までSustainレベル(lastAmp)でサイン波を延長する
          if (adsr && lastWrittenSample > 0) {
            const requiredEndSample = totalSamples - 1; // Releaseの末尾
            if (lastWrittenSample < requiredEndSample && lastAmp > 1e-5) {
              const extendSamples = requiredEndSample - lastWrittenSample;
              const inc = lastFreq * phaseMult;
              for (let s = 1; s <= extendSamples; s++) {
                const idx = lastWrittenSample + s;
                if (idx < totalSamples) {
                  outBuffer[idx] += lastAmp * waveTable[Math.floor(phaseIdx) & WAVE_TBL_MASK];
                }
                phaseIdx += inc;
              }
            }
          }
        }
      }

      // ADSR エンベロープの適用
      if (adsr) {
        const aSamples = Math.floor((adsr.a / 1000) * sampleRate);
        const dSamples = Math.floor((adsr.d / 1000) * sampleRate);
        const rSamples = Math.floor((adsr.r / 1000) * sampleRate);
        const susLevel = adsr.s / 100.0;

        const totalLen = outBuffer.length;
        const sustainEnd = Math.max(0, totalLen - rSamples);

        for (let i = 0; i < totalLen; i++) {
          let env = 0.0;
          if (i < aSamples) {
            env = i / Math.max(1, aSamples);
          } else if (i < aSamples + dSamples) {
            const dt = (i - aSamples) / Math.max(1, dSamples);
            env = 1.0 - (1.0 - susLevel) * dt;
          } else if (i < sustainEnd) {
            env = susLevel;
          } else {
            const rt = (i - sustainEnd) / Math.max(1, rSamples);
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
      
      // Transferable Objects として ArrayBuffer ごと渡す (ゼロコピー)
      self.postMessage({ type: 'DONE', buffer: outBuffer.buffer }, [outBuffer.buffer]);

    } catch (err) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
  }
};