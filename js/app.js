'use strict';
class HarmorApp {
  constructor() {
    this.audio = new AudioManager();
    this.exporter = new WAVExporter();
    this.audioData = null; this.sampleRate = 44100;
    this.analysis = null; this.synthData = null;
    
    // 追加状態管理
    this.mode = 'synth'; 
    this.playbackSpeed = 1.0;
    this.globalSemitones = 0;
    this.synthBuffersMap = new Map(); // MIDI note -> Float64Array
    
    this._initRenderer();
    this._buildPianoRoll();
    this._bindUI();
  }

  // --- UI Bindings ---
  _bindUI() {
    // 既存Load処理
    $('fileInput').addEventListener('change', e => { if(e.target.files[0]) this._loadFile(e.target.files[0]); });
    $('loadBtn').addEventListener('click', () => $('fileInput').click());
    $('analyzeBtn').addEventListener('click', () => this._analyze());

    // タブ切替
    $('tabSynth').addEventListener('click', () => this._switchMode('synth'));
    $('tabVocal').addEventListener('click', () => this._switchMode('vocal'));

    // スライダー
    const slPitch = $('pitchSlider'), slSpeed = $('speedSlider');
    slPitch.addEventListener('input', e => { this.globalSemitones = parseFloat(e.target.value); $('pitchValue').textContent = `+${this.globalSemitones} st`; });
    slSpeed.addEventListener('input', e => { this.playbackSpeed = parseFloat(e.target.value); $('speedValue').textContent = `${this.playbackSpeed.toFixed(2)}x`; });

    // Vocal UI
    $('snapCheck').addEventListener('change', e => { this.renderer.isSnapMode = e.target.checked; });
    $('showOrigF0Check').addEventListener('change', e => { this.renderer.showOrigF0 = e.target.checked; this.renderer.renderAll(); });
    $('resetF0Btn').addEventListener('click', () => { this.renderer.editedF0 = null; this.renderer.renderAll(); });

    // Synth
    $('synthesizeBtn').addEventListener('click', () => this._synthesize());
    $('exportZipBtn').addEventListener('click', () => this._exportZip());
    
    // Transport 既存通り
    $('playOrigBtn').addEventListener('click', () => this.audio.play('orig'));
    $('playSynthBtn').addEventListener('click', () => this.audio.play('synth'));
    $('stopBtn').addEventListener('click', () => this.audio.stop());
    $('exportBtn').addEventListener('click', () => this.exporter.download(this.synthData, this.sampleRate, 'harmor.wav'));
  }

  _switchMode(mode) {
    this.mode = mode;
    this.renderer.appMode = mode;
    $('tabSynth').classList.toggle('active', mode === 'synth');
    $('tabVocal').classList.toggle('active', mode === 'vocal');
    $('panelSynth').style.display = mode === 'synth' ? 'block' : 'none';
    $('panelVocal').style.display = mode === 'vocal' ? 'block' : 'none';
    $('pianoRoll').style.display  = mode === 'synth' && this.synthBuffersMap.size > 0 ? 'flex' : 'none';
    if(this.analysis) this.renderer.renderAll();
  }

  // 既存 _loadFile() 省略... (そのまま実装)
  async _loadFile(file) {
    const dec = await this.audio.loadFile(file);
    this.sampleRate = dec.sampleRate;
    this.audioData = dec.getChannelData(0); // 簡易化: 左chのみ取得
    $('analyzeBtn').disabled = false; $('playOrigBtn').disabled = false;
    this._status('読み込み完了。「解析」を押してください', 'ok');
  }

  async _analyze() {
    this._status('解析中…', 'info'); this._progress(0);
    this.analyzer = new SpectralAnalyzer({ sampleRate: this.sampleRate, fftSize: parseInt($('fftSizeSelect').value) });
    this.analysis = await this.analyzer.analyze(this.audioData, p => this._progress(p));
    this.synth = new AdditiveSynthesizer(this.sampleRate, this.analysis.hopSize);
    
    this.renderer.setAnalysis(this.analysis, this.audioData);
    this.renderer.f0Data = this.analysis.f0Data; // Vocalモード用F0転送
    this.renderer.editedF0 = null;
    
    $('synthesizeBtn').disabled = false;
    this._status('解析完了', 'ok'); this._progress(null);
  }

