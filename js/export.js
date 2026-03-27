'use strict';
/**
 * export.js — WAV & ZIP Export Engine
 * Encodes audio to 16-bit PCM WAV and bundles multiple WAVs into a ZIP.
 */

class WAVExporter {
  /**
   * Float64Array の音声を 16bit PCM WAV の Uint8Array にエンコードする
   */
  encodeWAV(samples, sampleRate) {
    const n          = samples.length;
    const bps        = 16;
    const nCh        = 1;
    const byteRate   = sampleRate * nCh * bps / 8;
    const blockAlign = nCh * bps / 8;
    const dataBytes  = n * blockAlign;
    const buf        = new ArrayBuffer(44 + dataBytes);
    const dv         = new DataView(buf);

    const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

    str(0,  'RIFF');
    dv.setUint32(4,   36 + dataBytes, true);
    str(8,  'WAVE');
    str(12, 'fmt ');
    dv.setUint32(16,  16,          true);
    dv.setUint16(20,  1,           true);
    dv.setUint16(22,  nCh,         true);
    dv.setUint32(24,  sampleRate,  true);
    dv.setUint32(28,  byteRate,    true);
    dv.setUint16(32,  blockAlign,  true);
    dv.setUint16(34,  bps,         true);
    str(36, 'data');
    dv.setUint32(40,  dataBytes,   true);

    let off = 44;
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(off, v < 0 ? v * 32768 : v * 32767, true);
      off += 2;
    }
    return new Uint8Array(buf);
  }

  /**
   * 単体の WAV ファイルとしてダウンロード
   */
  download(samples, sampleRate, filename = 'harmor-export.wav') {
    const wavBytes = this.encodeWAV(samples, sampleRate);
    this._triggerDownload(wavBytes, 'audio/wav', filename);
  }

  _triggerDownload(uint8Arr, mime, filename) {
    const blob = new Blob([uint8Arr], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/**
 * Simple ZIP Encoder (STORE method / No compression)
 * ブラウザ上で依存ライブラリなしで複数ファイルをZIPにまとめる
 */
class SimpleZip {
  constructor() {
    this.files = [];
  }

  addFile(filename, uint8Array) {
    const nameBytes = new Uint8Array(filename.length);
    for (let i = 0; i < filename.length; i++) {
      nameBytes[i] = filename.charCodeAt(i) & 0xFF; // ASCII only
    }
    this.files.push({ name: nameBytes, data: uint8Array });
  }

  generate() {
    let localDataSize = 0;
    let centralDirSize = 0;
    
    for (const f of this.files) {
      localDataSize += 30 + f.name.length + f.data.length;
      centralDirSize += 46 + f.name.length;
    }
    
    const buf = new Uint8Array(localDataSize + centralDirSize + 22);
    const dv = new DataView(buf.buffer);
    let off = 0;
    const localOffsets = [];

    // 1. Local file headers & data
    for (const f of this.files) {
      localOffsets.push(off);
      dv.setUint32(off, 0x04034b50, true); off += 4; // signature
      dv.setUint16(off, 10, true); off += 2;         // version needed
      dv.setUint16(off, 0, true); off += 2;          // flags
      dv.setUint16(off, 0, true); off += 2;          // compression: STORE
      off += 4; // time/date (0)
      
      const crc = this._crc32(f.data);
      dv.setUint32(off, crc, true); off += 4;
      dv.setUint32(off, f.data.length, true); off += 4; // compressed size
      dv.setUint32(off, f.data.length, true); off += 4; // uncompressed size
      dv.setUint16(off, f.name.length, true); off += 2; // name length
      dv.setUint16(off, 0, true); off += 2;             // extra field length
      
      buf.set(f.name, off); off += f.name.length;
      buf.set(f.data, off); off += f.data.length;
    }

    const cdOffset = off;

    // 2. Central Directory
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      dv.setUint32(off, 0x02014b50, true); off += 4;
      dv.setUint16(off, 10, true); off += 2;
      dv.setUint16(off, 10, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;
      off += 4; // time/date
      dv.setUint32(off, this._crc32(f.data), true); off += 4;
      dv.setUint32(off, f.data.length, true); off += 4;
      dv.setUint32(off, f.data.length, true); off += 4;
      dv.setUint16(off, f.name.length, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;
      dv.setUint16(off, 0, true); off += 2;
      dv.setUint32(off, 0, true); off += 4;
      dv.setUint32(off, localOffsets[i], true); off += 4;
      
      buf.set(f.name, off); off += f.name.length;
    }

    // 3. End of Central Directory
    dv.setUint32(off, 0x06054b50, true); off += 4;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, this.files.length, true); off += 2;
    dv.setUint16(off, this.files.length, true); off += 2;
    dv.setUint32(off, off - cdOffset, true); off += 4; // size of CD
    dv.setUint32(off, cdOffset, true); off += 4;       // offset of CD
    dv.setUint16(off, 0, true); off += 2;
    
    return buf;
  }

  _crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      c ^= data[i];
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
    }
    return c ^ 0xFFFFFFFF;
  }
}