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

    this.adsr = { a: 10, d: 500, s: 100, r: 300 };
    this.midiEvents = [];

    this._initRenderer();
    this._buildPianoRoll();
    this._bindUI();
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
      if (this.audio._src && this.audio._src.buffer === this.audio.synthBuf) {
         const elapsedSec = (this.audio.ctx.currentTime - this.audio._startAt);
         if (this.playbackSpeed <= 0.001) {
             uiTime = this.startTime; // フリーズ時はStart位置に固定
         } else {
             uiTime = this.startTime + (elapsedSec * this.playbackSpeed);
         }
      }
      this.renderer.setPlayhead(uiTime);
      $('timeDisplay').textContent = formatTime(uiTime);
    };
    
    this.audio.onEnded = () => {
      $('playOrigBtn').classList.remove('active');
      $('playSynthBtn').classList.remove('active');
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

    const bindADSR = (key, sliderId, numId) => {
      const sl = $(sliderId), num = $(numId);
      const update = (val) => {
        let v = parseInt(val);
        if(isNaN(v)) return;
        this.adsr[key] = v;
        sl.value = v; num.value = v;
        this._drawADSR();
      };
      sl.addEventListener('input', e => update(e.target.value));
      num.addEventListener('change', e => update(e.target.value));
    };
    bindADSR('a', 'adsrASlider', 'adsrANum');
    bindADSR('d', 'adsrDSlider', 'adsrDNum');
    bindADSR('s', 'adsrSSlider', 'adsrSNum');
    bindADSR('r', 'adsrRSlider', 'adsrRNum');

    this._bindScrollControls();

    // ピッチカーブ編集用バインディング
    $('snapCheck').addEventListener('change', e => { this.renderer.isSnapMode = e.target.checked; });
    $('showBaseF0Check').addEventListener('change', e => { this.renderer.showBaseF0 = e.target.checked; this.renderer.renderAll(); });
    $('eraseCheck').addEventListener('change', e => { this.renderer.isEraseMode = e.target.checked; });

    const updateEditTarget = () => { this.renderer.editTarget = $('radioEditBase').checked ? 'base' : 'edited'; };
    $('radioEditBase').addEventListener('change', updateEditTarget);
    $('radioEditEdited').addEventListener('change', updateEditTarget);

    $('resetBaseBtn').addEventListener('click', () => {
      if (confirm('推定カーブを初期状態にリセットしますか？')) {
        if (this.renderer.f0Data && this.renderer.baseF0) {
           this.renderer.baseF0 = new Float32Array(this.renderer.f0Data);
           this.renderer.renderAll();
        }
      }
    });
    $('resetEditedBtn').addEventListener('click', () => {
      if (confirm('補正後カーブを全てクリアしますか？')) {
        if (this.renderer.editedF0) {
           this.renderer.editedF0 = new Float32Array(this.renderer.f0Data.length);
           this.renderer.renderAll();
        }
      }
    });

    $('synthesizeBtn').addEventListener('click', () => this._synthesize());
    $('exportZipBtn').addEventListener('click', () => this._exportZip());
    $('renderMidiBtn').addEventListener('click', () => this._renderMidiAndDownload());

    $('playOrigBtn').addEventListener('click', () => {
      this.audio.play('orig', this.startTime, this.startTime);
      $('playOrigBtn').classList.add('active'); $('playSynthBtn').classList.remove('active');
    });
    $('playSynthBtn').addEventListener('click', () => {
      if (!this.synthData) return;
      this.audio.play('synth', 0, this.startTime);
      $('playSynthBtn').classList.add('active'); $('playOrigBtn').classList.remove('active');
    });
    $('stopBtn').addEventListener('click', () => {
      this.audio.stop();
      $('playOrigBtn').classList.remove('active'); $('playSynthBtn').classList.remove('active');
      this.renderer.setPlayhead(this.startTime);
      $('timeDisplay').textContent = formatTime(this.startTime);
    });

    $('exportBtn').addEventListener('click', () => {
      if (this.synthData) {
        this.exporter.download(this.synthData, this.sampleRate, 'harmor-export.wav');
        this._status('単一WAV エクスポート完了', 'ok');
      }
    });

    window.addEventListener('resize', () => this._resizeCanvases());
    this._resizeCanvases();
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

      // 複数音書き出しのチェック確認
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
      this._resizeCanvases(); // ピアノロール表示切替に伴うリサイズ
    }
  }

  async _renderMidiAndDownload() {
    if (!this.analysis || this.midiEvents.length === 0) return;
    
    $('renderMidiBtn').disabled = true;
    this._status('MIDI レンダリング中 (Workerによる音素生成)…', 'info');
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
      this._status('MIDI ミックス中 (ADSR付与 & オートゲイン)…', 'info');

      const lastEvent = this.midiEvents[this.midiEvents.length - 1];
      const releaseSec = this.adsr.r / 1000.0;
      const totalSec = lastEvent.start + lastEvent.duration + releaseSec;
      const masterLen = Math.ceil(totalSec * this.sampleRate);
      const masterBuf = new Float64Array(masterLen);

      const polyRes = 100;
      const polyMap = new Int32Array(Math.ceil(totalSec * polyRes));
      let maxPoly = 1;

      for (let idx = 0; idx < this.midiEvents.length; idx++) {
        const ev = this.midiEvents[idx];
        const stShift = (ev.note - 60) + this.globalSemitones;
        const pitchMap = getPitchMap(stShift);
        
        const noteBuf = await this.synth.synthesize(
          this.analysis, pitchMap, speed, this.startTime, this.endTime, this.adsr, ev.duration, null
        );

        const startSample = Math.floor(ev.start * this.sampleRate);
        for (let s = 0; s < noteBuf.length; s++) {
          if (startSample + s < masterLen) {
            masterBuf[startSample + s] += noteBuf[s];
          }
        }

        const sBin = Math.floor(ev.start * polyRes);
        const eBin = Math.floor((ev.start + ev.duration + releaseSec) * polyRes);
        for (let b = sBin; b < eBin && b < polyMap.length; b++) {
          polyMap[b]++;
          if (polyMap[b] > maxPoly) maxPoly = polyMap[b];
        }

        this._progress(idx / this.midiEvents.length);
      }

      const gainFactor = 1.0 / Math.max(1, Math.sqrt(maxPoly));
      let peak = 0;
      for (let s = 0; s < masterLen; s++) {
        masterBuf[s] *= gainFactor;
        if (Math.abs(masterBuf[s]) > peak) peak = Math.abs(masterBuf[s]);
      }
      if (peak > 0.99) {
        const k = 0.95 / peak;
        for (let s = 0; s < masterLen; s++) masterBuf[s] *= k;
      }

      this.exporter.download(masterBuf, this.sampleRate, 'harmor-midi-render.wav');
      this._status(`MIDI レンダリング完了 (Max Polyphony: ${maxPoly})`, 'ok');

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
    const totalParts = Math.max(2000, a + d + r + 1000); 
    const ax_px = (a / totalParts) * W;
    const dx_px = (d / totalParts) * W;
    const rx_px = (r / totalParts) * W;
    const sx_px = Math.max(10, W - ax_px - dx_px - rx_px);

    const susY = H - (s / 100) * (H - 8) - 4;
    const startY = H - 1;

    cx.beginPath();
    cx.moveTo(0, startY);
    cx.lineTo(ax_px, 4);
    cx.lineTo(ax_px + dx_px, susY);
    cx.lineTo(ax_px + dx_px + sx_px, susY);
    cx.lineTo(W, startY);

    cx.lineWidth = 2;
    cx.strokeStyle = '#58a6ff';
    cx.stroke();

    cx.lineTo(W, H);
    cx.lineTo(0, H);
    cx.fillStyle = 'rgba(88, 166, 255, 0.12)';
    cx.fill();
  }

  _buildPianoRoll() {
    const pr = $('pianoRoll');
    pr.innerHTML = '';
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    
    for(let n = 48; n <= 83; n++) {
      const isBlack = [1,3,6,8,10].includes(n % 12);
      const key = document.createElement('div');
      key.className = `pr-key ${isBlack ? 'black' : 'white'}`;
      key.textContent = isBlack ? '' : noteNames[n % 12] + (Math.floor(n / 12) - 1);
      
      key.addEventListener('mousedown', () => {
        if (!this.synthBuffersMap.has(n)) return;
        key.classList.add('playing');
        this.audio.setSynthData(this.synthBuffersMap.get(n), this.sampleRate);
        this.audio.play('synth', 0, this.startTime);
      });
      
      key.addEventListener('mouseup', () => {
        key.classList.remove('playing');
        this.audio.stop();
      });
      key.addEventListener('mouseleave', () => {
        if (key.classList.contains('playing')) {
          key.classList.remove('playing');
          this.audio.stop();
        }
      });
      pr.appendChild(key);
    }
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

function $(id) { return document.getElementById(id); }
function formatTime(s) { const m = s/60|0; return `${m}:${String((s%60|0)).padStart(2,'0')}.${String(s*100%100|0).padStart(2,'0')}`; }

window.addEventListener('DOMContentLoaded', () => { window.app = new HarmorApp(); });