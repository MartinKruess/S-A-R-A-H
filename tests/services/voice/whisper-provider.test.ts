// tests/services/voice/whisper-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as child_process from 'child_process';

vi.mock('fs');
vi.mock('child_process');

// Access private encodeWav via transcribe's side-effect (writes WAV to disk)
const RESOURCES = 'C:\\fake\\resources';

describe('WhisperProvider', () => {
  let provider: InstanceType<typeof import('../../../src/services/voice/providers/whisper-provider.js').WhisperProvider>;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const { WhisperProvider } = await import('../../../src/services/voice/providers/whisper-provider.js');
    provider = new WhisperProvider(RESOURCES);
    await provider.init();
  });

  describe('WAV encoding', () => {
    it('writes a valid WAV file with correct header', async () => {
      let writtenBuffer: Buffer | null = null;
      vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
        writtenBuffer = data as Buffer;
      });

      // Mock spawn to return immediately with empty transcript
      const mockProc = createMockProcess('', '', 0);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      const samples = new Float32Array([0.5, -0.5, 0, 1, -1]);
      await provider.transcribe(samples, 16000);

      expect(writtenBuffer).not.toBeNull();
      const buf = writtenBuffer!;

      // RIFF header
      expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
      expect(buf.toString('ascii', 8, 12)).toBe('WAVE');

      // fmt chunk
      expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
      expect(buf.readUInt16LE(20)).toBe(1);     // PCM format
      expect(buf.readUInt16LE(22)).toBe(1);     // mono
      expect(buf.readUInt32LE(24)).toBe(16000); // sample rate
      expect(buf.readUInt16LE(34)).toBe(16);    // bits per sample

      // data chunk
      expect(buf.toString('ascii', 36, 40)).toBe('data');
      expect(buf.readUInt32LE(40)).toBe(10);    // 5 samples * 2 bytes
    });

    it('uses the provided sampleRate in the header', async () => {
      let writtenBuffer: Buffer | null = null;
      vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
        writtenBuffer = data as Buffer;
      });

      const mockProc = createMockProcess('', '', 0);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      await provider.transcribe(new Float32Array([0.1]), 44100);

      const buf = writtenBuffer!;
      expect(buf.readUInt32LE(24)).toBe(44100); // sample rate from parameter
      expect(buf.readUInt32LE(28)).toBe(44100 * 2); // byte rate
    });

    it('converts Float32 samples to Int16 PCM correctly', async () => {
      let writtenBuffer: Buffer | null = null;
      vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
        writtenBuffer = data as Buffer;
      });

      const mockProc = createMockProcess('', '', 0);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      // Full range: -1, 0, +1
      await provider.transcribe(new Float32Array([-1, 0, 1]), 16000);

      const buf = writtenBuffer!;
      const headerSize = 44;
      expect(buf.readInt16LE(headerSize + 0)).toBe(-32768); // -1 → min Int16
      expect(buf.readInt16LE(headerSize + 2)).toBe(0);      // 0 → 0
      expect(buf.readInt16LE(headerSize + 4)).toBe(32767);   // +1 → max Int16
    });

    it('clamps values outside [-1, 1]', async () => {
      let writtenBuffer: Buffer | null = null;
      vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
        writtenBuffer = data as Buffer;
      });

      const mockProc = createMockProcess('', '', 0);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      await provider.transcribe(new Float32Array([2.0, -3.0]), 16000);

      const buf = writtenBuffer!;
      const headerSize = 44;
      expect(buf.readInt16LE(headerSize + 0)).toBe(32767);  // clamped to +1
      expect(buf.readInt16LE(headerSize + 2)).toBe(-32768);  // clamped to -1
    });
  });

  describe('whisper-cli invocation', () => {
    it('writes .wav file and calls whisper without --output-txt', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      const mockProc = createMockProcess('Hallo Welt', '', 0);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      const result = await provider.transcribe(new Float32Array([0.1]), 16000);

      expect(result).toBe('Hallo Welt');

      // Verify file extension is .wav
      const writePath = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;
      expect(writePath).toMatch(/\.wav$/);

      // Verify args: no --output-txt
      const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--output-txt');
      expect(spawnArgs).toContain('--no-timestamps');
      expect(spawnArgs).toContain('--language');
    });

    it('cleans up temp file after transcription', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockImplementation(() => {});

      const mockProc = createMockProcess('text', '', 0);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      await provider.transcribe(new Float32Array([0.1]), 16000);

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('cleans up temp file even on error', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockImplementation(() => {});

      const mockProc = createMockProcess('', 'error', 1);
      vi.mocked(child_process.spawn).mockReturnValue(mockProc as ReturnType<typeof child_process.spawn>);

      await expect(provider.transcribe(new Float32Array([0.1]), 16000)).rejects.toThrow();
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });
});

function createMockProcess(stdoutData: string, stderrData: string, exitCode: number) {
  const handlers = new Map<string, Function[]>();

  const on = (event: string, handler: Function) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);

    // Auto-fire close after registering both close handlers (main + timeout)
    if (event === 'close' && (handlers.get('close')?.length ?? 0) >= 2) {
      queueMicrotask(() => {
        for (const h of handlers.get('close') ?? []) h(exitCode);
      });
    }
    return mockProc;
  };

  const stdout = {
    on: (_event: string, handler: (data: Buffer) => void) => {
      if (stdoutData) queueMicrotask(() => handler(Buffer.from(stdoutData)));
    },
  };
  const stderr = {
    on: (_event: string, handler: (data: Buffer) => void) => {
      if (stderrData) queueMicrotask(() => handler(Buffer.from(stderrData)));
    },
  };

  const mockProc = { stdout, stderr, on, kill: vi.fn() };
  return mockProc;
}
