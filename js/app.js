'use strict';
/**
 * app.js — Application Controller
 */
class HarmorApp {
  constructor() {
    this.audio    = new AudioManager();
    this.exporter = new WAVExporter();
    this.analyzer = null;
    this.synth    = null;
    this.renderer = null;

    this.audioData   = null;   // Float32Array mono
    this.sampleRate  = 44100;
    this.analysis    = null;
    this.synthData   = null;   // Float64Array (Single preview)

    // State
    this.mode = 'synth'; // 'synth' | 'vocal'
    this.globalSemitones = 0;
    this.playbackSpeed = 1.0;
    this.synthBuffersMap = new Map(); // For piano roll: note(midi) -> Float64Array

    this._initRenderer();
    this._buildPianoRoll();
    this._bindUI();
  }

  // -----------------------------------------------------------------------
  // Init & UI Binding
  // -----------------------------------------------------------------------
  _initRenderer() {
    this.renderer = new SpectralRenderer({
      spectrogramCanvas: $('spectrogramCanvas'),
      partialCanvas:     $('partialCanvas'),
      uiCanvas:          $('uiCanvas'),
      waveformCanvas:    $('waveformCanvas'),
    });

    this.audio.onTimeUpdate = (t) => {
      this.renderer.setPlayhead(t);
      $('timeDisplay').textContent = formatTime(t);
    };
    this.audio.onEnded = () => {
      $('playOrigBtn').classList.remove('active');
      $('playSynthBtn').classList.remove('active');
    };
  }

  _bindUI() {
    // File
    const fi = $('fileInput');
    $('loadBtn').addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => { if (e.target.files[0]) this._loadFile(e.target.files[0]); });

    // Mode Tabs
    $('tabSynth').addEventListener('click', () => this._switchMode('synth'));
    $('tabVocal').addEventListener('click', () => this._switchMode('vocal'));

    // Analysis
    $('analyzeBtn').addEventListener('click', () => this._analyze());

    // Controls
    this._bindSlider('pitchSlider', 'pitchValue', v => {
      this.globalSemitones = v;
    }, st => st >= 0 ? `+${st.toFixed(1)} st` : `${st.toFixed(1)} st`);

    this._bindSlider('speedSlider', 'speedValue', v => {
      this.playbackSpeed = v;
    }, v => `${v.toFixed(2)}x`);

    // Vocal overrides
    $('snapCheck').addEventListener('change', e => { this.renderer.isSnapMode = e.target.checked; });
    $('showOrigF0Check').addEventListener('change', e => { 
      this.renderer.showOrigF0 = e.target.checked; 
      this.renderer.renderAll(); 
    });
    $('resetF0Btn').addEventListener('click', () => {
      this.renderer.editedF0 = null;
      this.renderer.renderAll();
    });

    // Synthesize & Export
    $('synthesizeBtn').addEventListener('click', () => this._synthesize());
    $('exportZipBtn').addEventListener('click', () => this._exportZip());

    // Transport
    $('playOrigBtn').addEventListener('click', () => {
      this.audio.play('orig');
      $('playOrigBtn').classList.add('active'); $('playSynthBtn').classList.remove('active');
    });
    $('playSynthBtn').addEventListener('click', () => {
      if (!this.synthData) return;
      this.audio.play('synth');
      $('playSynthBtn').classList.add('active'); $('playOrigBtn').classList.remove('active');
    });
    $('stopBtn').addEventListener('click', () => {
      this.audio.stop();
      $('playOrigBtn').classList.remove('active'); $('playSynthBtn').classList.remove('active');
    });

    $('exportBtn').addEventListener('click', () => {
      if (this.synthData) {
        this.exporter.download(this.synthData, this.sampleRate, 'harmor-export.wav');
        this._status('単一WAV エクスポート完了', 'ok');
      }
    });

