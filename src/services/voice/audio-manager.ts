// src/services/voice/audio-manager.ts

/**
 * AudioManager — Main Process side audio buffer management.
 *
 * Audio I/O happens in the renderer (Web Audio API).
 * This class collects PCM chunks from the renderer and provides
 * complete recordings for STT. For TTS, it holds the audio data
 * that the renderer will play.
 */
export class AudioManager {
  private recordingChunks: Float32Array[] = [];
  private _isRecording = false;
  private _isPlaying = false;
  private onChunkCallback: ((chunk: Float32Array) => void) | null = null;

  get isRecording(): boolean {
    return this._isRecording;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Start a recording session. The renderer will send audio chunks via IPC.
   * @param onChunk — called with each PCM chunk for real-time analysis (e.g. VAD)
   */
  startRecording(onChunk?: (chunk: Float32Array) => void): void {
    if (this._isRecording) return;
    this.recordingChunks = [];
    this.onChunkCallback = onChunk ?? null;
    this._isRecording = true;
  }

  /**
   * Feed a PCM chunk from the renderer. Called by IPC handler.
   */
  feedChunk(chunk: Float32Array): void {
    if (!this._isRecording) return;
    this.recordingChunks.push(new Float32Array(chunk));
    this.onChunkCallback?.(chunk);
  }

  /**
   * Stop recording and return the complete audio buffer.
   */
  stopRecording(): Float32Array {
    if (!this._isRecording) {
      return new Float32Array(0);
    }
    this._isRecording = false;

    const totalLength = this.recordingChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.recordingChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.recordingChunks = [];
    this.onChunkCallback = null;
    return combined;
  }

  /**
   * Mark that TTS playback has started (renderer is playing audio).
   */
  setPlaying(playing: boolean): void {
    this._isPlaying = playing;
  }

  /**
   * Clean up all resources.
   */
  async destroy(): Promise<void> {
    this._isRecording = false;
    this._isPlaying = false;
    this.recordingChunks = [];
    this.onChunkCallback = null;
  }
}
