'use strict';
/**
 * app.js — Application Controller (Web Worker Integrated)
 */
class HarmorApp {
  constructor() {
    this.audio    = new AudioManager();
    this.exporter = new WAVExporter();
    this.analyzer = null;
    this.synth    = null;
    this.renderer = null;

    this.audioData   = null;
    this.sampleRate  = 44100;
    this.analysis    = null;
    this.synthData   = null;

    this.globalSemitones = 0;
    this.playbackSpeed = 1.0;
    this.startTime = 0; 
    this.endTime   = 1; 
    this.synthBuffersMap = new Map(); 

    // 小数第一位まで保持
    this.adsr = { a: 10.0, d: 500.0, s: 100.0, r: 300.0 };
    this.midiEvents = [];

    // ADSR表示用のスクロール状態 (単位: ms)
    this.adsrViewStart = 0;
    this.adsrViewEnd   = 1500; 
    
    // 現在の再生状態のトラッキング
    this.currentPlayType = null; // 'orig' | 'synth' | null

    this._initRenderer();
    this._buildPianoRoll();
    this._bindUI();
    this._bindAdsrEvents();
    this._bindKnobs();
    this._bindDragAndDrop();
    this._drawADSR();
  }

  _initRenderer() {
    this.renderer = new SpectralRenderer({
      spectrogramCanvas: $('spectrogramCanvas'),
      partialCanvas:     $('partialCanvas'),
      uiCanvas:          $('uiCanvas'),
      waveformCanvas:    $('waveformCanvas'),
    });

    this.renderer.onSetStartTime = (t) => { this.startTime = t; };
    this.renderer.onSetEndTime   = (t) => { this.endTime = t; };
    this.renderer.onViewChange = () => { this._updateScrollSlidersFromRenderer(); };

    this.audio.onTimeUpdate = (t) => {
      let uiTime = t;
      if (this.currentPlayType === 'synth') {
         const elapsedSec = (this.audio.ctx.currentTime - this.audio._startAt);
         if (this.playbackSpeed <= 0.001) {
             uiTime = this.startTime;
         } else {
             uiTime = this.startTime + (elapsedSec * this.playbackSpeed);
         }
      }
      this.renderer.setPlayhead(uiTime);
      $('timeDisplay').textContent = formatTime(uiTime);
      this._drawADSR(); 
    };
    
    this.audio.onEnded = () => {
      this._updatePlayButtons(null);
      this._drawADSR();
    };
  }

  _bindUI() {
    const fi = $('fileInput');
    $('loadBtn').addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => { if (e.target.files[0]) this._loadFile(e.target.files[0]); });

    const midiInput = $('midiInput');
    $('loadMidiBtn').addEventListener('click', () => midiInput.click());
    midiInput.addEventListener('change', e => { if(e.target.files[0]) this._loadMidi(e.target.files[0]); });

    $('analyzeBtn').addEventListener('click', () => this._analyze());

    $('panelToggleBtn').addEventListener('click', () => {
      $('controlPanel').classList.toggle('collapsed');
      $('panelToggleBtn').classList.toggle('collapsed');
      setTimeout(() => this._resizeCanvases(), 300);
    });

    const pitchSl = $('pitchSlider'), pitchNum = $('pitchNum');
    const updatePitch = (val) => {
      let v = parseInt(val);
      if(isNaN(v)) return;
      this.globalSemitones = v;
      pitchSl.value = v; pitchNum.value = v;
    };
    pitchSl.addEventListener('input', e => updatePitch(e.target.value));
    pitchNum.addEventListener('change', e => updatePitch(e.target.value));

    this._bindSlider('speedSlider', 'speedValue', v => { this.playbackSpeed = v; }, v => `${v.toFixed(2)}x`);

    this._bindScrollControls();

    // Toolbar (Pitch Curve Editor) Bindings
    const btnBase = $('btnEditBase');
    const btnEdited = $('btnEditEdited');
    btnBase.addEventListener('click', () => { this.renderer.editTarget = 'base'; btnBase.classList.add('active'); btnEdited.classList.remove('active'); });
    btnEdited.addEventListener('click', () => { this.renderer.editTarget = 'edited'; btnEdited.classList.add('active'); btnBase.classList.remove('active'); });

    const btnErase = $('btnErase');
    btnErase.addEventListener('click', () => { this.renderer.isEraseMode = !this.renderer.isEraseMode; btnErase.classList.toggle('active', this.renderer.isEraseMode); });

    const btnSnap = $('btnSnap');
    btnSnap.addEventListener('click', () => { this.renderer.isSnapMode = !this.renderer.isSnapMode; btnSnap.classList.toggle('active', this.renderer.isSnapMode); });

    const btnShowBase = $('btnShowBase');
    btnShowBase.addEventListener('click', () => { this.renderer.showBaseF0 = !this.renderer.showBaseF0; btnShowBase.classList.toggle('active', this.renderer.showBaseF0); this.renderer.renderAll(); });

