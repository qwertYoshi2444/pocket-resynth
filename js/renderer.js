'use strict';
/**
 * renderer.js — Canvas Visualization Engine
 */
class SpectralRenderer {
  constructor({ spectrogramCanvas, partialCanvas, uiCanvas, waveformCanvas }) {
    this.specC = spectrogramCanvas;
    this.partC = partialCanvas;
    this.uiC   = uiCanvas;
    this.waveC = waveformCanvas;

    this.analysis  = null;
    this.audioData = null;

    this.viewStart = 0;
    this.viewEnd   = 1;
    this.freqMin   = 20;
    this.freqMax   = 20000;
    this.playhead  = 0;

    // Vocal Mode states
    this.appMode = 'synth';
    this.f0Data = null;       // Original F0 Float32Array
    this.editedF0 = null;     // User override Float32Array
    this.isSnapMode = true;
    this.showOrigF0 = true;

    this._colormap = this._buildColormap();
    this._bindEvents();
  }

  setAnalysis(analysis, audioData) {
    this.analysis  = analysis;
    this.audioData = audioData;
    this.viewStart = 0;
    this.viewEnd   = analysis.duration;
    this.renderAll();
  }

  setPlayhead(t) {
    this.playhead = t;
    this._drawUI();
  }

  renderAll() {
    this._drawWaveform();
    this._drawSpectrogram();
    this._drawPartials();
    this._drawUI();
  }

  // -----------------------------------------------------------------------
  // Renderers (Waveform, Spectrogram, Partials) -> Existing
  // -----------------------------------------------------------------------
  _drawWaveform() {
    const cv = this.waveC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.fillStyle = '#0d1117'; cx.fillRect(0, 0, W, H);
    if (!this.audioData) return;

    const sr = this.analysis ? this.analysis.sampleRate : 44100;
    const s0 = Math.floor(this.viewStart * sr);
    const span = Math.ceil((this.viewEnd - this.viewStart) * sr);

    cx.strokeStyle = '#1db954'; cx.lineWidth = 1; cx.beginPath();
    for (let xi = 0; xi < W; xi++) {
      const a = s0 + Math.floor(xi / W * span);
      const b = s0 + Math.floor((xi + 1) / W * span);
      let mn = 0, mx = 0;
      for (let s = a; s < b && s < this.audioData.length; s++) {
        const v = this.audioData[s];
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      const y0 = H / 2 - mx * (H / 2 - 2);
      const y1 = H / 2 - mn * (H / 2 - 2);
      if (xi === 0) cx.moveTo(xi, (y0 + y1) / 2); else { cx.lineTo(xi, y0); cx.lineTo(xi, y1); }
    }
    cx.stroke();

    cx.strokeStyle = 'rgba(255,255,255,0.08)';
    cx.beginPath(); cx.moveTo(0, H/2); cx.lineTo(W, H/2); cx.stroke();
  }

  _drawSpectrogram() {
    const cv = this.specC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
    if (!this.analysis || !this.analysis.spectrogram) return;

    const { spectrogram, spectFreqs, sampleRate, hopSize } = this.analysis;
    const img = cx.createImageData(W, H);
    const pix = img.data;
    
    let gMax = 0;
    for (const band of spectrogram) for (const v of band) if (v > gMax) gMax = v;
    if (gMax < 1e-10) return;

    for (let xi = 0; xi < W; xi++) {
      const t = this.viewStart + (xi / W) * (this.viewEnd - this.viewStart);
      const fi = Math.round(t * sampleRate / hopSize);
      if (fi < 0 || fi >= spectrogram.length) continue;
      const band = spectrogram[fi];

      for (let yi = 0; yi < H; yi++) {
        const freq = this._yToFreq(yi, H);
        let bi = this._nearestBandIdx(freq, spectFreqs);
        const amp = band[bi] / gMax;
        const [r, g, b] = this._ampToRGB(amp);
        const p = (yi * W + xi) * 4;
        pix[p] = r; pix[p+1] = g; pix[p+2] = b; pix[p+3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    this._drawFreqGrid(cx, W, H);
  }

  _nearestBandIdx(freq, bands) {
    let lo = 0, hi = bands.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bands[mid] < freq) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(bands[lo-1]-freq) < Math.abs(bands[lo]-freq)) lo--;
    return lo;
  }

  _drawFreqGrid(cx, W, H) {
    const labels = [50,100,200,500,1000,2000,5000,10000,20000];
    cx.font = '10px monospace'; cx.textAlign = 'left';
    for (const f of labels) {
      if (f < this.freqMin || f > this.freqMax) continue;
      const y = this._freqToY(f, H);
      cx.strokeStyle = 'rgba(255,255,255,0.07)'; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(0, y); cx.lineTo(W, y); cx.stroke();
      cx.fillStyle = 'rgba(255,255,255,0.4)';
      cx.fillText(f >= 1000 ? `${f/1000}k` : `${f}`, 3, y - 2);
    }
  }

  _drawPartials() {
    const cv = this.partC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);
    if (!this.analysis || !this.analysis.partials) return;

    const { partials, hopSize, sampleRate } = this.analysis;

    for (const p of partials) {
      const hue = (p.id * 137.508) % 360;
      cx.strokeStyle = `hsla(${hue},75%,60%,0.4)`;
      cx.lineWidth = 1.0;
      cx.beginPath();
      let penDown = false;

      for (const seg of p.segs) {
        if (seg.amp < 1e-5) { penDown = false; continue; }
        const t = seg.fi * hopSize / sampleRate;
        const x = this._timeToX(t, W);
        const y = this._freqToY(seg.freq, H);
        if (!penDown) { cx.moveTo(x, y); penDown = true; } else cx.lineTo(x, y);
      }
      cx.stroke();
    }
  }

  // -----------------------------------------------------------------------
  // UI Overlay (Playhead, F0 Curve)
  // -----------------------------------------------------------------------
  _drawUI() {
    const cv = this.uiC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);

    // Playhead
    if (this.playhead >= this.viewStart && this.playhead <= this.viewEnd) {
      const xp = this._timeToX(this.playhead, W);
      cx.strokeStyle = '#ff4444'; cx.lineWidth = 1.5;
      cx.beginPath(); cx.moveTo(xp, 0); cx.lineTo(xp, H); cx.stroke();
      cx.fillStyle = '#ff4444';
      cx.beginPath(); cx.moveTo(xp-5,0); cx.lineTo(xp+5,0); cx.lineTo(xp,10); cx.fill();
    }

    // F0 Curve (Vocal mode)
    if (this.appMode === 'vocal' && this.analysis && this.f0Data) {
      const { hopSize, sampleRate } = this.analysis;
      
      if (this.showOrigF0) {
        cx.strokeStyle = 'rgba(88, 166, 255, 0.6)';
        cx.lineWidth = 2; cx.setLineDash([4,4]);
        this._traceCurve(cx, this.f0Data, hopSize, sampleRate, W, H);
        cx.setLineDash([]);
      }
      if (this.editedF0) {
        cx.strokeStyle = '#ff4444'; cx.lineWidth = 3;
        this._traceCurve(cx, this.editedF0, hopSize, sampleRate, W, H);
      }
    }
  }