  // 再合成（モードに応じたPitchMap生成とマルチサンプル化）
  async _synthesize() {
    if(!this.analysis) return;
    $('synthesizeBtn').disabled = true;
    this._status('プレビュー再合成中…', 'info'); this._progress(0);

    // Vocalモードのピッチカーブ反映マップ
    const getPitchMap = (baseSt) => {
      const baseRatio = Math.pow(2, baseSt / 12);
      return (fi, freq) => {
        let r = baseRatio;
        if (this.mode === 'vocal' && this.renderer.editedF0 && this.analysis.f0Data[fi] > 0) {
          const edited = this.renderer.editedF0[fi];
          if (edited > 0) r *= (edited / this.analysis.f0Data[fi]);
        }
        return r;
      };
    };

    // 1. メインプレビュー用生成
    const speed = this.mode === 'synth' ? this.playbackSpeed : 1.0;
    this.synthData = await this.synth.synthesize(this.analysis, getPitchMap(this.globalSemitones), speed, p => this._progress(p));
    this.audio.setSynthData(this.synthData, this.sampleRate);
    $('playSynthBtn').disabled = false; $('exportBtn').disabled = false;

    // 2. Synthモードなら24音(C3〜B4)自動バッチ生成
    if (this.mode === 'synth') {
       this._status('マルチサンプル自動生成中…', 'info');
       this.synthBuffersMap.clear();
       // RootをC4(60)とする。C3(48)〜B4(71)の24音
       for (let note = 48; note <= 71; note++) {
         const stShift = (note - 60) + this.globalSemitones;
         const data = await this.synth.synthesize(this.analysis, getPitchMap(stShift), speed, null);
         this.synthBuffersMap.set(note, data);
         this._progress((note - 48) / 24);
       }
       $('pianoRoll').style.display = 'flex';
       $('exportZipBtn').disabled = false;
    }
    
    this._status('再合成完了', 'ok'); this._progress(null);
    $('synthesizeBtn').disabled = false;
  }

  // --- ピアノロール & エクスポート ---
  _buildPianoRoll() {
    const pr = $('pianoRoll');
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    for(let n=48; n<=71; n++) {
      const isBlack = [1,3,6,8,10].includes(n%12);
      const key = document.createElement('div');
      key.className = `pr-key ${isBlack ? 'black' : 'white'}`;
      key.textContent = isBlack ? '' : noteNames[n%12] + (Math.floor(n/12)-1);
      key.addEventListener('mousedown', () => {
         if(!this.synthBuffersMap.has(n)) return;
         key.classList.add('playing');
         this.audio.setSynthData(this.synthBuffersMap.get(n), this.sampleRate);
         this.audio.play('synth');
      });
      key.addEventListener('mouseup', () => key.classList.remove('playing'));
      key.addEventListener('mouseleave', () => key.classList.remove('playing'));
      pr.appendChild(key);
    }
  }

  _exportZip() {
    if(this.synthBuffersMap.size === 0) return;
    this._status('ZIP作成中…', 'info');
    setTimeout(() => {
      const zip = new SimpleZip();
      const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      for (const [note, data] of this.synthBuffersMap.entries()) {
        const name = `${noteNames[note%12]}${Math.floor(note/12)-1}.wav`;
        const wav = this.exporter.encodeWAV(data, this.sampleRate);
        zip.addFile(name, wav);
      }
      triggerDownload(zip.generate(), 'application/zip', 'harmor-multisample.zip');
      this._status('ZIPダウンロード完了', 'ok');
    }, 50);
  }

  _initRenderer() { this.renderer = new SpectralRenderer({ uiCanvas: $('uiCanvas'), spectrogramCanvas: $('spectrogramCanvas'), partialCanvas: $('partialCanvas'), waveformCanvas: $('waveformCanvas') }); }
  _status(msg, type) { const s = $('statusMsg'); s.textContent = msg; s.className = 'status-msg ' + type; }
  _progress(v) { const p = $('progressBar'); p.style.display = v===null?'none':'block'; p.value = v; }
}
function $(id) { return document.getElementById(id); }
window.addEventListener('DOMContentLoaded', () => window.app = new HarmorApp());