    $('btnClearActive').addEventListener('click', () => {
      if (this.renderer.editTarget === 'base') {
        if (confirm('推定カーブ(青)を初期状態にリセットしますか？')) {
          if (this.renderer.f0Data && this.renderer.baseF0) {
             this.renderer.baseF0 = new Float32Array(this.renderer.f0Data);
             this.renderer.renderAll();
          }
        }
      } else {
        if (confirm('補正カーブ(赤)を全てクリアしますか？')) {
          if (this.renderer.editedF0) {
             this.renderer.editedF0 = new Float32Array(this.renderer.f0Data.length);
             this.renderer.renderAll();
          }
        }
      }
    });

    $('synthesizeBtn').addEventListener('click', () => this._synthesize());
    $('exportZipBtn').addEventListener('click', () => this._exportZip());
    $('renderMidiBtn').addEventListener('click', () => this._renderMidiAndDownload());

    // Transport (Play/Stop Toggle Logic)
    $('playOrigBtn').addEventListener('click', () => this._togglePlay('orig'));
    $('playSynthBtn').addEventListener('click', () => this._togglePlay('synth'));
    $('stopBtn').addEventListener('click', () => this._stopAll());

    $('exportBtn').addEventListener('click', () => {
      if (this.synthData) {
        this.exporter.download(this.synthData, this.sampleRate, 'harmor-export.wav');
        this._status('単一WAV エクスポート完了', 'ok');
      }
    });