    // Resize handling
    window.addEventListener('resize', () => this._resizeCanvases());
    this._resizeCanvases();
  }

  _bindSlider(id, displayId, onChange, fmt) {
    const sl = $(id), disp = $(displayId);
    const update = () => { const v = parseFloat(sl.value); onChange(v); disp.textContent = fmt(v); };
    sl.addEventListener('input', update);
    update();
  }

  _switchMode(mode) {
    this.mode = mode;
    this.renderer.appMode = mode;
    $('tabSynth').classList.toggle('active', mode === 'synth');
    $('tabVocal').classList.toggle('active', mode === 'vocal');
    $('panelSynth').style.display = mode === 'synth' ? 'block' : 'none';
    $('panelVocal').style.display = mode === 'vocal' ? 'block' : 'none';
    $('pianoRoll').style.display  = mode === 'synth' && this.synthBuffersMap.size > 0 ? 'flex' : 'none';
    if (this.analysis) this.renderer.renderAll();
  }

  // -----------------------------------------------------------------------
  // File & Analysis
  // -----------------------------------------------------------------------
  async _loadFile(file) {
    this._status('読み込み中…', 'info');
    try {
      const decoded = await this.audio.loadFile(file);
      this.sampleRate = decoded.sampleRate;

      // 正しいモノラルダウンミックス処理
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
      this.renderer._drawWaveform();

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

      // Renderer連携
      this.renderer.setAnalysis(this.analysis, this.audioData);
      this.renderer.f0Data = this.analysis.f0Data; // 推定F0を渡す
      this.renderer.editedF0 = null;

      $('partialCountBadge').textContent = `${this.analysis.partials.length} partials`;
      $('synthesizeBtn').disabled = false;
      this._status(`解析完了 (${this.analysis.partials.length} partials)`, 'ok');
    } catch(e) {
      this._status(`解析エラー: ${e.message}`, 'err');
    } finally {
      $('analyzeBtn').disabled = false;
      this._progress(null);
    }
  }

  // -----------------------------------------------------------------------
  // Resynthesis (Preview + Multi-sample batch)
  // -----------------------------------------------------------------------
  async _synthesize() {
    if (!this.analysis) return;
    $('synthesizeBtn').disabled = true;
    this._status('メインプレビュー生成中…', 'info');
    this._progress(0);

    // 歌わせモードのピッチカーブを統合する PitchMap 生成関数
    const getPitchMap = (baseSemitones) => {
      const baseRatio = Math.pow(2, baseSemitones / 12);
      return (fi, freq) => {
        let r = baseRatio;
        // Vocalモードで、ユーザー上書きF0が存在し、元のF0が存在するフレームなら比率を適用
        if (this.mode === 'vocal' && this.renderer.editedF0 && this.analysis.f0Data[fi] > 0) {
          const edited = this.renderer.editedF0[fi];
          if (edited > 0) r *= (edited / this.analysis.f0Data[fi]);
        }
        return r;
      };
    };

    try {
      // 1. メインのプレビュー波形を合成
      const speed = this.mode === 'synth' ? this.playbackSpeed : 1.0;
      this.synthData = await this.synth.synthesize(
        this.analysis, getPitchMap(this.globalSemitones), speed, p => this._progress(p)
      );

      this.audio.setSynthData(this.synthData, this.sampleRate);
      $('playSynthBtn').disabled = false;
      $('exportBtn').disabled = false;

      // 2. シンセ作成モードなら 24音(C3〜B4) のバッチ自動生成を走らせる
      if (this.mode === 'synth') {
        this._status('マルチサンプル自動生成中 (C3 - B4)…', 'info');
        this.synthBuffersMap.clear();
        
        // RootをC4(Midi 60)とする。C3(48)〜B4(71)の24音
        for (let note = 48; note <= 71; note++) {
          const stShift = (note - 60) + this.globalSemitones;
          const map = getPitchMap(stShift);
          const data = await this.synth.synthesize(this.analysis, map, speed, null); // バックグラウンド
          this.synthBuffersMap.set(note, data);
          this._progress((note - 48) / 24);
        }

        $('pianoRoll').style.display = 'flex';
        $('exportZipBtn').disabled = false;
      }

      this._status('再合成完了 — 「Synth」またはピアノロールで試聴できます', 'ok');
    } catch(e) {
      this._status(`エラー: ${e.message}`, 'err');
    } finally {
      $('synthesizeBtn').disabled = false;
      this._progress(null);
    }
  }

  // -----------------------------------------------------------------------
  // Piano Roll & ZIP Export
  // -----------------------------------------------------------------------
  _buildPianoRoll() {
    const pr = $('pianoRoll');
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    
    // C3(48) to B4(71)
    for(let n = 48; n <= 71; n++) {
      const isBlack = [1,3,6,8,10].includes(n % 12);
      const key = document.createElement('div');
      key.className = `pr-key ${isBlack ? 'black' : 'white'}`;
      
      // 白鍵のみラベル表示 (例: C3)
      key.textContent = isBlack ? '' : noteNames[n % 12] + (Math.floor(n / 12) - 1);
      
      key.addEventListener('mousedown', () => {
        if (!this.synthBuffersMap.has(n)) return;
        key.classList.add('playing');
        this.audio.setSynthData(this.synthBuffersMap.get(n), this.sampleRate);
        this.audio.play('synth'); // 即時試聴
      });
      key.addEventListener('mouseup', () => key.classList.remove('playing'));
      key.addEventListener('mouseleave', () => key.classList.remove('playing'));
      pr.appendChild(key);
    }
  }

  _exportZip() {
    if (this.synthBuffersMap.size === 0) return;
    this._status('ZIPファイル作成中…', 'info');
    $('exportZipBtn').disabled = true;

    // 非同期回避のためsetTimeout
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

  // -----------------------------------------------------------------------
  // UI Helpers
  // -----------------------------------------------------------------------
  _resizeCanvases() {
    const cvIds = ['spectrogramCanvas','partialCanvas','uiCanvas'];
    const wrap  = $('spectrogramWrapper');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    for (const id of cvIds) { const c = $(id); c.width = W; c.height = H; }

    const wv = $('waveformCanvas'), ww = $('waveformWrapper');
    wv.width = ww.clientWidth; wv.height = ww.clientHeight;

    if (this.renderer && this.analysis) this.renderer.renderAll();
    else if (this.renderer && this.audioData) this.renderer._drawWaveform();
  }

  _status(msg, level) { const el = $('statusMsg'); el.textContent = msg; el.className = 'status-msg ' + level; }
  _progress(v) { const b = $('progressBar'); b.style.display = v===null?'none':'block'; b.value = v; }
}

function $(id) { return document.getElementById(id); }
function formatTime(s) { const m = s/60|0; return `${m}:${String((s%60|0)).padStart(2,'0')}.${String(s*100%100|0).padStart(2,'0')}`; }

window.addEventListener('DOMContentLoaded', () => { window.app = new HarmorApp(); });