// src/renderer/services/audio-worklet-processor.ts

/**
 * Collects audio samples and posts Float32Array chunks to the main thread.
 * Runs in the AudioWorklet thread — no DOM access.
 */
const BUFFER_SIZE = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array = new Float32Array(BUFFER_SIZE);
  private writeIndex = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]; // mono channel 0
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buffer[this.writeIndex++] = input[i]!;
      if (this.writeIndex >= BUFFER_SIZE) {
        this.port.postMessage({ samples: this.buffer.slice() });
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
