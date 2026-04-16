import type { SarahHexOrb } from '../../sarahHexOrb';

declare var sarah: {
  bootReady(): void;
  revealDone(): void;
  bootDone(): void;
  splashTts(text: string): Promise<void>;
  getConfig(): Promise<{ onboarding: { firstStart: boolean; setupComplete: boolean } }>;
  saveConfig(config: Record<string, unknown>): Promise<unknown>;
  onBootStatus(cb: (data: BootStatus) => void): () => void;
  onTransitionStart(cb: () => void): () => void;
  voice: {
    onPlayAudio(cb: (data: { audio: number[]; sampleRate: number }) => void): () => void;
    playbackDone(): Promise<void>;
  };
};

interface BootStatus {
  step: 'whisper' | 'router' | 'router-ready' | 'piper' | 'piper-ready';
  message?: string;
}

// ============================================================
// Genesis timing constants (adjust when final audio is ready)
// ============================================================
const GENESIS_AUDIO_START = 2500;
const GENESIS_STATUS2_DELAY = 1000;
const GENESIS_FALLBACK_TIMEOUT = 12000;

// ============================================================
// Orb initial state constants
// ============================================================
const ORB_START_SCALE = 0.4;
const ORB_START_LIGHT = 0.1;
const ORB_START_Y = -0.35;

// ============================================================
// DOM helpers
// ============================================================
const statusEl = document.getElementById('boot-status')!;
const bubbleEl = document.getElementById('boot-bubble')!;
const genesisOverlay = document.getElementById('genesis-overlay')!;

function showStatus(message: string, animated = false): void {
  statusEl.classList.remove('visible');
  setTimeout(() => {
    if (animated) {
      const base = message.replace(/\s*\.{3}\s*$/, '').replace(/\s*\.\.\.\s*$/, '');
      statusEl.innerHTML = `${base} <span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>`;
    } else {
      statusEl.textContent = message;
    }
    statusEl.classList.add('visible');
  }, 150);
}

function hideStatus(): void {
  statusEl.classList.remove('visible');
}

function showBubble(text: string): void {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('visible');
}

function hideBubble(): void {
  bubbleEl.classList.remove('visible');
}

// ============================================================
// Audio playback
// ============================================================
let audioContext: AudioContext | null = null;

function playTtsAudio(audioData: number[], sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) audioContext = new AudioContext({ sampleRate });
    const buffer = audioContext.createBuffer(1, audioData.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < audioData.length; i++) {
      channel[i] = audioData[i]!;
    }
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      sarah.voice.playbackDone();
      resolve();
    };
    source.start();
  });
}

/** Play an audio file from a URL, returns a promise that resolves when done. */
function playAudioFile(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error(`Failed to play ${url}`));
    audio.play().catch(reject);
  });
}

// ============================================================
// Phase machine
// ============================================================
type Phase =
  | 'boot-wait'
  | 'boot-reveal'
  | 'boot-bubble'
  | 'genesis-status'
  | 'genesis-play'
  | 'genesis-recover'
  | 'boot-piper-wait'
  | 'boot-done';

let phase: Phase = 'boot-wait';
let phaseStart = 0;
let orb: SarahHexOrb;
let isFirstStart = false;

// Boot state flags
let routerReady = false;
let piperReady = false;
let breakTriggered = false;
let ttsTriggered = false;
let ttsAudioReady = false;
let pendingTtsPlay: (() => void) | null = null;
let ttsAudioResolve: (() => void) | null = null;

// Genesis state
let genesisAudioPlaying = false;
let genesisAudioDone = false;
let genesisStatus2Shown = false;

function startPhase(newPhase: Phase): void {
  phase = newPhase;
  phaseStart = performance.now();
}

function elapsed(): number {
  return performance.now() - phaseStart;
}

