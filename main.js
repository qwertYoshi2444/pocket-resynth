const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let originalBuffer = null;
let synthesizedBuffer = null;

const btnProcess = document.getElementById('btn-process');
const btnPlay = document.getElementById('btn-play');
const btnExport = document.getElementById('btn-export');
const statusMsg = document.getElementById('status');
const pitchShiftSlider = document.getElementById('pitch-shift');
const pitchValDisplay = document.getElementById('pitch-val');

const canvasSpec = document.getElementById('canvas-spec');
const ctxSpec = canvasSpec.getContext('2d');
const canvasWave = document.getElementById('canvas-wave');
const ctxWave = canvasWave.getContext('2d');

let worker = new Worker('worker.js');

pitchShiftSlider.addEventListener('input', (e) => {
    pitchValDisplay.innerText = e.target.value;
});

document.getElementById('audio-upload').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    statusMsg.innerText = "Decoding audio...";
    const reader = new FileReader();
    reader.onload = async function(ev) {
        try {
            originalBuffer = await audioContext.decodeAudioData(ev.target.result);
            // Convert to mono for simplicity
            const monoData = originalBuffer.getChannelData(0);
            statusMsg.innerText = "Audio loaded. Ready to process.";
            btnProcess.disabled = false;
        } catch (err) {
            statusMsg.innerText = "Error decoding audio.";
        }
    };
    reader.readAsArrayBuffer(file);
});

btnProcess.addEventListener('click', () => {
    if (!originalBuffer) return;
    btnProcess.disabled = true;
    btnPlay.disabled = true;
    btnExport.disabled = true;
    
    const monoData = originalBuffer.getChannelData(0);
    const pitchShift = parseFloat(pitchShiftSlider.value);
    
    worker.postMessage({
        audioData: monoData,
        sampleRate: originalBuffer.sampleRate,
        pitchShift: pitchShift
    });
});

worker.onmessage = function(e) {
    if (e.data.status) {
        statusMsg.innerText = e.data.status;
    }
    
    if (e.data.synthesizedData) {
        const synData = e.data.synthesizedData;
        
        // Create AudioBuffer for playback
        synthesizedBuffer = audioContext.createBuffer(1, synData.length, originalBuffer.sampleRate);
        synthesizedBuffer.copyToChannel(synData, 0);
        
        btnProcess.disabled = false;
        btnPlay.disabled = false;
        btnExport.disabled = false;
        
        drawWaveform(synData);
        if (e.data.spectrogramFrames) {
            drawSpectrogram(e.data.spectrogramFrames);
        }
    }
};

let currentSource = null;
btnPlay.addEventListener('click', () => {
    if (!synthesizedBuffer) return;
    if (currentSource) {
        currentSource.stop();
    }
    currentSource = audioContext.createBufferSource();
    currentSource.buffer = synthesizedBuffer;
    currentSource.connect(audioContext.destination);
    currentSource.start();
});

btnExport.addEventListener('click', () => {
    if (!synthesizedBuffer) return;
    // We dynamically load wav.js logic here to keep files separate
    const script = document.createElement('script');
    script.src = 'wav.js';
    script.onload = () => {
        const wavBlob = encodeWAV(synthesizedBuffer.getChannelData(0), synthesizedBuffer.sampleRate);
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = 'resynthesized.wav';
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
    };
    document.head.appendChild(script);
});

function drawWaveform(data) {
    ctxWave.fillStyle = '#000';
    ctxWave.fillRect(0, 0, canvasWave.width, canvasWave.height);
    ctxWave.strokeStyle = '#00d2ff';
    ctxWave.beginPath();
    
    const step = Math.ceil(data.length / canvasWave.width);
    for (let i = 0; i < canvasWave.width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
            let val = data[(i * step) + j];
            if (val < min) min = val;
            if (val > max) max = val;
        }
        let y = (1 - max) * (canvasWave.height / 2);
        ctxWave.lineTo(i, y);
    }
    ctxWave.stroke();
}

function drawSpectrogram(frames) {
    ctxSpec.fillStyle = '#000';
    ctxSpec.fillRect(0, 0, canvasSpec.width, canvasSpec.height);
    
    const maxFreq = originalBuffer.sampleRate / 2;
    const widthPerFrame = canvasSpec.width / frames.length;
    
    frames.forEach((peaks, xIdx) => {
        peaks.forEach(peak => {
            let y = canvasSpec.height - (peak.freq / maxFreq) * canvasSpec.height;
            // Draw point based on amplitude
            let intensity = Math.min(255, Math.floor(peak.amp * 5000));
            ctxSpec.fillStyle = `rgb(${intensity}, ${intensity}, 255)`;
            ctxSpec.fillRect(xIdx * widthPerFrame, y, Math.max(1, widthPerFrame), 2);
        });
    });
}