'use strict';
class SpectralRenderer {
  constructor(canvases) { /* 既存設定 */
    Object.assign(this, canvases);
    this.viewStart = 0; this.viewEnd = 1; this.freqMin = 20; this.freqMax = 20000;
    this.playhead = 0;
    
    // 歌わせモード用
    this.appMode = 'synth';
    this.f0Data = null;     // Float32Array (Original)
    this.editedF0 = null;   // Float32Array (User Edited)
    this.isSnapMode = true;
    this.showOrigF0 = true;
    
    this._bindEvents();
  }
  // (既存 _drawWaveform, _drawSpectrogram, _drawPartials はそのまま)

  renderAll() {
    this._drawWaveform(); this._drawSpectrogram(); this._drawPartials();
    this._drawUI(); // ここでF0カーブを描画する
  }

  _drawUI() {
    const cv = this.uiCanvas, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);

    // Playhead
    if (this.playhead >= this.viewStart && this.playhead <= this.viewEnd) {
      const xp = this._timeToX(this.playhead, W);
      cx.strokeStyle = '#ff4444'; cx.lineWidth = 1.5;
      cx.beginPath(); cx.moveTo(xp, 0); cx.lineTo(xp, H); cx.stroke();
    }

    // F0 Curve (Vocal Mode)
    if (this.appMode === 'vocal' && this.analysis && this.f0Data) {
      const { hopSize, sampleRate } = this.analysis;
      
      // Original F0 (破線)
      if (this.showOrigF0) {
        cx.strokeStyle = 'rgba(88, 166, 255, 0.5)'; cx.lineWidth = 2; cx.setLineDash([4,4]);
        this._traceF0Curve(cx, this.f0Data, hopSize, sampleRate, W, H);
        cx.setLineDash([]);
      }
      // Edited F0 (太線)
      if (this.editedF0) {
        cx.strokeStyle = '#ff4444'; cx.lineWidth = 3;
        this._traceF0Curve(cx, this.editedF0, hopSize, sampleRate, W, H);
      }
    }
  }

  _traceF0Curve(cx, f0Arr, hopSize, sampleRate, W, H) {
    cx.beginPath();
    let penDown = false;
    for (let fi = 0; fi < f0Arr.length; fi++) {
      const f = f0Arr[fi];
      if (f < 20) { penDown = false; continue; }
      const t = fi * hopSize / sampleRate;
      if (t < this.viewStart || t > this.viewEnd) continue;
      const x = this._timeToX(t, W);
      const y = this._freqToY(f, H);
      if (!penDown) { cx.moveTo(x, y); penDown = true; } else cx.lineTo(x, y);
    }
    cx.stroke();
  }

  _bindEvents() {
    const ui = this.uiCanvas;
    let dragging = false, prevX = 0;

    ui.addEventListener('mousedown', e => {
      dragging = true; prevX = e.offsetX;
      if (this.appMode === 'vocal') this._editF0(e.offsetX, e.offsetY, e.offsetX, ui.width, ui.height);
    });
    ui.addEventListener('mousemove', e => {
      if (!dragging) return;
      if (this.appMode === 'vocal') {
        this._editF0(e.offsetX, e.offsetY, prevX, ui.width, ui.height);
        prevX = e.offsetX;
      }
    });
    ui.addEventListener('mouseup', () => { dragging = false; });
  }

  // F0フリー/スナップ描画ロジック
  _editF0(x, y, pX, W, H) {
    if (!this.analysis || !this.f0Data) return;
    if (!this.editedF0) this.editedF0 = new Float32Array(this.f0Data);
    
    const { hopSize, sampleRate } = this.analysis;
    let freq = this._yToFreq(y, H);
    
    if (this.isSnapMode) {
      // 12平均律にスナップ
      const midi = 69 + 12 * Math.log2(freq / 440);
      freq = 440 * Math.pow(2, (Math.round(midi) - 69) / 12);
    }

    const t0 = this._xToTime(pX, W), t1 = this._xToTime(x, W);
    const fi0 = Math.round(t0 * sampleRate / hopSize);
    const fi1 = Math.round(t1 * sampleRate / hopSize);
    const sFi = Math.min(fi0, fi1), eFi = Math.max(fi0, fi1);

    for (let i = sFi; i <= eFi; i++) {
      if (i >= 0 && i < this.editedF0.length) this.editedF0[i] = freq;
    }
    this._drawUI();
  }
  
  // (座標変換ヘルパーは既存通り)
  _freqToY(f, H) { const lm = Math.log2(this.freqMin), lM = Math.log2(this.freqMax); return H - (Math.log2(Math.max(f, this.freqMin)) - lm) / (lM - lm) * H; }
  _yToFreq(y, H) { const lm = Math.log2(this.freqMin), lM = Math.log2(this.freqMax); return Math.pow(2, lm + (1 - y / H) * (lM - lm)); }
  _timeToX(t, W) { return (t - this.viewStart) / (this.viewEnd - this.viewStart) * W; }
  _xToTime(x, W) { return this.viewStart + x / W * (this.viewEnd - this.viewStart); }
}