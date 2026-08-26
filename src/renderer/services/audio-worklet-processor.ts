// src/renderer/services/audio-worklet-processor.ts

/**
 * Collects audio samples and posts Float32Array chunks to the main thread.
 * Runs in the AudioWorklet thread — no DOM access.
 */
const BUFFER_SIZE = 2048;

type CaptureControlMessage =
  | { type: 'begin'; captureId: string }
  | { type: 'flush'; captureId: string }
  | { type: 'cancel'; captureId: string };

type CaptureProcessorMessage =
  | { type: 'chunk'; captureId: string; samples: Float32Array }
  | { type: 'flushed'; captureId: string };

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array = new Float32Array(BUFFER_SIZE);
  private writeIndex = 0;
  private captureId: string | null = null;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<CaptureControlMessage>) => {
      const message = event.data;
      if (message.type === 'begin') {
        // A capture always starts with an empty worklet buffer. Samples rendered
        // before this control message therefore cannot cross the PTT boundary.
        this.captureId = message.captureId;
        this.writeIndex = 0;
        return;
      }
      if (message.type === 'cancel' && message.captureId === this.captureId) {
        this.writeIndex = 0;
        this.captureId = null;
        return;
      }
      if (message.type !== 'flush' || message.captureId !== this.captureId) return;

      if (this.writeIndex > 0) {
        this.post({
          type: 'chunk',
          captureId: message.captureId,
          samples: this.buffer.slice(0, this.writeIndex),
        });
      }
      this.writeIndex = 0;
      this.captureId = null;
      this.post({ type: 'flushed', captureId: message.captureId });
    };
  }

  private post(message: CaptureProcessorMessage): void {
    this.port.postMessage(message);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]; // mono channel 0
    if (!input || !this.captureId) return true;

    for (let i = 0; i < input.length; i++) {
      this.buffer[this.writeIndex++] = input[i]!;
      if (this.writeIndex >= BUFFER_SIZE) {
        this.post({
          type: 'chunk',
          captureId: this.captureId,
          samples: this.buffer.slice(),
        });
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
