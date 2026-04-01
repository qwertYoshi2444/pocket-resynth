'use strict';
/**
 * worker_synth.js — Web Worker for High Precision Additive & Residual Synthesis
 * 
 * - Deterministic (Peak) 加算合成に加え、
 * - Stochastic (Noise/Residual) 成分（高周波空気感）を位相ランダム化により帯域制限ノイズとして復元。
 * - 出力WAVの長さは指定された絶対時間に固定し、Playback Speedの影響から分離。
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

      // Noise Phase Randomization 用 (帯域幅の概算)
      const noiseBandwidthFactor = 0.5;

      // 0.0倍 (Freeze) の処理
      if (speed <= 0.001) {
        const active = [];
        for (let i = 0; i < partials.length; i++) {
          const segs = partials[i].segs;
          for (let j = 0; j < segs.length; j++) {
            if (Math.abs(segs[j].fi - startFrame) <= 2 && segs[j].amp > 1e-4) {
              active.push({ p: partials[i], seg: segs[j] });
              break;
            }
          }
        }

        for (let i = 0; i < active.length; i++) {
          const item = active[i];
          const seg = item.seg;
          const isNoise = item.p.isNoise;

          const ratio = pitchRatioArr[seg.fi] || 1.0;
          // ノイズ成分も一応ピッチシフトに追従させる
          const f = Math.min(seg.freq * ratio, sampleRate * 0.49);
          const inc = twoPi * f / sampleRate;
          const a = seg.amp * (isNoise ? noiseScale : 1.0);
          
          let phase = seg.phase;
          const phaseJitter = isNoise ? (twoPi * f * noiseBandwidthFactor / sampleRate) : 0;

          for (let s = 0; s < totalSamples; s++) {
            outBuffer[s] += a * Math.sin(phase);
            phase += inc;
            if (isNoise) phase += (Math.random() * 2 - 1) * phaseJitter;
            if (phase > Math.PI) phase -= twoPi;
            else if (phase < -Math.PI) phase += twoPi;
          }
        }

      // 通常 (Time-Stretch) の処理
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

            for (let s = writeStart; s < writeEnd; s++) {
              if (s >= 0 && s < totalSamples) {
                outBuffer[s] += currA * Math.sin(phase);
                lastWrittenSample = s;
                lastFreq = currF;
                lastAmp = currA;
              }
              phase += twoPi * currF / sampleRate;
              
              if (isNoise) {
                // ノイズ帯域幅に応じた位相ランダマイズ
                const jitter = twoPi * currF * noiseBandwidthFactor / sampleRate;
                phase += (Math.random() * 2 - 1) * jitter;
              }

              if (phase > Math.PI) phase -= twoPi;
              else if (phase < -Math.PI) phase += twoPi;
              
              currF += fStep;
              currA += aStep;
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
                outBuffer[idx] += lastAmp * Math.sin(phase);
              }
              phase += inc;
              if (isNoise) phase += (Math.random() * 2 - 1) * jitter;
              if (phase > Math.PI) phase -= twoPi;
              else if (phase < -Math.PI) phase += twoPi;
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────────────
      // White Noise Generation (bandpass via 1-pole HP + LP cascade)
      // ──────────────────────────────────────────────────────────────────
      if (wn.amount > 0.001) {
        const wnAmp = wn.amount;

        // 1-pole coefficients
        // High-pass: y_hp[n] = alpha_hp * (y_hp[n-1] + x[n] - x[n-1])
        // Low-pass:  y_lp[n] = alpha_lp * x[n] + (1 - alpha_lp) * y_lp[n-1]
        const twoPiSr = twoPi / sampleRate;
        const loCut = Math.max(20, Math.min(wn.loCut, sampleRate * 0.48));
        const hiCut = Math.max(loCut + 10, Math.min(wn.hiCut, sampleRate * 0.49));

        const alphaHP = 1.0 / (1.0 + twoPiSr * loCut);   // HP coefficient
        const alphaLP = twoPiSr * hiCut / (1.0 + twoPiSr * hiCut); // LP coefficient

        let yHP = 0, yLP = 0, xPrev = 0;

        // Apply ADSR envelope-shaped amplitude to white noise too
        for (let s = 0; s < totalSamples; s++) {
          const raw = Math.random() * 2 - 1;

          // High-pass
          yHP = alphaHP * (yHP + raw - xPrev);
          xPrev = raw;

          // Low-pass applied to HP output
          yLP = alphaLP * yHP + (1.0 - alphaLP) * yLP;

          outBuffer[s] += yLP * wnAmp;
        }
      }

      // ADSR エンベロープ
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