  _traceCurve(cx, f0Arr, hopSize, sampleRate, W, H) {
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

  // -----------------------------------------------------------------------
  // Interaction (Zoom & F0 Edit)
  // -----------------------------------------------------------------------
  _bindEvents() {
    const ui = this.uiC;
    let dragging = false;
    let prevX = 0;

    ui.addEventListener('mousedown', e => {
      dragging = true; prevX = e.offsetX;
      if (this.appMode === 'vocal') this._editF0(e.offsetX, e.offsetY, prevX, ui.width, ui.height);
    });

    ui.addEventListener('mousemove', e => {
      if (!dragging) return;
      if (this.appMode === 'vocal') {
        this._editF0(e.offsetX, e.offsetY, prevX, ui.width, ui.height);
        prevX = e.offsetX;
      }
    });

    ui.addEventListener('mouseup', () => { dragging = false; });
    ui.addEventListener('mouseleave', () => { dragging = false; });

    // Scroll to zoom
    ui.addEventListener('wheel', e => {
      e.preventDefault();
      const t     = this._xToTime(e.offsetX, ui.width);
      const span  = this.viewEnd - this.viewStart;
      const scale = e.deltaY > 0 ? 1.15 : 0.87;
      const newSpan = Math.max(0.05, Math.min(this.analysis ? this.analysis.duration : 60, span * scale));
      this.viewStart = Math.max(0, t - (t - this.viewStart) / span * newSpan);
      this.viewEnd   = this.viewStart + newSpan;
      if (this.analysis && this.viewEnd > this.analysis.duration) this.viewEnd = this.analysis.duration;
      this.renderAll();
    }, { passive: false });
  }

  _editF0(x, y, pX, W, H) {
    if (!this.analysis || !this.f0Data) return;
    if (!this.editedF0) this.editedF0 = new Float32Array(this.f0Data);

    const { hopSize, sampleRate } = this.analysis;
    let freq = this._yToFreq(y, H);

    if (this.isSnapMode) {
      // スナップ: 12平均律の周波数に吸着
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

  // -----------------------------------------------------------------------
  // Coordinates & Colors
  // -----------------------------------------------------------------------
  _freqToY(f, H) { const lm = Math.log2(this.freqMin), lM = Math.log2(this.freqMax); return H - (Math.log2(Math.max(f, this.freqMin)) - lm) / (lM - lm) * H; }
  _yToFreq(y, H) { const lm = Math.log2(this.freqMin), lM = Math.log2(this.freqMax); return Math.pow(2, lm + (1 - y / H) * (lM - lm)); }
  _timeToX(t, W) { return (t - this.viewStart) / (this.viewEnd - this.viewStart) * W; }
  _xToTime(x, W) { return this.viewStart + x / W * (this.viewEnd - this.viewStart); }

  _buildColormap() {
    return [
      [0,0,4],[20,11,52],[58,9,99],[96,19,110],[133,33,107],[169,46,94],
      [203,65,73],[229,89,52],[247,121,23],[252,165,10],[244,204,71],[252,255,164]
    ];
  }
  _ampToRGB(t) {
    t = Math.max(0, Math.min(1, Math.pow(t, 0.45)));
    const cm = this._colormap, n = cm.length - 1;
    const pos = t * n, i0 = Math.floor(pos), i1 = Math.min(i0+1, n), f = pos - i0;
    const c0 = cm[i0], c1 = cm[i1];
    return [ c0[0]+(c1[0]-c0[0])*f|0, c0[1]+(c1[1]-c0[1])*f|0, c0[2]+(c1[2]-c0[2])*f|0 ];
  }
}