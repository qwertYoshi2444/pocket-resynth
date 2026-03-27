// Radix-2 Cooley-Tukey FFT implementation
class FFT {
    constructor(size) {
        this.size = size;
        this.cosTable = new Float32Array(size);
        this.sinTable = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            this.cosTable[i] = Math.cos(2 * Math.PI * i / size);
            this.sinTable[i] = Math.sin(2 * Math.PI * i / size);
        }
        this.reverseTable = new Uint32Array(size);
        let limit = 1;
        let bit = size >> 1;
        while (limit < size) {
            for (let i = 0; i < limit; i++) {
                this.reverseTable[i + limit] = this.reverseTable[i] + bit;
            }
            limit <<= 1;
            bit >>= 1;
        }
    }

    forward(real, imag) {
        const n = this.size;
        for (let i = 0; i < n; i++) {
            const rev = this.reverseTable[i];
            if (i < rev) {
                let tr = real[i], ti = imag[i];
                real[i] = real[rev]; imag[i] = imag[rev];
                real[rev] = tr; imag[rev] = ti;
            }
        }
        for (let size = 2; size <= n; size *= 2) {
            const halfSize = size / 2;
            const step = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = i, k = 0; j < i + halfSize; j++, k += step) {
                    const l = j + halfSize;
                    const tr = real[l] * this.cosTable[k] + imag[l] * this.sinTable[k];
                    const ti = -real[l] * this.sinTable[k] + imag[l] * this.cosTable[k];
                    real[l] = real[j] - tr;
                    imag[l] = imag[j] - ti;
                    real[j] += tr;
                    imag[j] += ti;
                }
            }
        }
    }
}