'use strict';
/**
 * audio.js — Web Audio API wrapper
 * Handles: file decode, original/synth buffer playback, position tracking.
 */
class AudioManager {
  constructor() {
    this._ctx    = null;
    this.origBuf = null;  // AudioBuffer (original decoded)
    this.synthBuf = null; // AudioBuffer (synthesized)
    this._src    = null;  // current BufferSourceNode
    this._startAt = 0;    // ctx.currentTime when play() was called
    this._offset = 0;     // playback start position in seconds
    this.isPlaying = false;
    this._raf  = null;
    this.onTimeUpdate = null; // (currentTimeSec) => void
    this.onEnded = null;
  }

  get ctx() {
    if (!this._ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API not supported');
      this._ctx = new AC();
    }
    return this._ctx;
  }

  /** Decode audio file → AudioBuffer. Returns AudioBuffer. */
  async loadFile(file) {
    const ab  = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    this.origBuf = buf;
    return buf;
  }

  /**
   * Convert Float64Array (synthesized) into AudioBuffer for playback.
   * Normalizes to prevent clipping.
   */
  setSynthData(f64data, sampleRate) {
    const n   = f64data.length;
    const buf = this.ctx.createBuffer(1, n, sampleRate);
    const ch  = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = f64data[i];
    this.synthBuf = buf;
  }

  /**
   * @param {'orig'|'synth'} which
   * @param {number} startSec  offset within buffer
   */
  play(which, startSec = 0) {
    this.stop();
    const buf = which === 'synth' ? this.synthBuf : this.origBuf;
    if (!buf) { console.warn('AudioManager.play: no buffer for', which); return; }
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0, Math.max(0, startSec));
    src.onended = () => {
      this.isPlaying = false;
      cancelAnimationFrame(this._raf);
      if (this.onEnded) this.onEnded();
    };
    this._src     = src;
    this._startAt = ctx.currentTime;
    this._offset  = startSec;
    this.isPlaying = true;
    this._tick();
  }

  stop() {
    if (this._src) { try { this._src.stop(); } catch(_) {} this._src = null; }
    this.isPlaying = false;
    cancelAnimationFrame(this._raf);
  }

  currentTime() {
    if (!this.isPlaying) return this._offset;
    return this._offset + (this.ctx.currentTime - this._startAt);
  }

  _tick() {
    if (this.onTimeUpdate) this.onTimeUpdate(this.currentTime());
    if (this.isPlaying) this._raf = requestAnimationFrame(() => this._tick());
  }
}