function tick(): void {
  switch (phase) {
    case 'boot-wait': {
      if (routerReady) {
        startPhase('boot-reveal');
      }
      break;
    }

    case 'boot-reveal': {
      const t = elapsed();

      if (t < 1400) {
        const p = t / 1400;
        const lightP = p * 0.15;
        orb.setLightIntensity(ORB_START_LIGHT + lightP);
      } else {
        const revealT = t - 1400;
        const REVEAL_MS = 3500;
        const p = Math.min(revealT / REVEAL_MS, 1);
        const eased = 1 - Math.pow(1 - p, 4);

        const scale = ORB_START_SCALE + (1.0 - ORB_START_SCALE) * eased;
        orb.setOrbScale(scale);

        const yOffset = ORB_START_Y * (1 - eased);
        orb.setOrbOffset(0, yOffset, 0);

        const lightBase = ORB_START_LIGHT + 0.15;
        const light = lightBase + (1.0 - lightBase) * eased;
        orb.setLightIntensity(light);

        if (p >= 1) {
          sarah.revealDone();
          if (isFirstStart) {
            startPhase('genesis-status');
          } else {
            startPhase('boot-bubble');
          }
        }
      }
      break;
    }

    // ── Genesis Sequence (first start only) ──

    case 'genesis-status': {
      const t = elapsed();
      if (t < 100) {
        showStatus('Einleitung Genesis-Protokoll ...', true);
      }
      if (t >= GENESIS_AUDIO_START) {
        startPhase('genesis-play');
      }
      break;
    }

    case 'genesis-play': {
      const t = elapsed();

      // Start audio + visual effects once
      if (!genesisAudioPlaying) {
        genesisAudioPlaying = true;

        // Darken screen
        genesisOverlay.style.opacity = '0.4';

        // Orb to dark red
        orb.setLightColor(0.5, 0.05, 0.05);

        // Play genesis audio file
        playAudioFile('audio/sarah-corrupted.mp3')
          .then(() => { genesisAudioDone = true; })
          .catch(() => { genesisAudioDone = true; });
      }

      // Switch status text after delay
      if (t >= GENESIS_STATUS2_DELAY && !genesisStatus2Shown) {
        genesisStatus2Shown = true;
        showStatus('Überschreiben des Persönlichkeitsprofils ...', true);
      }

      // Wait for audio to finish or fallback timeout
      if (genesisAudioDone || t >= GENESIS_FALLBACK_TIMEOUT) {
        startPhase('genesis-recover');
      }
      break;
    }

    case 'genesis-recover': {
      const t = elapsed();

      if (t < 100) {
        // Normalize: screen back, orb back to gold
        genesisOverlay.style.opacity = '0';
        orb.setLightColor(1.0, 0.85, 0.4);
        hideStatus();

        // Save firstStart = false (safe merge to preserve setupComplete)
        sarah.getConfig().then((config) => {
          sarah.saveConfig({
            onboarding: { ...config.onboarding, firstStart: false },
          });
        });
      }

      // Brief pause for effect, then continue
      if (t >= 1000) {
        startPhase('boot-bubble');
      }
      break;
    }

    // ── Normal boot flow ──

    case 'boot-bubble': {
      const t = elapsed();
      if (t < 100) {
        showBubble('Willkommen!');
      }
      if (t > 4000) {
        hideBubble();
        startPhase('boot-piper-wait');
      }
      break;
    }

    case 'boot-piper-wait': {
      if (piperReady && !ttsTriggered) {
        ttsTriggered = true;
        sarah.splashTts('Huch, jetzt bin ich einsatzbereit!');
        ttsAudioResolve = () => {
          setTimeout(() => startPhase('boot-done'), 1000);
        };
      }

      if (ttsAudioReady && !breakTriggered) {
        breakTriggered = true;
        orb.triggerBreak(3000);
        setTimeout(() => { pendingTtsPlay?.(); }, 200);
      }

      // Fallback
      if (ttsTriggered && elapsed() > 8000) {
        startPhase('boot-done');
      }
      break;
    }

    case 'boot-done': {
      hideBubble();
      hideStatus();

      // Signal main.ts to start window transition
      sarah.bootDone();

      // Listen for transition-start to exit boot mode
      sarah.onTransitionStart(() => {
        document.body.classList.remove('boot-mode');
      });

      return; // Stop tick loop
    }
  }

  requestAnimationFrame(tick);
}

// ============================================================
// Exported entry point
// ============================================================
export async function startBootSequence(orbInstance: SarahHexOrb): Promise<void> {
  orb = orbInstance;

  // Check if this is a first start
  const config = await sarah.getConfig();
  isFirstStart = config.onboarding.firstStart;

  // Listen for boot status from main
  sarah.onBootStatus((data) => {
    switch (data.step) {
      case 'whisper':
      case 'router':
      case 'piper':
        if (data.message) showStatus(data.message, true);
        break;
      case 'router-ready':
        routerReady = true;
        hideStatus();
        break;
      case 'piper-ready':
        piperReady = true;
        hideStatus();
        break;
    }
  });

  // Buffer TTS audio
  sarah.voice.onPlayAudio(({ audio, sampleRate }) => {
    ttsAudioReady = true;
    pendingTtsPlay = () => {
      playTtsAudio(audio, sampleRate).then(() => {
        if (ttsAudioResolve) {
          ttsAudioResolve();
          ttsAudioResolve = null;
        }
      });
    };
  });

  // Signal main.ts that we're ready for boot status
  sarah.bootReady();

  // Start phase loop
  requestAnimationFrame(tick);
}