    window.addEventListener('resize', () => this._resizeCanvases());
    this._resizeCanvases();
  }

  // --- Drag and Drop File Loading ---
  _bindDragAndDrop() {
    const wrap = $('waveformWrapper'); // キャンバスより上のラッパーにイベントを付与
    const zone = $('dropZone');

    const prevent = e => { e.preventDefault(); e.stopPropagation(); };

    wrap.addEventListener('dragenter', e => {
      prevent(e);
      if (!this.audioData) wrap.classList.add('drag-over');
    });
    wrap.addEventListener('dragover', prevent);
    wrap.addEventListener('dragleave', e => {
      prevent(e);
      wrap.classList.remove('drag-over');
    });
    wrap.addEventListener('drop', e => {
      prevent(e);
      wrap.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        this._loadFile(e.dataTransfer.files[0]);
      }
    });
  }

  _bindKnobs() {
    const bindKnob = (id, key) => {
      const el = $(id);
      const input = el.querySelector('input');
      const min = parseFloat(el.getAttribute('data-min'));
      const max = parseFloat(el.getAttribute('data-max'));
      const curve = parseFloat(el.getAttribute('data-curve'));
      
      const knobCtrl = new KnobControl(el, min, max, curve, (v) => {
        const val = parseFloat(v.toFixed(1));
        input.value = val.toFixed(1);
        this.adsr[key] = val;
        this._autoAdjustAdsrView();
        this._drawADSR();
      });
      
      input.addEventListener('change', () => {
        let v = parseFloat(input.value);
        if (isNaN(v)) v = this.adsr[key];
        v = Math.max(min, Math.min(max, v));
        input.value = v.toFixed(1);
        knobCtrl.setValue(v);
        this.adsr[key] = v;
        this._autoAdjustAdsrView();
        this._drawADSR();
      });
      
      knobCtrl.setValue(this.adsr[key]);
    };

    bindKnob('knobA', 'a');
    bindKnob('knobD', 'd');
    bindKnob('knobS', 's');
    bindKnob('knobR', 'r');
  }

  _togglePlay(type) {
    if (this.currentPlayType === type) {
      this._stopAll();
    } else {
      this._stopAll(); 
      if (type === 'orig' && this.audioData) {
        this.audio.play('orig', this.startTime, this.startTime);
        this._updatePlayButtons('orig');
      } else if (type === 'synth' && this.synthData) {
        this.audio.play('synth', 0, this.startTime);
        this._updatePlayButtons('synth');
      }
    }
  }

  _stopAll() {
    this.audio.stop();
    this._updatePlayButtons(null);
    this.renderer.setPlayhead(this.startTime);
    $('timeDisplay').textContent = formatTime(this.startTime);
    this._drawADSR();
  }

  _updatePlayButtons(type) {
    this.currentPlayType = type;
    $('playOrigBtn').classList.toggle('active', type === 'orig');
    $('playSynthBtn').classList.toggle('active', type === 'synth');
  }

  _bindScrollControls() {
    const sX = $('sliderPanX'), sY = $('sliderPanY');

    sX.addEventListener('input', () => {
      if (!this.analysis) return;
      const maxT = this.analysis.duration;
      const span = this.renderer.viewEnd - this.renderer.viewStart;
      const pct = parseFloat(sX.value) / 1000.0;
      let vs = pct * (maxT - span);
      this.renderer.setView(vs, vs + span, this.renderer.freqMin, this.renderer.freqMax);
    });

    sY.addEventListener('input', () => {
      const minL = Math.log2(20), maxL = Math.log2(20000);
      const spanL = Math.log2(this.renderer.freqMax) - Math.log2(this.renderer.freqMin);
      const pct = parseFloat(sY.value) / 1000.0; 
      let fm = minL + pct * (maxL - minL - spanL);
      this.renderer.setView(this.renderer.viewStart, this.renderer.viewEnd, Math.pow(2, fm), Math.pow(2, fm + spanL));
    });

    const zoomX = (scale) => {
      if (!this.analysis) return;
      const span = this.renderer.viewEnd - this.renderer.viewStart;
      const center = this.renderer.viewStart + span / 2;
      const newSpan = Math.max(0.05, Math.min(this.analysis.duration, span * scale));
      let vs = center - newSpan / 2; let ve = center + newSpan / 2;
      if (vs < 0) { ve -= vs; vs = 0; }
      if (ve > this.analysis.duration) { vs -= (ve - this.analysis.duration); ve = this.analysis.duration; }
      this.renderer.setView(Math.max(0, vs), Math.min(this.analysis.duration, ve), this.renderer.freqMin, this.renderer.freqMax);
      this._updateScrollSlidersFromRenderer();
    };

    const zoomY = (scale) => {
      const minL = Math.log2(20), maxL = Math.log2(20000);
      const spanL = Math.log2(this.renderer.freqMax) - Math.log2(this.renderer.freqMin);
      const centerL = Math.log2(this.renderer.freqMin) + spanL / 2;
      
      const newSpanL = Math.max(this.renderer.minFreqZoomRangeL, Math.min(maxL - minL, spanL * scale));
      let vmL = centerL - newSpanL / 2; let vxL = centerL + newSpanL / 2;
      if (vmL < minL) { vxL += (minL - vmL); vmL = minL; }
      if (vxL > maxL) { vmL -= (vxL - maxL); vxL = maxL; }
      
      this.renderer.setView(this.renderer.viewStart, this.renderer.viewEnd, Math.pow(2, vmL), Math.pow(2, vxL));
      this._updateScrollSlidersFromRenderer();
    };

    $('btnZoomInX').addEventListener('click', () => zoomX(0.8));
    $('btnZoomOutX').addEventListener('click', () => zoomX(1.25));
    $('btnZoomInY').addEventListener('click', () => zoomY(0.8));
    $('btnZoomOutY').addEventListener('click', () => zoomY(1.25));

    const sAdsrX = $('sliderPanAdsrX');
    sAdsrX.addEventListener('input', () => {
      const maxT = Math.max(2000, this.adsr.a + this.adsr.d + this.adsr.r + 1000);
      const span = this.adsrViewEnd - this.adsrViewStart;
      const pct = parseFloat(sAdsrX.value) / 1000.0;
      let vs = pct * (maxT - span);
      this.adsrViewStart = vs;
      this.adsrViewEnd = vs + span;
      this._drawADSR();
    });
    
    const zoomAdsrX = (scale) => {
      const maxT = Math.max(2000, this.adsr.a + this.adsr.d + this.adsr.r + 1000);
      const span = this.adsrViewEnd - this.adsrViewStart;
      const center = this.adsrViewStart + span / 2;
      const newSpan = Math.max(10, Math.min(maxT, span * scale));
      let vs = center - newSpan / 2; let ve = center + newSpan / 2;
      if (vs < 0) { ve -= vs; vs = 0; }
      if (ve > maxT) { vs -= (ve - maxT); ve = maxT; }
      this.adsrViewStart = Math.max(0, vs);
      this.adsrViewEnd = Math.min(maxT, ve);
      this._updateAdsrScrollSlider();
      this._drawADSR();
    };

    $('btnZoomInAdsrX').addEventListener('click', () => zoomAdsrX(0.8));
    $('btnZoomOutAdsrX').addEventListener('click', () => zoomAdsrX(1.25));
  }

  _bindAdsrEvents() {
    const cv = $('adsrCanvas');
    let draggingPan = false;
    let panStartX = 0;
    let panVStart = 0, panVEnd = 0;

    cv.addEventListener('mousedown', e => {
      if (e.button === 1) { 
        draggingPan = true;
        panStartX = e.offsetX;
        panVStart = this.adsrViewStart;
        panVEnd = this.adsrViewEnd;
      }
    });

    cv.addEventListener('mousemove', e => {
      if (draggingPan) {
        const dx = e.offsetX - panStartX;
        const timeSpan = panVEnd - panVStart;
        const maxT = Math.max(2000, this.adsr.a + this.adsr.d + this.adsr.r + 1000);
        const dt = (dx / cv.width) * timeSpan;
        
        let newStart = panVStart - dt; let newEnd = panVEnd - dt;
        if (newStart < 0) { newEnd -= newStart; newStart = 0; }
        if (newEnd > maxT) { newStart -= (newEnd - maxT); newEnd = maxT; }
        
        this.adsrViewStart = Math.max(0, newStart);
        this.adsrViewEnd = Math.min(maxT, newEnd);
        this._updateAdsrScrollSlider();
        this._drawADSR();
      }
    });

    cv.addEventListener('mouseup', e => { if (e.button === 1) draggingPan = false; });
    cv.addEventListener('mouseleave', () => { draggingPan = false; });

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const scale = e.deltaY > 0 ? 1.15 : 0.87;
      const maxT = Math.max(2000, this.adsr.a + this.adsr.d + this.adsr.r + 1000);
      
      const t = this.adsrViewStart + (e.offsetX / cv.width) * (this.adsrViewEnd - this.adsrViewStart);
      const span = this.adsrViewEnd - this.adsrViewStart;
      const newSpan = Math.max(10, Math.min(maxT, span * scale));
      
      let vs = Math.max(0, t - (t - this.adsrViewStart) / span * newSpan);
      let ve = vs + newSpan;
      if (ve > maxT) { vs -= (ve - maxT); ve = maxT; vs = Math.max(0, vs); }

      this.adsrViewStart = vs;
      this.adsrViewEnd = ve;
      this._updateAdsrScrollSlider();
      this._drawADSR();
    }, { passive: false });
  }

  _updateAdsrScrollSlider() {
    const sX = $('sliderPanAdsrX');
    const maxT = Math.max(2000, this.adsr.a + this.adsr.d + this.adsr.r + 1000);
    const spanT = this.adsrViewEnd - this.adsrViewStart;
    if (spanT < maxT) sX.value = (this.adsrViewStart / (maxT - spanT)) * 1000;
    else sX.value = 0;
  }

  _autoAdjustAdsrView() {
    const minRequired = this.adsr.a + this.adsr.d + this.adsr.r + 500;
    if (this.adsrViewEnd < minRequired) {
      this.adsrViewEnd = minRequired;
      this._updateAdsrScrollSlider();
    }
  }

  _updateScrollSlidersFromRenderer() {
    if (!this.analysis || !this.renderer) return;
    const maxT = this.analysis.duration;
    const spanT = this.renderer.viewEnd - this.renderer.viewStart;
    if (spanT < maxT) $('sliderPanX').value = (this.renderer.viewStart / (maxT - spanT)) * 1000;
    else $('sliderPanX').value = 0;

    const minL = Math.log2(20), maxL = Math.log2(20000);
    const spanL = Math.log2(this.renderer.freqMax) - Math.log2(this.renderer.freqMin);
    const currL = Math.log2(this.renderer.freqMin);
    if (spanL < (maxL - minL)) $('sliderPanY').value = ((currL - minL) / (maxL - minL - spanL)) * 1000;
    else $('sliderPanY').value = 500;
  }

  _bindSlider(id, displayId, onChange, fmt) {
    const sl = $(id), disp = $(displayId);
    const update = () => { const v = parseFloat(sl.value); onChange(v); disp.textContent = fmt(v); };
    sl.addEventListener('input', update);
    update();
  }

  async _loadMidi(file) {
    try {
      const buffer = await file.arrayBuffer();
      this.midiEvents = MidiParser.parse(buffer);
      $('midiInfo').textContent = `${file.name} (${this.midiEvents.length} notes)`;
      $('midiInfo').style.color = 'var(--accent2)';
      if (this.analysis) $('renderMidiBtn').disabled = false;
    } catch(e) {
      $('midiInfo').textContent = `読込失敗: ${e.message}`;
      $('midiInfo').style.color = 'var(--err)';
    }
  }

  async _loadFile(file) {
    this._status('読み込み中…', 'info');
    try {
      const decoded = await this.audio.loadFile(file);
      this.sampleRate = decoded.sampleRate;

      const nCh = decoded.numberOfChannels;
      const len = decoded.length;
      this.audioData = new Float32Array(len);
      for (let ch = 0; ch < nCh; ch++) {
        const src = decoded.getChannelData(ch);
        for (let i = 0; i < len; i++) this.audioData[i] += src[i] / nCh;
      }

      $('fileInfo').textContent = `${file.name} | ${decoded.duration.toFixed(2)}s | ${this.sampleRate}Hz`;

      this.renderer.audioData = this.audioData;
      this.renderer.analysis  = { sampleRate: this.sampleRate, duration: decoded.duration };
      this.renderer.viewEnd   = decoded.duration;
      this.renderer.startTime = 0;
      this.renderer.endTime   = decoded.duration;
      this.startTime = 0;
      this.endTime = decoded.duration;
      this.renderer._drawWaveform();
      this.renderer._drawWaveformUI();

      // ロード成功後、DropZone のテキストを完全に非表示にする
      $('dropZone').style.display = 'none';

      $('analyzeBtn').disabled = false;
      $('playOrigBtn').disabled = false;
      this._status('読み込み完了。「解析」を押してください。', 'ok');
    } catch(e) {
      this._status(`エラー: ${e.message}`, 'err');
    }
  }

  async _analyze() {
    if (!this.audioData) return;

    const fftSize = parseInt($('fftSizeSelect').value) || 4096;
    const maxPartials = parseInt($('maxPartialsInput').value) || 200;
    const threshDb = parseFloat($('threshInput').value) || -70;

    this.analyzer = new SpectralAnalyzer({ fftSize, sampleRate: this.sampleRate, maxPartials, threshDb });

    $('analyzeBtn').disabled = true;
    this._status('解析中…', 'info');
    this._progress(0);

    try {
      this.analysis = await this.analyzer.analyze(this.audioData, p => this._progress(p));
      this.synth = new AdditiveSynthesizer(this.sampleRate, this.analysis.hopSize);

      this.renderer.setAnalysis(this.analysis, this.audioData);
      this._updateScrollSlidersFromRenderer();

      $('partialCountBadge').textContent = `${this.analysis.partials.length} partials`;
      $('synthesizeBtn').disabled = false;
      if (this.midiEvents.length > 0) $('renderMidiBtn').disabled = false;

      this._status(`解析完了 (${this.analysis.partials.length} partials)`, 'ok');
    } catch(e) {
      this._status(`解析エラー: ${e.message}`, 'err');
    } finally {
      $('analyzeBtn').disabled = false;
      this._progress(null);
    }
  }

  async _synthesize() {
    if (!this.analysis) return;
    $('synthesizeBtn').disabled = true;
    this._status('プレビュー生成中 (Worker動作中)…', 'info');
    this._progress(0);

    const getPitchMap = (baseSemitones) => {
      const baseRatio = Math.pow(2, baseSemitones / 12);
      return (fi, freq) => {
        let r = baseRatio;
        if (this.analysis && this.renderer.baseF0) {
          const b = this.renderer.baseF0[fi];
          if (b > 0) {
            const e = this.renderer.editedF0[fi];
            const targetFreq = (e > 0) ? e : b;
            const origFreq = this.analysis.f0Data[fi];
            if (origFreq > 0) r *= (targetFreq / origFreq);
          }
        }
        return r;
      };
    };

    try {
      const speed = this.playbackSpeed;
      const adsrToApply = this.adsr;

      this.synthData = await this.synth.synthesize(
        this.analysis, getPitchMap(this.globalSemitones), speed, this.startTime, this.endTime, adsrToApply, null, p => this._progress(p)
      );

      this.audio.setSynthData(this.synthData, this.sampleRate);
      $('playSynthBtn').disabled = false;
      $('exportBtn').disabled = false;

      if ($('multiSampleCheck').checked) {
        this._status('マルチサンプル自動生成中 (C3 - B5)…', 'info');
        this.synthBuffersMap.clear();
        
        for (let note = 48; note <= 83; note++) {
          const stShift = (note - 60) + this.globalSemitones;
          const map = getPitchMap(stShift);
          const data = await this.synth.synthesize(this.analysis, map, speed, this.startTime, this.endTime, adsrToApply, null, null);
          this.synthBuffersMap.set(note, data);
          this._progress((note - 48) / 36);
        }

        $('pianoRoll').style.display = 'flex';
        $('exportZipBtn').disabled = false;
      } else {
        $('pianoRoll').style.display = 'none';
        $('exportZipBtn').disabled = true;
      }

      this._status('再合成完了', 'ok');
    } catch(e) {
      this._status(`エラー: ${e.message}`, 'err');
    } finally {
      $('synthesizeBtn').disabled = false;
      this._progress(null);
      this._resizeCanvases(); 
    }
  }

  async _renderMidiAndDownload() {
    if (!this.analysis || this.midiEvents.length === 0) return;
    
    $('renderMidiBtn').disabled = true;
    const isStem = $('midiStemCheck').checked;
    
    this._status('MIDI レンダリング中 (Workerによる音素生成)…', 'info');
    this._progress(0);
    $('midiStemList').innerHTML = ''; 

    const getPitchMap = (baseSemitones) => {
      const baseRatio = Math.pow(2, baseSemitones / 12);
      return (fi, freq) => {
        let r = baseRatio;
        if (this.analysis && this.renderer.baseF0) {
          const b = this.renderer.baseF0[fi];
          if (b > 0) {
            const e = this.renderer.editedF0[fi];
            const targetFreq = (e > 0) ? e : b;
            const origFreq = this.analysis.f0Data[fi];
            if (origFreq > 0) r *= (targetFreq / origFreq);
          }
        }
        return r;
      };
    };

    try {
      const speed = this.playbackSpeed;
      this._status('MIDI ミックス中 (ADSR付与 & オートゲイン)…', 'info');

      const lastEvent = this.midiEvents[this.midiEvents.length - 1];
      const releaseSec = this.adsr.r / 1000.0;
      const totalSec = lastEvent.start + lastEvent.duration + releaseSec;
      const masterLen = Math.ceil(totalSec * this.sampleRate);
      
      const trackBuffers = new Map(); 
      const trackPolyMaps = new Map(); 
      
      const polyRes = 100;

      for (let idx = 0; idx < this.midiEvents.length; idx++) {
        const ev = this.midiEvents[idx];
        const t = isStem ? ev.track : 0; 
        
        if (!trackBuffers.has(t)) {
          trackBuffers.set(t, new Float64Array(masterLen));
          trackPolyMaps.set(t, new Int32Array(Math.ceil(totalSec * polyRes)));
        }

        const buf = trackBuffers.get(t);
        const polyMap = trackPolyMaps.get(t);
        
        const stShift = (ev.note - 60) + this.globalSemitones;
        const pitchMap = getPitchMap(stShift);
        
        const noteBuf = await this.synth.synthesize(
          this.analysis, pitchMap, speed, this.startTime, this.endTime, this.adsr, ev.duration, null
        );

        const startSample = Math.floor(ev.start * this.sampleRate);
        for (let s = 0; s < noteBuf.length; s++) {
          if (startSample + s < masterLen) {
            buf[startSample + s] += noteBuf[s];
          }
        }

        const sBin = Math.floor(ev.start * polyRes);
        const eBin = Math.floor((ev.start + ev.duration + releaseSec) * polyRes);
        for (let b = sBin; b < eBin && b < polyMap.length; b++) {
          polyMap[b]++;
        }

        this._progress(idx / this.midiEvents.length);
      }

      const zip = new SimpleZip();
      const listContainer = $('midiStemList');
      
      for (const [t, buf] of trackBuffers.entries()) {
        const polyMap = trackPolyMaps.get(t);
        let maxPoly = 1;
        for (let p of polyMap) if (p > maxPoly) maxPoly = p;
        
        const gainFactor = 1.0 / Math.max(1, Math.sqrt(maxPoly));
        let peak = 0;
        for (let s = 0; s < masterLen; s++) {
          buf[s] *= gainFactor;
          if (Math.abs(buf[s]) > peak) peak = Math.abs(buf[s]);
        }
        if (peak > 0.99) {
          const k = 0.95 / peak;
          for (let s = 0; s < masterLen; s++) buf[s] *= k;
        }

        const name = isStem ? `Track_${t+1}.wav` : `harmor-midi-render.wav`;
        const wavBytes = this.exporter.encodeWAV(buf, this.sampleRate);
        zip.addFile(name, wavBytes);

        const btn = document.createElement('button');
        btn.className = 'stem-dl-btn';
        btn.innerHTML = `<span class="track-name">${isStem ? `Track ${t+1}` : 'Master Out'}</span> <span class="icon-w"><svg class="icon"><use href="#icon-save"></use></svg> DL</span>`;
        btn.addEventListener('click', () => {
          this.exporter._triggerDownload(wavBytes, 'audio/wav', name);
        });
        listContainer.appendChild(btn);
      }

      if (trackBuffers.size > 1) {
        const zipData = zip.generate();
        this.exporter._triggerDownload(zipData, 'application/zip', 'harmor-midi-stems.zip');
        
        const btnAll = document.createElement('button');
        btnAll.className = 'btn-primary';
        btnAll.style.width = '100%';
        btnAll.style.fontSize = '11px';
        btnAll.style.marginTop = '4px';
        btnAll.innerHTML = '<svg class="icon"><use href="#icon-box"></use></svg> 全てZIPでダウンロード';
        btnAll.addEventListener('click', () => {
          this.exporter._triggerDownload(zip.generate(), 'application/zip', 'harmor-midi-stems.zip');
        });
        listContainer.appendChild(btnAll);
      } else {
        const [t, buf] = trackBuffers.entries().next().value;
        this.exporter.download(buf, this.sampleRate, 'harmor-midi-render.wav');
      }

      this._status(`MIDI レンダリング完了`, 'ok');

    } catch (e) {
      this._status(`MIDI レンダリングエラー: ${e.message}`, 'err');
    } finally {
      $('renderMidiBtn').disabled = false;
      this._progress(null);
    }
  }

  _drawADSR() {
    const cv = $('adsrCanvas');
    if (!cv) return;
    const cx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth;
    const H = cv.height = cv.clientHeight;
    cx.clearRect(0, 0, W, H);

    const { a, d, s, r } = this.adsr;
    const susDur = 1000; 
    
    const vs = this.adsrViewStart;
    const ve = this.adsrViewEnd;
    const toX = (ms) => ((ms - vs) / (ve - vs)) * W;

    const span = ve - vs;
    let step = 100;
    if (span > 2000) step = 500;
    if (span > 5000) step = 1000;
    
    cx.lineWidth = 1;
    cx.font = '10px monospace';
    cx.textAlign = 'left';
    
    const startGrid = Math.floor(vs / step) * step;
    for (let t = startGrid; t <= ve; t += step) {
      const x = toX(t);
      if (x < 0 || x > W) continue;
      cx.strokeStyle = 'rgba(255,255,255,0.03)';
      cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, H); cx.stroke();
      if (t % (step*2) === 0 || step >= 500) {
        cx.fillStyle = 'rgba(255,255,255,0.2)';
        cx.fillText(`${t}ms`, x + 3, H - 4);
      }
    }

    const baseY = H - 24;
    const maxH  = baseY - 4; 

    const t0 = 0;
    const t1 = a;
    const t2 = a + d;
    const t3 = a + d + susDur;
    const t4 = a + d + susDur + r;

    const y0 = baseY;
    const y1 = 4;
    const y2 = baseY - (s / 100) * maxH;
    const y3 = y2;
    const y4 = baseY;

    cx.beginPath();
    cx.moveTo(toX(t0), y0);
    cx.lineTo(toX(t1), y1);
    cx.lineTo(toX(t2), y2);
    cx.lineTo(toX(t3), y3);
    cx.lineTo(toX(t4), y4);

    cx.lineWidth = 2;
    cx.strokeStyle = '#739AFF'; // プロブルー
    cx.stroke();

    cx.lineTo(toX(t4), H);
    cx.lineTo(toX(t0), H);
    cx.fillStyle = 'rgba(115, 154, 255, 0.1)';
    cx.fill();

    if (this.currentPlayType === 'synth' && this.audio.isPlaying && this.audio._src && this.audio._src.buffer === this.audio.synthBuf) {
      const elapsedMs = (this.audio.ctx.currentTime - this.audio._startAt) * 1000;
      if (elapsedMs >= vs && elapsedMs <= ve) {
        const px = toX(elapsedMs);
        cx.strokeStyle = '#FFB800'; cx.lineWidth = 1.5; // アンバー
        cx.beginPath(); cx.moveTo(px, 0); cx.lineTo(px, H); cx.stroke();
        cx.fillStyle = '#FFB800';
        cx.beginPath(); cx.moveTo(px-5,0); cx.lineTo(px+5,0); cx.lineTo(px,10); cx.fill();
      }
    }
  }

  // --- Piano Roll ---
  _buildPianoRoll() {
    const pr = $('pianoRoll');
    pr.innerHTML = '';
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    
    // 現在鳴っているノート番号（グリッサンド追跡用）
    let activeNote = null;

    const playNote = (n, el) => {
      if (activeNote !== null) return; // 既に鳴っていれば無視（touchmove用）
      if (!this.synthBuffersMap.has(n)) return;
      el.classList.add('playing');
      activeNote = n;
      this.audio.setSynthData(this.synthBuffersMap.get(n), this.sampleRate);
      this._stopAll();
      this.audio.play('synth', 0, this.startTime);
      this._updatePlayButtons('synth');
    };

    const stopNote = (el) => {
      el.classList.remove('playing');
      activeNote = null;
      this._stopAll();
    };

    for(let n = 48; n <= 83; n++) {
      const isBlack = [1,3,6,8,10].includes(n % 12);
      const key = document.createElement('div');
      key.className = `pr-key ${isBlack ? 'black' : 'white'}`;
      key.textContent = isBlack ? '' : noteNames[n % 12] + (Math.floor(n / 12) - 1);
      key.dataset.note = n;
      
      // Mouse Events
      key.addEventListener('mousedown', () => playNote(n, key));
      key.addEventListener('mouseup', () => stopNote(key));
      key.addEventListener('mouseleave', () => { if (key.classList.contains('playing')) stopNote(key); });

      // Touch Events (Glissando / なぞり弾き)
      key.addEventListener('touchstart', e => {
        e.preventDefault();
        playNote(n, key);
      }, {passive: false});

      pr.appendChild(key);
    }

    // TouchMove を使って PianoRoll 全体でのグリッサンドを実現
    pr.addEventListener('touchmove', e => {
      e.preventDefault();
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.classList.contains('pr-key')) {
        const targetNote = parseInt(el.dataset.note);
        if (targetNote !== activeNote) {
          // 現在の音を止める
          const activeEl = pr.querySelector('.pr-key.playing');
          if (activeEl) stopNote(activeEl);
          // 新しい音を鳴らす
          playNote(targetNote, el);
        }
      } else {
        // 鍵盤外に指が出たら止める
        const activeEl = pr.querySelector('.pr-key.playing');
        if (activeEl) stopNote(activeEl);
      }
    }, {passive: false});

    pr.addEventListener('touchend', e => {
      e.preventDefault();
      const activeEl = pr.querySelector('.pr-key.playing');
      if (activeEl) stopNote(activeEl);
    }, {passive: false});
  }

  _exportZip() {
    if (this.synthBuffersMap.size === 0) return;
    this._status('ZIPファイル作成中…', 'info');
    $('exportZipBtn').disabled = true;

    setTimeout(() => {
      try {
        const zip = new SimpleZip();
        const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        
        for (const [note, data] of this.synthBuffersMap.entries()) {
          const name = `${noteNames[note % 12]}${Math.floor(note / 12) - 1}.wav`;
          const wavBytes = this.exporter.encodeWAV(data, this.sampleRate);
          zip.addFile(name, wavBytes);
        }
        
        const zipData = zip.generate();
        this.exporter._triggerDownload(zipData, 'application/zip', 'harmor-multisample.zip');
        this._status('ZIPダウンロード完了', 'ok');
      } catch (e) {
        this._status(`ZIP作成エラー: ${e.message}`, 'err');
      } finally {
        $('exportZipBtn').disabled = false;
      }
    }, 50);
  }

  _resizeCanvases() {
    const cvIds = ['spectrogramCanvas','partialCanvas','uiCanvas'];
    const wrap  = $('spectrogramWrapper');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    for (const id of cvIds) { const c = $(id); c.width = W; c.height = H; }

    const wv = $('waveformCanvas'), ww = $('waveformWrapper');
    wv.width = ww.clientWidth; wv.height = ww.clientHeight;
    
    const uiwv = $('waveformUiCanvas');
    if (uiwv) { uiwv.width = ww.clientWidth; uiwv.height = ww.clientHeight; }

    this._drawADSR();

    if (this.renderer && this.analysis) {
      this.renderer.renderAll();
    } else if (this.renderer && this.audioData) {
      this.renderer._drawWaveform();
      this.renderer._drawWaveformUI();
    }
  }

  _status(msg, level) { const el = $('statusMsg'); el.textContent = msg; el.className = 'status-msg ' + level; }
  _progress(v) { const b = $('progressBar'); b.style.display = v===null?'none':'block'; b.value = v; }
}

