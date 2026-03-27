'use strict';
/**
 * fft.js — Cooley-Tukey Radix-2 DIT FFT
 * Pure JavaScript, no dependencies.
 */
class FFT {
  constructor(size) {
    if (!Number.isInteger(Math.log2(size)) || size < 2)
      throw new Error('FFT size must be a power of 2 >= 2');
    this.size = size;
    this.log2Size = Math.log2(size) | 0;

    this.cosT = new Float64Array(size / 2);
    this.sinT = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      const a = -2 * Math.PI * i / size;
      this.cosT[i] = Math.cos(a);
      this.sinT[i] = Math.sin(a);
    }

    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i, r = 0, b = this.log2Size;
      while (b--) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
  }

  forward(real, imag) {
    const N = this.size;
    for (let i = 0; i < N; i++) {
      const j = this.rev[i];
      if (i < j) {
        let t = real[i]; real[i] = real[j]; real[j] = t;
        t = imag[i]; imag[i] = imag[j]; imag[j] = t;
      }
    }
    for (let s = 1; s <= this.log2Size; s++) {
      const m = 1 << s;
      const mh = m >> 1;
      const step = N / m;
      for (let k = 0; k < N; k += m) {
        for (let j = 0; j < mh; j++) {
          const ti = j * step;
          const wr = this.cosT[ti], wi = this.sinT[ti];
          const u = k + j, v = k + j + mh;
          const tr = wr * real[v] - wi * imag[v];
          const tI = wr * imag[v] + wi * real[v];
          real[v] = real[u] - tr; imag[v] = imag[u] - tI;
          real[u] += tr;          imag[u] += tI;
        }
      }
    }
  }

  inverse(real, imag) {
    const N = this.size;
    for (let i = 0; i < N; i++) imag[i] = -imag[i];
    this.forward(real, imag);
    for (let i = 0; i < N; i++) { real[i] /= N; imag[i] = -imag[i] / N; }
  }
}