/**
 * Audio processing utilities for Web Audio API audio slicing and WAV encoding.
 */

let sharedAudioCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

/**
 * Decode audio or video File/Blob into AudioBuffer
 */
export async function decodeAudioFile(file: File | Blob): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  return await ctx.decodeAudioData(arrayBuffer);
}

/**
 * Extract waveform peaks from AudioBuffer for canvas timeline rendering
 */
export function extractWaveformPeaks(buffer: AudioBuffer, numPoints = 1000): number[] {
  const channelData = buffer.getChannelData(0);
  const step = Math.ceil(channelData.length / numPoints);
  const peaks: number[] = [];

  for (let i = 0; i < numPoints; i++) {
    const start = i * step;
    let max = 0;
    for (let j = 0; j < step && start + j < channelData.length; j++) {
      const datum = Math.abs(channelData[start + j]);
      if (datum > max) {
        max = datum;
      }
    }
    peaks.push(max);
  }

  return peaks;
}

/**
 * Slice region of an AudioBuffer from startSec to endSec
 */
export function sliceAudioBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const ctx = getAudioContext();
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;

  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const endSample = Math.min(buffer.length, Math.ceil(endSec * sampleRate));
  const frameCount = Math.max(1, endSample - startSample);

  const slicedBuffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    const slicedData = slicedBuffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i++) {
      slicedData[i] = channelData[startSample + i] || 0;
    }
  }

  return slicedBuffer;
}

/**
 * Encode AudioBuffer into 16-bit PCM WAV Blob
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // 1 = PCM
  const bitDepth = 16;
  const length = buffer.length * numChannels * 2;
  const bufferLength = 44 + length;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* RIFF chunk length */
  view.setUint32(4, 36 + length, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, format, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  /* bits per sample */
  view.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, length, true);

  // Write PCM audio samples
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = buffer.getChannelData(ch)[i];
      // Clamp between -1 and 1
      sample = Math.max(-1, Math.min(1, sample));
      // Convert to 16-bit integer
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Play an AudioBuffer or sliced segment using Web Audio API
 */
export function playAudioSegment(
  buffer: AudioBuffer,
  startSec = 0,
  durationSec?: number,
  onEnd?: () => void
): { stop: () => void } {
  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  source.onended = () => {
    if (onEnd) onEnd();
  };

  source.start(0, startSec, durationSec);

  return {
    stop: () => {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // ignored
      }
    },
  };
}

/**
 * Generate a synthetic speech-like tone AudioBuffer for demo/sample mode
 */
export function createSyntheticDemoAudioBuffer(duration = 20): AudioBuffer {
  const ctx = getAudioContext();
  const sampleRate = ctx.sampleRate;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, numSamples, sampleRate);

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Envelope pattern to mimic voice phrases
    const phrasePattern = Math.sin(t * 2 * Math.PI * 0.5) > 0.1 ? 1 : 0.05;
    const wave = Math.sin(t * 2 * Math.PI * 220) * 0.4 + Math.sin(t * 2 * Math.PI * 440) * 0.2;
    const noise = (Math.random() - 0.5) * 0.05;

    const val = (wave + noise) * phrasePattern * 0.6;
    left[i] = val;
    right[i] = val;
  }

  return buffer;
}
