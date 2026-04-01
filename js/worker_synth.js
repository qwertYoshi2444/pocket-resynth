'use strict';
/**
 * worker_synth.js — Web Worker for High Precision Additive & Residual Synthesis
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
      const { partials, numFrames, pitchRatioArr, speed, startSec, endSec, adsr, durationSec, noiseAmount, whiteNoise } = msg;
      
      const noiseScale = (noiseAmount !== undefined) ? Math.max(0, noiseAmount) : 1.0;
      const wn = whiteNoise || { amount: 0, loCut: 200, hiCut: 8000 };
      
      const startFrame = Math.max(0, Math.min(numFrames - 1, Math.round(startSec * sampleRate / hopSize)));
      
      const reqDurationSec = durationSec !== null ? durationSec : Math.max(0.1, endSec - startSec);
      const reqBaseSamples = Math.floor(reqDurationSec * sampleRate);

      const releaseSec = adsr ? (adsr.r / 1000.0) : 0;
      const releaseSamples = Math.ceil(releaseSec * sampleRate);
      
      const totalSamples = reqBaseSamples + releaseSamples;
      let outBuffer = new Float64Array(totalSamples);
      const twoPi = 2 * Math.PI;

      // Noise Phase Randomization 用
      const noiseBandwidthFactor = 0.5;

      // ==========================================
      // 0.0倍 (Freeze) の処理: 前後フレームの平均化
      // ==========================================
      if (speed <= 0.001) {
        const active = new Map();
        
        // startFrame 前後 ±1 フレームを集計して平均化
        for (let i = 0; i < partials.length; i++) {
          const segs = partials[i].segs;
          let sumFreq = 0, sumAmp = 0, count = 0;
          for (let j = 0; j < segs.length; j++) {
            if (Math.abs(segs[j].fi - startFrame) <= 1 && segs[j].amp > 1e-5) {
              sumFreq += segs[j].freq;
              sumAmp += segs[j].amp;
              count++;
            }
          }
          if (count > 0) {
            active.set(i, { p: partials[i], freq: sumFreq / count, amp: sumAmp / count });
          }
        }

        const ratio = pitchRatioArr[startFrame] || 1.0;

        for (const item of active.values()) {
          const isNoise = item.p.isNoise;
          const f = Math.min(item.freq * ratio, sampleRate * 0.49);
          const inc = twoPi * f / sampleRate;
          const a = item.amp * (isNoise ? noiseScale : 1.0);
          
          let phase = Math.random() * twoPi; // フリーズ時は初期位相ランダム化で自然さを出す
          const phaseJitter = isNoise ? (twoPi * f * noiseBandwidthFactor / sampleRate) : 0;

          for (let s = 0; s < totalSamples; s++) {
            // ノイズ成分は振幅にも微小なランダム変調をかける (AM変調)
            const currentA = isNoise ? a * (0.5 + Math.random()) : a;
            outBuffer[s] += currentA * Math.sin(phase);
            phase += inc;
            if (isNoise) phase += (Math.random() * 2 - 1) * phaseJitter;
            if (phase > Math.PI) phase -= twoPi;
            else if (phase < -Math.PI) phase += twoPi;
          }
        }

      // ==========================================
      // 通常 (Time-Stretch) の処理
      // ==========================================
      } else {
        const nyq = sampleRate * 0.49;
        const BATCH = Math.max(1, Math.floor(partials.length / 20));

        for (let i = 0; i < partials.length; i++) {
          if (i % BATCH === 0) self.postMessage({ type: 'PROGRESS', value: i / partials.length });
          
          const p = partials[i];
          const isNoise = p.isNoise;
          const segs = p.segs;
          if (segs.length < 2) continue;
          
          let phase = segs[0].phase || 0;
          let lastWrittenSample = -1;
          let lastFreq = 0;
          let lastAmp = 0;

          for (let j = 0; j < segs.length - 1; j++) {
            const s1 = segs[j], s2 = segs[j + 1];

            const s1OutTime = (s1.fi - startFrame) * hopSize / sampleRate / speed;
            const s2OutTime = (s2.fi - startFrame) * hopSize / sampleRate / speed;
            
            const startSample = Math.floor(s1OutTime * sampleRate);
            const endSample = Math.floor(s2OutTime * sampleRate);

            if (endSample < 0) {
              const durSamples = s2.fi - s1.fi; 
              const avgF = (s1.freq + s2.freq) * 0.5;
              phase += twoPi * avgF / sampleRate * durSamples * hopSize;
              while (phase > Math.PI) phase -= twoPi;
              while (phase < -Math.PI) phase += twoPi;
              continue;
            }
            if (startSample >= reqBaseSamples) break;

            const r1 = pitchRatioArr[s1.fi] || 1.0;
            const r2 = pitchRatioArr[s2.fi] || 1.0;
            const f1 = Math.min(s1.freq * r1, nyq);
            const f2 = Math.min(s2.freq * r2, nyq);
            const ampScale = isNoise ? noiseScale : 1.0;
            const a1 = s1.amp * ampScale;
            const a2 = s2.amp * ampScale;

            const writeStart = Math.max(0, startSample);
            const writeEnd = Math.min(reqBaseSamples, endSample);
            const durSamples = endSample - startSample;

            if (durSamples <= 0) continue;

            const invD = 1.0 / durSamples;
            const fStep = (f2 - f1) * invD;
            const aStep = (a2 - a1) * invD;
            
            let currF = f1 + fStep * (writeStart - startSample);
            let currA = a1 + aStep * (writeStart - startSample);

            // 位相補正 (ピッチシフトがほとんど無いTonal成分の場合のみ、目標位相へ着地させる)
            let phaseCorrectionOffset = 0;
            if (!isNoise && Math.abs(r1 - 1.0) < 0.01 && Math.abs(r2 - 1.0) < 0.01) {
              const expectedPhaseEnd = phase + twoPi * (f1 + f2) * 0.5 * durSamples / sampleRate;
              const targetPhase = s2.phase;
              let phaseDiff = (targetPhase - expectedPhaseEnd) % twoPi;
              if (phaseDiff > Math.PI) phaseDiff -= twoPi;
              if (phaseDiff < -Math.PI) phaseDiff += twoPi;
              phaseCorrectionOffset = phaseDiff / durSamples; // 1サンプルあたりの位相補正量
            }

            for (let s = writeStart; s < writeEnd; s++) {
              if (s >= 0 && s < totalSamples) {
                // ノイズ成分は振幅をサンプル単位で少し揺らす
                const modA = isNoise ? currA * (0.5 + Math.random()) : currA;
                outBuffer[s] += modA * Math.sin(phase);
                
                lastWrittenSample = s;
                lastFreq = currF;
                lastAmp = currA;
              }
              
              // 基本の周波数インクリメント + 位相ズレ補正
              let stepPhase = twoPi * currF / sampleRate + phaseCorrectionOffset;
              phase += stepPhase;
              
              if (isNoise) {
                const jitter = twoPi * currF * noiseBandwidthFactor / sampleRate;
                phase += (Math.random() * 2 - 1) * jitter;
              }

              if (phase > Math.PI) phase -= twoPi;
              else if (phase < -Math.PI) phase += twoPi;
              
              currF += fStep;
              currA += aStep;
            }
            
            // フレーム終了時に解析位相に強制スナップ (補正できなかった余剰分をリセット)
            if (!isNoise && Math.abs(r2 - 1.0) < 0.01) {
              phase = s2.phase;
            }
          }

          // フリーズ＆リリース延長
          if (lastWrittenSample >= 0 && lastAmp > 1e-5) {
            const extendSamples = totalSamples - 1 - lastWrittenSample;
            const inc = twoPi * lastFreq / sampleRate;
            const jitter = isNoise ? (twoPi * lastFreq * noiseBandwidthFactor / sampleRate) : 0;
            
            for (let s = 1; s <= extendSamples; s++) {
              const idx = lastWrittenSample + s;
              if (idx < totalSamples) {
                const modA = isNoise ? lastAmp * (0.5 + Math.random()) : lastAmp;
                outBuffer[idx] += modA * Math.sin(phase);
              }
              phase += inc;
              if (isNoise) phase += (Math.random() * 2 - 1) * jitter;
              if (phase > Math.PI) phase -= twoPi;
              else if (phase < -Math.PI) phase += twoPi;
            }
          }
        }
      }

      // ==========================================
      // White Noise Generation
      // ==========================================
      if (wn.amount > 0.001) {
        const wnAmp = wn.amount;
        const twoPiSr = twoPi / sampleRate;
        const loCut = Math.max(20, Math.min(wn.loCut, sampleRate * 0.48));
        const hiCut = Math.max(loCut + 10, Math.min(wn.hiCut, sampleRate * 0.49));

        const alphaHP = 1.0 / (1.0 + twoPiSr * loCut);
        const alphaLP = twoPiSr * hiCut / (1.0 + twoPiSr * hiCut);

        let yHP = 0, yLP = 0, xPrev = 0;

        for (let s = 0; s < totalSamples; s++) {
          const raw = Math.random() * 2 - 1;
          yHP = alphaHP * (yHP + raw - xPrev);
          xPrev = raw;
          yLP = alphaLP * yHP + (1.0 - alphaLP) * yLP;
          outBuffer[s] += yLP * wnAmp;
        }
      }

      // ==========================================
      // ADSR エンベロープ
      // ==========================================
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
            const rt = (i - reqBaseSamples) / Math.max(1, releaseSamples);
            env = susLevel * (1.0 - rt);
            if (env < 0) env = 0;
          }
          outBuffer[i] *= env;
        }
      }

      // ==========================================
      // ソフトクリッパー (正規化の撤廃)
      // ==========================================
      // ハードなピークノーマライズを廃止し、ヘッドルーム(0.5倍)を持たせた上で、
      // 歪みを抑えつつ安全に-1〜1に収める Soft Clipper (tanh) を適用。
      const headroom = 0.5;
      for (let i = 0; i < outBuffer.length; i++) {
        outBuffer[i] = Math.tanh(outBuffer[i] * headroom);
      }

      self.postMessage({ type: 'PROGRESS', value: 1.0 });
      self.postMessage({ type: 'DONE', buffer: outBuffer.buffer }, [outBuffer.buffer]);

    } catch (err) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
  }
};