'use strict';
/**
 * synthesis.js — Web Worker Wrapper for Additive Resynthesis
 * 実際の波形加算処理は 'worker_synth.js' に移譲し、メインスレッドのブロックを防ぎます。
 */
class AdditiveSynthesizer {
  constructor(sampleRate, hopSize) {
    this.sampleRate = sampleRate;
    this.hopSize    = hopSize;
    // Workerの生成 (同一ディレクトリ内)
    this.worker = new Worker('js/worker_synth.js');
    
    // 初期化パラメータの送信
    this.worker.postMessage({
      type: 'INIT',
      sampleRate: this.sampleRate,
      hopSize: this.hopSize
    });
  }

  /**
   * @param {object}   analysis    解析データ
   * @param {Function} pitchMap    (fi, freq) -> ratio を返す関数。Workerには配列化して送る必要があるため事前に計算。
   * @param {number}   speed       再生速度 (0.0 = Freeze)
   * @param {number}   startSec    開始時間(秒)
   * @param {number}   endSec      終了時間(秒)
   * @param {object}   adsr        {a, d, s, r} ms単位
   * @param {number}   durationSec MIDI用ノート長(指定時はendSecを上書き)
   * @param {Function} onProgress  進捗コールバック (0.0 ~ 1.0)
   */
  synthesize(analysis, pitchMap, speed = 1.0, startSec = 0, endSec = 0, adsr = null, durationSec = null, onProgress = null) {
    return new Promise((resolve, reject) => {
      // 1. Workerに送れるように Partial データと PitchMap をシリアライズ
      const { partials, numFrames } = analysis;
      
      // PitchMap はシリアライズ不可能な関数なので、各フレームのベースとなる比率配列に変換
      // ※簡略化のため、freq に依存しないベースのピッチ比率 (GlobalShift + EditedF0) のみを渡す
      const pitchRatioArr = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        pitchRatioArr[i] = pitchMap(i, 440); // 基準周波数として440Hzを渡して比率を取得
      }

      // 2. メッセージハンドラの登録
      this.worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'PROGRESS') {
          if (onProgress) onProgress(msg.value);
        } else if (msg.type === 'DONE') {
          this.worker.onmessage = null; // リスナー解除
          this.worker.onerror = null;
          // Float64Array に復元して返す (Workerからは Float32Array で来る場合もあるためキャスト)
          const outBuffer = new Float64Array(msg.buffer);
          resolve(outBuffer);
        } else if (msg.type === 'ERROR') {
          this.worker.onmessage = null;
          this.worker.onerror = null;
          reject(new Error(msg.message));
        }
      };

      this.worker.onerror = (e) => {
        this.worker.onmessage = null;
        this.worker.onerror = null;
        reject(e);
      };

      // 3. Worker へジョブを送信
      this.worker.postMessage({
        type: 'SYNTHESIZE',
        partials: partials,         // structured clone で送られる
        numFrames: numFrames,
        pitchRatioArr: pitchRatioArr, // Float32Array (Transferable にはしない。使い回すため)
        speed: speed,
        startSec: startSec,
        endSec: endSec,
        adsr: adsr,
        durationSec: durationSec
      });
    });
  }
}