class Pcm16WorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
  }

  downsampleTo16Khz(samples) {
    if (sampleRate === this.targetSampleRate) return samples;
    const ratio = sampleRate / this.targetSampleRate;
    const outputLength = Math.round(samples.length / ratio);
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(Math.floor((index + 1) * ratio), samples.length);
      let sum = 0;
      let count = 0;
      for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
        sum += samples[inputIndex];
        count += 1;
      }
      output[index] = count ? sum / count : 0;
    }
    return output;
  }

  floatToPcm16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return new Uint8Array(pcm.buffer);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    const downsampled = this.downsampleTo16Khz(input);
    const pcmBytes = this.floatToPcm16(downsampled);
    this.port.postMessage(pcmBytes, [pcmBytes.buffer]);
    return true;
  }
}

registerProcessor('pcm16-worklet-processor', Pcm16WorkletProcessor);
