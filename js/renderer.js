'use strict';
/**
 * renderer.js — Canvas Visualization Engine
 * 
 * - Touch API 完全対応 (パン、ズーム、タップ/長押し選択)
 * - 高品質カラーテーマ (プロブルー & アンバー)
 */
class SpectralRenderer {
  constructor({ spectrogramCanvas, partialCanvas, uiCanvas, waveformCanvas }) {
    this.specC = spectrogramCanvas;
    this.partC = partialCanvas;
    this.uiC   = uiCanvas;
    this.waveC = waveformCanvas;
    this.waveUiC = document.getElementById('waveformUiCanvas');

    this.analysis  = null;
    this.audioData = null;

    this.viewStart = 0;
    this.viewEnd   = 1;
    this.freqMin   = 20;
    this.freqMax   = 20000;
    
    this.minFreqZoomRangeL = Math.log2(2); 
    
    this.playhead  = 0;
    this.startTime = 0;
    this.endTime   = 1; 

    // ピッチ編集用データ構造
    this.f0Data = null;     
    this.baseF0 = null;     
    this.editedF0 = null;   
    
    this.isSnapMode = true;
    this.showBaseF0 = true;
    this.editTarget = 'edited'; 
    this.isEraseMode = false;

    this.onSetStartTime = null;
    this.onSetEndTime   = null; 
    this.onViewChange   = null;

    this._colormap = this._buildColormap();
    this._bindEvents();
    this._bindWaveformEvents();
  }

  setAnalysis(analysis, audioData) {
    this.analysis  = analysis;
    this.audioData = audioData;
    this.viewStart = 0;
    if (analysis && analysis.duration) {
      this.viewEnd = analysis.duration;
      this.endTime = analysis.duration;
    }
    this.freqMin   = 20;
    this.freqMax   = 20000;
    this.startTime = 0;
    
    if (analysis && analysis.f0Data) {
      this.f0Data = analysis.f0Data;
      this.baseF0 = new Float32Array(this.f0Data);
      this.editedF0 = new Float32Array(this.f0Data.length);
    } else {
      this.f0Data = null;
      this.baseF0 = null;
      this.editedF0 = null;
    }
    
    this.renderAll();
  }

  setView(vs, ve, fm, fx) {
    this.viewStart = vs;
    this.viewEnd = ve;
    this.freqMin = fm;
    this.freqMax = fx;
    this.renderAll();
  }

  setPlayhead(t) {
    this.playhead = t;
    this._drawUI();
    this._drawWaveformUI();
  }

  renderAll() {
    this._drawWaveform();
    this._drawWaveformUI();
    this._drawSpectrogram();
    this._drawPartials();
    this._drawUI();
  }

  _drawWaveform() {
    const cv = this.waveC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.fillStyle = '#101217'; cx.fillRect(0, 0, W, H);
    if (!this.audioData) return;

    const sr = this.analysis ? this.analysis.sampleRate : 44100;
    const s0 = Math.floor(this.viewStart * sr);
    const span = Math.ceil((this.viewEnd - this.viewStart) * sr);

    cx.strokeStyle = '#739AFF'; cx.lineWidth = 1; cx.beginPath();
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
    cx.strokeStyle = 'rgba(255,255,255,0.05)';
    cx.beginPath(); cx.moveTo(0, H/2); cx.lineTo(W, H/2); cx.stroke();
  }

  _drawWaveformUI() {
    const cv = this.waveUiC;
    if (!cv) return;
    const cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);

    if (this.startTime >= 0 && this.endTime >= 0 && this.endTime > this.startTime) {
      const sx = Math.max(0, this._timeToX(this.startTime, W));
      const ex = Math.min(W, this._timeToX(this.endTime, W));
      cx.fillStyle = 'rgba(115, 154, 255, 0.05)';
      cx.fillRect(sx, 0, ex - sx, H);
    }

    if (this.startTime >= this.viewStart && this.startTime <= this.viewEnd) {
      const sx = this._timeToX(this.startTime, W);
      cx.strokeStyle = 'rgba(63, 185, 80, 0.9)'; cx.lineWidth = 2; // Green
      cx.beginPath(); cx.moveTo(sx, 0); cx.lineTo(sx, H); cx.stroke();
      cx.fillStyle = 'rgba(63, 185, 80, 0.9)';
      cx.beginPath(); cx.moveTo(sx, 0); cx.lineTo(sx+6, 0); cx.lineTo(sx, 8); cx.lineTo(sx-6, 0); cx.fill();
    }

