importScripts('fft.js');

self.onmessage = function(e) {
    const { audioData, sampleRate, pitchShift } = e.data;
    
    // DSP Parameters
    const fftSize = 2048;
    const hopSize = 512;
    const maxPeaks = 100; // Limit per frame for performance
    
    self.postMessage({ status: 'Starting STFT & Analysis...' });
    
    const frames = [];
    const windowFunc = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
        // Hann window
        windowFunc[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }
    
    const fft = new FFT(fftSize);
    
    // 1. Analysis: STFT and Peak Detection
    for (let pos = 0; pos < audioData.length - fftSize; pos += hopSize) {
        let real = new Float32Array(fftSize);
        let imag = new Float32Array(fftSize);
        
        for (let i = 0; i < fftSize; i++) {
            real[i] = audioData[pos + i] * windowFunc[i];
        }
        
        fft.forward(real, imag);
        
        let magnitudes = new Float32Array(fftSize / 2);
        for (let i = 0; i < fftSize / 2; i++) {
            magnitudes[i] = Math.sqrt(real[i]*real[i] + imag[i]*imag[i]);
        }
        
        // Peak detection with quadratic interpolation
        let peaks = [];
        for (let i = 1; i < fftSize / 2 - 1; i++) {
            if (magnitudes[i] > magnitudes[i-1] && magnitudes[i] > magnitudes[i+1]) {
                // Parabolic interpolation for true peak
                let alpha = magnitudes[i-1];
                let beta = magnitudes[i];
                let gamma = magnitudes[i+1];
                let p = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma);
                
                let trueFreqBin = i + p;
                let trueAmp = beta - 0.25 * (alpha - gamma) * p;
                
                if (trueAmp > 0.5) { // Noise gate threshold
                    peaks.push({
                        freq: trueFreqBin * (sampleRate / fftSize),
                        amp: trueAmp / (fftSize / 2)
                    });
                }
            }
        }
        
        peaks.sort((a, b) => b.amp - a.amp);
        frames.push(peaks.slice(0, maxPeaks));
    }
    
    self.postMessage({ status: 'Resynthesizing via Additive Synthesis...' });
    
    // 2. Additive Synthesis (Oscillator Bank with Pitch Shift)
    const outputBuffer = new Float32Array(audioData.length);
    let activePartials = []; // { freq, amp, phase }
    
    for (let f = 0; f < frames.length - 1; f++) {
        let currentPeaks = frames[f];
        let nextPeaks = frames[f+1];
        
        // Simple Peak Matching (Greedy approach)
        let matchedPartials = [];
        for (let cp of currentPeaks) {
            // Find closest peak in next frame
            let bestMatch = null;
            let minDiff = Infinity;
            for (let np of nextPeaks) {
                let diff = Math.abs(cp.freq - np.freq);
                // Allow tracking if within a frequency deviation limit
                if (diff < 150 && diff < minDiff) {
                    minDiff = diff;
                    bestMatch = np;
                }
            }
            
            // Apply pitch shift to frequencies
            let targetFreq = bestMatch ? bestMatch.freq : cp.freq;
            let targetAmp = bestMatch ? bestMatch.amp : 0; // Fade out if dead
            
            matchedPartials.push({
                startFreq: cp.freq * pitchShift,
                endFreq: targetFreq * pitchShift,
                startAmp: cp.amp,
                endAmp: targetAmp
            });
        }
        
        // Inherit phases from previous block or initialize to 0
        if (activePartials.length !== matchedPartials.length) {
            activePartials = matchedPartials.map(p => ({ phase: Math.random() * 2 * Math.PI }));
        }
        
        // Render audio block (hopSize)
        let blockStart = f * hopSize;
        for (let i = 0; i < hopSize; i++) {
            let t = i / hopSize; // 0.0 to 1.0 interpolation factor
            let sample = 0;
            
            for (let pIdx = 0; pIdx < matchedPartials.length; pIdx++) {
                let p = matchedPartials[pIdx];
                let ap = activePartials[pIdx];
                
                // Linear interpolation of amplitude and frequency
                let instAmp = p.startAmp + t * (p.endAmp - p.startAmp);
                let instFreq = p.startFreq + t * (p.endFreq - p.startFreq);
                
                // Accumulate phase
                let phaseInc = 2 * Math.PI * instFreq / sampleRate;
                ap.phase = (ap.phase + phaseInc) % (2 * Math.PI);
                
                sample += instAmp * Math.cos(ap.phase);
            }
            
            if (blockStart + i < outputBuffer.length) {
                outputBuffer[blockStart + i] = sample;
            }
        }
    }
    
    // Send back the synthesized audio and first few frames for drawing spectrogram
    self.postMessage({
        status: 'Done',
        synthesizedData: outputBuffer,
        spectrogramFrames: frames.slice(0, 500) // Send subset for visualizer
    });
};