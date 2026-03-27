'use strict';
class WAVExporter {
  // ArrayBufferを返すように分離
  encodeWAV(samples, sampleRate) {
    const n = samples.length, bps = 16, nCh = 1;
    const blockAlign = nCh * bps / 8, byteRate = sampleRate * blockAlign, dataBytes = n * blockAlign;
    const buf = new ArrayBuffer(44 + dataBytes), dv = new DataView(buf);

    const str = (off, s) => { for(let i=0;i<s.length;i++) dv.setUint8(off+i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true);
    str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, byteRate, true);
    dv.setUint16(32, blockAlign, true); dv.setUint16(34, bps, true);
    str(36, 'data'); dv.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(off, v < 0 ? v * 32768 : v * 32767, true); off += 2;
    }
    return new Uint8Array(buf);
  }

  download(samples, sampleRate, filename) {
    const wavBytes = this.encodeWAV(samples, sampleRate);
    triggerDownload(wavBytes, 'audio/wav', filename);
  }
}

// 依存ゼロの簡易ZIP（無圧縮・STORE）エンコーダ
class SimpleZip {
  constructor() { this.files = []; }
  addFile(name, uint8Array) {
    const nameBytes = new Uint8Array(name.length);
    for(let i=0;i<name.length;i++) nameBytes[i] = name.charCodeAt(i);
    this.files.push({ name: nameBytes, data: uint8Array });
  }
  generate() {
    let localSize = 0, cdSize = 0;
    for (const f of this.files) {
      localSize += 30 + f.name.length + f.data.length;
      cdSize += 46 + f.name.length;
    }
    const buf = new Uint8Array(localSize + cdSize + 22);
    const dv = new DataView(buf.buffer);
    let off = 0;
    const localOffsets = [];

    // Local files
    for (const f of this.files) {
      localOffsets.push(off);
      dv.setUint32(off, 0x04034b50, true); off+=4; dv.setUint16(off, 10, true); off+=2;
      dv.setUint16(off, 0, true); off+=2; dv.setUint16(off, 0, true); off+=2; // STORE
      off+=4; // time/date
      const crc = this._crc32(f.data);
      dv.setUint32(off, crc, true); off+=4;
      dv.setUint32(off, f.data.length, true); off+=4;
      dv.setUint32(off, f.data.length, true); off+=4;
      dv.setUint16(off, f.name.length, true); off+=2;
      dv.setUint16(off, 0, true); off+=2;
      buf.set(f.name, off); off += f.name.length;
      buf.set(f.data, off); off += f.data.length;
    }
    const cdOffset = off;
    // Central Directory
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      dv.setUint32(off, 0x02014b50, true); off+=4; dv.setUint16(off, 10, true); off+=2;
      dv.setUint16(off, 10, true); off+=2; dv.setUint16(off, 0, true); off+=2;
      dv.setUint16(off, 0, true); off+=2; off+=4;
      dv.setUint32(off, this._crc32(f.data), true); off+=4;
      dv.setUint32(off, f.data.length, true); off+=4; dv.setUint32(off, f.data.length, true); off+=4;
      dv.setUint16(off, f.name.length, true); off+=2; dv.setUint16(off, 0, true); off+=2;
      dv.setUint16(off, 0, true); off+=2; dv.setUint16(off, 0, true); off+=2; dv.setUint16(off, 0, true); off+=2;
      dv.setUint32(off, 0, true); off+=4; dv.setUint32(off, localOffsets[i], true); off+=4;
      buf.set(f.name, off); off += f.name.length;
    }
    // EOCD
    dv.setUint32(off, 0x06054b50, true); off+=4; dv.setUint16(off, 0, true); off+=2; dv.setUint16(off, 0, true); off+=2;
    dv.setUint16(off, this.files.length, true); off+=2; dv.setUint16(off, this.files.length, true); off+=2;
    dv.setUint32(off, off - cdOffset, true); off+=4; dv.setUint32(off, cdOffset, true); off+=4; dv.setUint16(off, 0, true); off+=2;
    return buf;
  }
  _crc32(data) {
    let c = 0xFFFFFFFF;
    for(let i=0; i<data.length; i++) { c ^= data[i]; for(let j=0; j<8; j++) c = (c&1)?(0xEDB88320^(c>>>1)):(c>>>1); }
    return c ^ 0xFFFFFFFF;
  }
}

function triggerDownload(uint8Arr, mime, filename) {
  const blob = new Blob([uint8Arr], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}