    if (this.endTime >= this.viewStart && this.endTime <= this.viewEnd) {
      const ex = this._timeToX(this.endTime, W);
      cx.strokeStyle = 'rgba(248, 81, 73, 0.8)'; cx.lineWidth = 2; // Red
      cx.beginPath(); cx.moveTo(ex, 0); cx.lineTo(ex, H); cx.stroke();
      cx.fillStyle = 'rgba(248, 81, 73, 0.8)';
      cx.beginPath(); cx.moveTo(ex, 0); cx.lineTo(ex+6, 0); cx.lineTo(ex, 8); cx.lineTo(ex-6, 0); cx.fill();
    }

    if (this.playhead >= this.viewStart && this.playhead <= this.viewEnd) {
      const xp = this._timeToX(this.playhead, W);
      cx.strokeStyle = '#FFB800'; cx.lineWidth = 1.5; // Amber
      cx.beginPath(); cx.moveTo(xp, 0); cx.lineTo(xp, H); cx.stroke();
      cx.fillStyle = '#FFB800';
      cx.beginPath(); cx.moveTo(xp-5,0); cx.lineTo(xp+5,0); cx.lineTo(xp,10); cx.fill();
    }
  }

  _drawSpectrogram() {
    const cv = this.specC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.fillStyle = '#101217'; cx.fillRect(0, 0, W, H);
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
        const [r, g, b] = this._ampToRGB(amp * 0.7); 
        const p = (yi * W + xi) * 4;
        pix[p] = r; pix[p+1] = g; pix[p+2] = b; pix[p+3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);

    this._drawFreqGrid(cx, W, H);
    this._drawMidiGrid(cx, W, H);
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
      cx.strokeStyle = 'rgba(255,255,255,0.05)'; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(0, y); cx.lineTo(W, y); cx.stroke();
      cx.fillStyle = 'rgba(255,255,255,0.3)';
      cx.fillText(f >= 1000 ? `${f/1000}k` : `${f}`, 3, y - 2);
    }
  }

  _drawMidiGrid(cx, W, H) {
    cx.font = '10px monospace'; cx.textAlign = 'left';
    const minMidi = Math.floor(69 + 12 * Math.log2(this.freqMin / 440));
    const maxMidi = Math.ceil(69 + 12 * Math.log2(this.freqMax / 440));

    for (let m = minMidi; m <= maxMidi; m++) {
      const freq = 440 * Math.pow(2, (m - 69) / 12);
      if (freq < this.freqMin || freq > this.freqMax) continue;
      
      const y = this._freqToY(freq, H);
      const isBlack = [1,3,6,8,10].includes(m % 12);
      const isC = (m % 12 === 0);

      if (isBlack) { cx.strokeStyle = 'rgba(255, 255, 255, 0.02)'; cx.lineWidth = 1; } 
      else { cx.strokeStyle = isC ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)'; cx.lineWidth = isC ? 1.5 : 1; }

      cx.beginPath(); cx.moveTo(0, y); cx.lineTo(W, y); cx.stroke();

      if (isC) {
        const oct = Math.floor(m / 12) - 1;
        cx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        cx.fillText(`C${oct}`, W - 20, y - 3);
      }
    }
  }

  _drawPartials() {
    const cv = this.partC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);
    if (!this.analysis || !this.analysis.partials) return;
    
    const { partials, hopSize, sampleRate } = this.analysis;

    for (const p of partials) {
      if (p.isNoise) continue;

      const hue = (p.id * 137.508) % 360;
      cx.strokeStyle = `hsla(${hue},75%,60%,0.3)`; cx.lineWidth = 1.0;
      cx.beginPath(); let penDown = false;

      for (const seg of p.segs) {
        if (seg.amp < 1e-5) { penDown = false; continue; }
        const t = seg.fi * hopSize / sampleRate;
        if (t < this.viewStart || t > this.viewEnd) continue;
        const x = this._timeToX(t, W); const y = this._freqToY(seg.freq, H);
        if (!penDown) { cx.moveTo(x, y); penDown = true; } else cx.lineTo(x, y);
      }
      cx.stroke();
    }
  }

  _drawUI() {
    const cv = this.uiC, cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);

    if (this.analysis && this.f0Data) {
      const { hopSize, sampleRate } = this.analysis;
      if (this.showBaseF0 && this.baseF0) {
        cx.strokeStyle = 'rgba(115, 154, 255, 0.8)'; cx.lineWidth = 2.5; 
        this._traceCurve(cx, this.baseF0, hopSize, sampleRate, W, H, true);
      }
      if (this.editedF0) {
        cx.strokeStyle = 'rgba(255, 184, 0, 1.0)'; cx.lineWidth = 4; // Amber
        this._traceCurve(cx, this.editedF0, hopSize, sampleRate, W, H, false);
      }
    }
  }

  _traceCurve(cx, f0Arr, hopSize, sampleRate, W, H, isBase) {
    cx.beginPath(); let penDown = false;
    for (let fi = 0; fi < f0Arr.length; fi++) {
      const f = f0Arr[fi];
      if (isBase === false && f === 0) { penDown = false; continue; }
      if (f < 20) { penDown = false; continue; }

      const t = fi * hopSize / sampleRate;
      if (t < this.viewStart || t > this.viewEnd) continue;
      const x = this._timeToX(t, W); const y = this._freqToY(f, H);
      if (!penDown) { cx.moveTo(x, y); penDown = true; } else cx.lineTo(x, y);
    }
    cx.stroke();
  }

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------
  _bindWaveformEvents() {
    const ui = this.waveUiC;
    if (!ui) return;
    
    let draggingStart = false;
    let draggingEnd   = false;

    // タッチ用長押し判定タイマー
    let touchTimer = null;
    let isLongPress = false;
    let touchStartX = 0, touchStartY = 0;

    const updateTime = (x, isStart) => {
      const t = this._xToTime(x, ui.width);
      const clamped = Math.max(0, Math.min(t, this.analysis ? this.analysis.duration : 60));
      
      if (isStart) {
        this.startTime = Math.min(clamped, this.endTime - 0.05); 
        if (this.onSetStartTime) this.onSetStartTime(this.startTime);
      } else {
        this.endTime = Math.max(clamped, this.startTime + 0.05); 
        if (this.onSetEndTime) this.onSetEndTime(this.endTime);
      }
      this._drawUI();
      this._drawWaveformUI();
    };

    // マウス操作
    ui.addEventListener('mousedown', e => {
      if (e.button === 0) { draggingStart = true; updateTime(e.offsetX, true); }
      else if (e.button === 2) { draggingEnd = true; updateTime(e.offsetX, false); }
    });
    ui.addEventListener('mousemove', e => {
      if (draggingStart) updateTime(e.offsetX, true);
      if (draggingEnd) updateTime(e.offsetX, false);
    });
    ui.addEventListener('mouseup', () => { draggingStart = false; draggingEnd = false; });
    ui.addEventListener('mouseleave', () => { draggingStart = false; draggingEnd = false; });
    ui.addEventListener('contextmenu', e => e.preventDefault());

    // タッチ操作 (タップ=Start, 長押し=End)
    ui.addEventListener('touchstart', e => {
      if(e.touches.length !== 1) return;
      e.preventDefault();
      const rect = ui.getBoundingClientRect();
      touchStartX = e.touches[0].clientX - rect.left;
      touchStartY = e.touches[0].clientY - rect.top;
      
      isLongPress = false;
      draggingStart = false;
      draggingEnd = false;

      // 500ms 押したままなら End 位置指定とみなす
      touchTimer = setTimeout(() => {
        isLongPress = true;
        draggingEnd = true;
        updateTime(touchStartX, false);
        if (navigator.vibrate) navigator.vibrate(50); // Haptic feedback
      }, 500);
    }, {passive: false});

    ui.addEventListener('touchmove', e => {
      if(e.touches.length !== 1) return;
      e.preventDefault();
      const rect = ui.getBoundingClientRect();
      const x = e.touches[0].clientX - rect.left;
      const y = e.touches[0].clientY - rect.top;

      // 指が大きく動いたら長押しキャンセルして Start 移動とみなす
      if (touchTimer && !isLongPress && Math.abs(x - touchStartX) > 10) {
        clearTimeout(touchTimer);
        touchTimer = null;
        draggingStart = true;
      }

      if (draggingStart) updateTime(x, true);
      if (draggingEnd) updateTime(x, false);
    }, {passive: false});

    ui.addEventListener('touchend', e => {
      e.preventDefault();
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
      
      // 動かず、かつ長押しでもなかった場合は「タップ」なので Start 位置を更新
      if (!isLongPress && !draggingStart && !draggingEnd) {
        updateTime(touchStartX, true);
      }
      
      draggingStart = false;
      draggingEnd = false;
      isLongPress = false;
    }, {passive: false});
  }

  _bindEvents() {
    const ui = this.uiC;
    let draggingEdit = false, draggingPan = false;
    let dragButton = -1;
    let prevX = 0;
    
    // Pan / Zoom variables
    let panStartX = 0, panStartY = 0;
    let panVStart = 0, panVEnd = 0;
    let panFMinL = 0, panFMaxL = 0;
    
    // Pinch Zoom variables
    let initialPinchDist = 0;
    let prevPinchDist = 0;
    let initialSpanT = 0, initialSpanF = 0;

    // --- Mouse Events ---
    ui.addEventListener('mousedown', e => {
      if (e.button === 1) {
        draggingPan = true;
        panStartX = e.offsetX; panStartY = e.offsetY;
        panVStart = this.viewStart; panVEnd = this.viewEnd;
        panFMinL = Math.log2(this.freqMin); panFMaxL = Math.log2(this.freqMax);
        return;
      }
      if (e.button === 0 || e.button === 2) {
        draggingEdit = true;
        dragButton = e.button;
        prevX = e.offsetX;
        this._editCurve(e.offsetX, e.offsetY, prevX, dragButton, ui.width, ui.height);
      }
    });

    ui.addEventListener('mousemove', e => {
      if (draggingPan) {
        this._doPan(e.offsetX - panStartX, e.offsetY - panStartY, ui.width, ui.height);
      } else if (draggingEdit) {
        this._editCurve(e.offsetX, e.offsetY, prevX, dragButton, ui.width, ui.height);
        prevX = e.offsetX;
      }
    });

    ui.addEventListener('mouseup', e => {
      if (e.button === 1) { draggingPan = false; return; }
      if (e.button === 0 || e.button === 2) draggingEdit = false;
    });
    ui.addEventListener('mouseleave', () => { draggingEdit = false; draggingPan = false; });

    ui.addEventListener('wheel', e => {
      e.preventDefault();
      const scale = e.deltaY > 0 ? 1.15 : 0.87;
      this._doZoom(e.offsetX, e.offsetY, scale, e.shiftKey, ui.width, ui.height);
    }, { passive: false });

    // --- Touch Events (Multitouch / Pinch-Zoom) ---
    const getPinchDist = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getPinchCenter = (touches, rect) => {
      const cx = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
      const cy = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
      return { x: cx, y: cy };
    };

    ui.addEventListener('touchstart', e => {
      e.preventDefault();
      const rect = ui.getBoundingClientRect();
      
      if (e.touches.length === 1) {
        draggingEdit = true;
        dragButton = 0; // Touch is always treated as primary (left) button for edit
        prevX = e.touches[0].clientX - rect.left;
        this._editCurve(prevX, e.touches[0].clientY - rect.top, prevX, dragButton, ui.width, ui.height);
      } 
      else if (e.touches.length === 2) {
        // 2本指になった瞬間、編集はキャンセルして Pan/Zoom モードへ移行
        draggingEdit = false;
        draggingPan = true;
        
        const center = getPinchCenter(e.touches, rect);
        panStartX = center.x;
        panStartY = center.y;
        panVStart = this.viewStart;
        panVEnd = this.viewEnd;
        panFMinL = Math.log2(this.freqMin);
        panFMaxL = Math.log2(this.freqMax);
        
        initialPinchDist = getPinchDist(e.touches);
        prevPinchDist = initialPinchDist;
        initialSpanT = this.viewEnd - this.viewStart;
        initialSpanF = Math.log2(this.freqMax) - Math.log2(this.freqMin);
      }
    }, { passive: false });

    ui.addEventListener('touchmove', e => {
      e.preventDefault();
      const rect = ui.getBoundingClientRect();
      
      if (e.touches.length === 1 && draggingEdit) {
        const x = e.touches[0].clientX - rect.left;
        const y = e.touches[0].clientY - rect.top;
        this._editCurve(x, y, prevX, dragButton, ui.width, ui.height);
        prevX = x;
      } 
      else if (e.touches.length === 2 && draggingPan) {
        // 1. Pan (Translation) — use incremental delta from last frame
        const center = getPinchCenter(e.touches, rect);
        this._doPan(center.x - panStartX, center.y - panStartY, ui.width, ui.height);
        // Update reference so next frame only moves by new delta
        panStartX = center.x;
        panStartY = center.y;

        // 2. Zoom (Pinch) — use incremental scale between frames
        const currentDist = getPinchDist(e.touches);
        if (prevPinchDist > 10) {
          // scale > 1 = zoom out, scale < 1 = zoom in (fingers spreading)
          const scale = prevPinchDist / Math.max(10, currentDist);
          this._doPinchZoomAbs(center.x, center.y, scale, ui.width, ui.height);
        }
        prevPinchDist = currentDist;
      }
    }, { passive: false });

    ui.addEventListener('touchend', e => {
      e.preventDefault();
      if (e.touches.length === 0) {
        draggingEdit = false;
        draggingPan = false;
        prevPinchDist = 0;
      } else if (e.touches.length === 1) {
        // 2本指から1本指に減った場合、Pan解除・座標リセット
        draggingPan = false;
        prevPinchDist = 0;
        const rect = ui.getBoundingClientRect();
        prevX = e.touches[0].clientX - rect.left;
      }
    }, { passive: false });
  }

  // --- Pan / Zoom Logic Handlers ---
  _doPan(dx, dy, W, H) {
    const timeSpan = this.viewEnd - this.viewStart;
    const dt = (dx / W) * timeSpan;
    let newStart = this.viewStart - dt; 
    let newEnd = this.viewEnd - dt;

    const maxTime = this.analysis ? this.analysis.duration : 60;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > maxTime) { newStart -= (newEnd - maxTime); newEnd = maxTime; }
    this.viewStart = Math.max(0, newStart); 
    this.viewEnd = Math.min(maxTime, newEnd);

    const freqSpanL = Math.log2(this.freqMax) - Math.log2(this.freqMin);
    const df = (dy / H) * freqSpanL; 
    
    let newFMaxL = Math.log2(this.freqMax) + df; 
    let newFMinL = Math.log2(this.freqMin) + df;
    const minL = Math.log2(20), maxL = Math.log2(20000);
    
    if (newFMaxL > maxL) { newFMinL -= (newFMaxL - maxL); newFMaxL = maxL; }
    if (newFMinL < minL) { newFMaxL -= (newFMinL - minL); newFMinL = minL; }
    
    this.freqMax = Math.pow(2, newFMaxL); 
    this.freqMin = Math.pow(2, newFMinL);

    this.renderAll();
    if (this.onViewChange) this.onViewChange();
  }

  _doZoom(cx, cy, scale, isShift, W, H) {
    if (isShift) {
      // Y軸ズーム
      const f = this._yToFreq(cy, H);
      const fL = Math.log2(f);
      const spanL = Math.log2(this.freqMax) - Math.log2(this.freqMin);
      const newSpanL = Math.max(this.minFreqZoomRangeL, spanL * scale); 
      
      let newFMinL = fL - (fL - Math.log2(this.freqMin)) * (newSpanL / spanL);
      let newFMaxL = newFMinL + newSpanL;
      
      const minL = Math.log2(20), maxL = Math.log2(20000);
      if (newFMinL < minL) { newFMaxL += (minL - newFMinL); newFMinL = minL; }
      if (newFMaxL > maxL) { newFMinL -= (newFMaxL - maxL); newFMaxL = maxL; }
      
      this.freqMin = Math.pow(2, newFMinL); this.freqMax = Math.pow(2, newFMaxL);
    } else {
      // X軸ズーム
      const t = this._xToTime(cx, W);
      const span = this.viewEnd - this.viewStart;
      const newSpan = Math.max(0.05, Math.min(this.analysis ? this.analysis.duration : 60, span * scale));
      
      this.viewStart = Math.max(0, t - (t - this.viewStart) / span * newSpan);
      this.viewEnd = this.viewStart + newSpan;
      if (this.analysis && this.viewEnd > this.analysis.duration) this.viewEnd = this.analysis.duration;
    }
    this.renderAll();
    if (this.onViewChange) this.onViewChange();
  }

  _doPinchZoomAbs(cx, cy, scale, W, H) {
    // X, Y 両方を同時にズーム (Mobile Multi-touch用)
    const t = this._xToTime(cx, W);
    const span = this.viewEnd - this.viewStart;
    const newSpan = Math.max(0.05, Math.min(this.analysis ? this.analysis.duration : 60, span * scale));
    this.viewStart = Math.max(0, t - (t - this.viewStart) / span * newSpan);
    this.viewEnd = this.viewStart + newSpan;
    if (this.analysis && this.viewEnd > this.analysis.duration) this.viewEnd = this.analysis.duration;

    const f = this._yToFreq(cy, H);
    const fL = Math.log2(f);
    const spanL = Math.log2(this.freqMax) - Math.log2(this.freqMin);
    const newSpanL = Math.max(this.minFreqZoomRangeL, Math.min(Math.log2(20000)-Math.log2(20), spanL * scale)); 
    let newFMinL = fL - (fL - Math.log2(this.freqMin)) * (newSpanL / spanL);
    let newFMaxL = newFMinL + newSpanL;
    
    const minL = Math.log2(20), maxL = Math.log2(20000);
    if (newFMinL < minL) { newFMaxL += (minL - newFMinL); newFMinL = minL; }
    if (newFMaxL > maxL) { newFMinL -= (newFMaxL - maxL); newFMaxL = maxL; }
    this.freqMin = Math.pow(2, newFMinL); this.freqMax = Math.pow(2, newFMaxL);

    this.renderAll();
    if (this.onViewChange) this.onViewChange();
  }

  // --- / Pan Zoom Logic Handlers ---

  _editCurve(x, y, pX, button, W, H) {
    if (!this.analysis || !this.f0Data || !this.baseF0) return;
    if (!this.editedF0) this.editedF0 = new Float32Array(this.f0Data.length);

    let target = this.editTarget;
    // 右ドラッグの場合は PC であれば base を編集するショートカット
    if (button === 2 && target === 'edited') target = 'base';

    const { hopSize, sampleRate } = this.analysis;
    let freq = this._yToFreq(y, H);

    if (this.isSnapMode && !this.isEraseMode) {
      const midi = 69 + 12 * Math.log2(freq / 440);
      freq = 440 * Math.pow(2, (Math.round(midi) - 69) / 12);
    }

    const t0 = this._xToTime(pX, W), t1 = this._xToTime(x, W);
    const fi0 = Math.round(t0 * sampleRate / hopSize);
    const fi1 = Math.round(t1 * sampleRate / hopSize);
    const sFi = Math.min(fi0, fi1), eFi = Math.max(fi0, fi1);

    for (let i = sFi; i <= eFi; i++) {
      if (i >= 0 && i < this.baseF0.length) {
        if (this.isEraseMode) {
           if (target === 'base') this.baseF0[i] = this.f0Data[i];
           if (target === 'edited') this.editedF0[i] = 0;
        } else {
           if (target === 'base') this.baseF0[i] = freq;
           if (target === 'edited') this.editedF0[i] = freq;
        }
      }
    }
    this._drawUI();
  }

  _freqToY(f, H) { const lm = Math.log2(this.freqMin), lM = Math.log2(this.freqMax); return H - (Math.log2(Math.max(f, this.freqMin)) - lm) / (lM - lm) * H; }
  _yToFreq(y, H) { const lm = Math.log2(this.freqMin), lM = Math.log2(this.freqMax); return Math.pow(2, lm + (1 - y / H) * (lM - lm)); }
  _timeToX(t, W) { return (t - this.viewStart) / (this.viewEnd - this.viewStart) * W; }
  _xToTime(x, W) { return this.viewStart + x / W * (this.viewEnd - this.viewStart); }

  _buildColormap() {
    return [
      [16,18,23],[24,28,36],[32,40,54],[42,54,76],[54,72,102],[68,92,132],
      [84,115,165],[102,141,202],[115,154,255],[150,180,255],[200,215,255],[255,255,255]
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