/**
 * 非線形ノブ UI コンポーネント
 */
class KnobControl {
  constructor(el, min, max, powerCurve, onChange) {
    this.el = el;
    this.min = min;
    this.max = max;
    this.power = powerCurve;
    this.onChange = onChange;
    this.value = min;

    this.track = el.querySelector('.k-track');
    this.valPath = el.querySelector('.k-val');
    this.ind = el.querySelector('.k-ind');
    
    this.startAng = 140; 
    this.endAng = 400;   
    this.rangeAng = this.endAng - this.startAng;

    this.isDragging = false;
    this.startY = 0;
    this.startNorm = 0;

    this._drawArc(this.track, this.startAng, this.endAng);
    
    const svg = el.querySelector('svg');
    svg.addEventListener('mousedown', (e) => this._onMouseDown(e));
    svg.addEventListener('touchstart', (e) => this._onTouchStart(e), {passive: false});

    window.addEventListener('mousemove', (e) => this._onMouseMove(e));
    window.addEventListener('touchmove', (e) => this._onTouchMove(e), {passive: false});

    window.addEventListener('mouseup', () => this._onMouseUp());
    window.addEventListener('touchend', () => this._onMouseUp());
  }

  setValue(val) {
    this.value = Math.max(this.min, Math.min(this.max, val));
    const norm = Math.pow((this.value - this.min) / (this.max - this.min), 1 / this.power);
    this._updateVisual(norm);
  }

  _onMouseDown(e) {
    this.isDragging = true;
    this.startY = e.clientY;
    this.startNorm = Math.pow((this.value - this.min) / (this.max - this.min), 1 / this.power);
    e.preventDefault();
  }

  _onTouchStart(e) {
    if(e.touches.length !== 1) return;
    this.isDragging = true;
    this.startY = e.touches[0].clientY;
    this.startNorm = Math.pow((this.value - this.min) / (this.max - this.min), 1 / this.power);
    e.preventDefault();
  }

  _onMouseMove(e) {
    if (!this.isDragging) return;
    this._processDrag(e.clientY);
  }

  _onTouchMove(e) {
    if (!this.isDragging || e.touches.length !== 1) return;
    this._processDrag(e.touches[0].clientY);
    e.preventDefault();
  }

  _processDrag(clientY) {
    const dy = this.startY - clientY;
    let norm = this.startNorm + dy / 100.0;
    norm = Math.max(0, Math.min(1, norm));
    
    this.value = this.min + Math.pow(norm, this.power) * (this.max - this.min);
    this._updateVisual(norm);
    if (this.onChange) this.onChange(this.value);
  }

  _onMouseUp() {
    this.isDragging = false;
  }

  _updateVisual(norm) {
    const ang = this.startAng + norm * this.rangeAng;
    this._drawArc(this.valPath, this.startAng, ang);
    
    const rAng = (ang - 90) * Math.PI / 180;
    const x2 = 20 + 8 * Math.cos(rAng);
    const y2 = 20 + 8 * Math.sin(rAng);
    this.ind.setAttribute('x2', x2);
    this.ind.setAttribute('y2', y2);
  }

  _drawArc(pathEl, startDeg, endDeg) {
    if (endDeg - startDeg < 0.1) { pathEl.setAttribute('d', ''); return; }
    
    const cx = 20, cy = 20, r = 16;
    const sRad = (startDeg - 90) * Math.PI / 180;
    const eRad = (endDeg - 90) * Math.PI / 180;
    
    const x1 = cx + r * Math.cos(sRad), y1 = cy + r * Math.sin(sRad);
    const x2 = cx + r * Math.cos(eRad), y2 = cy + r * Math.sin(eRad);
    
    const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
    const d = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
    pathEl.setAttribute('d', d);
  }
}

function $(id) { return document.getElementById(id); }
function formatTime(s) { const m = s/60|0; return `${m}:${String((s%60|0)).padStart(2,'0')}.${String(s*100%100|0).padStart(2,'0')}`; }

window.addEventListener('DOMContentLoaded', () => { window.app = new HarmorApp(); });