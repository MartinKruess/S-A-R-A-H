import type { SarahHexOrb } from '../../sarahHexOrb';

declare var sarah: {
  bootReady(): void;
  revealDone(): void;
  bootDone(): void;
  splashTts(text: string): Promise<{ audio: number[]; sampleRate: number } | null>;
  getConfig(): Promise<{ onboarding: { firstStart: boolean; setupComplete: boolean } }>;
  saveConfig(config: Record<string, unknown>): Promise<unknown>;
  onBootStatus(cb: (data: BootStatus) => void): () => void;
  onTransitionStart(cb: () => void): () => void;
};

interface BootStatus {
  step:
    | 'whisper'
    | 'router'
    | 'router-ready'
    | 'router-terminal'
    | 'whisper-ready'
    | 'whisper-unavailable'
    | 'piper'
    | 'piper-ready'
    | 'piper-unavailable';
  message?: string;
  severity?: 'info' | 'warning' | 'error';
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

function showStatus(message: string, animated = false, severity: 'info' | 'warning' | 'error' = 'info'): void {
  statusEl.classList.remove('visible');
  setTimeout(() => {
    statusEl.classList.remove('boot-msg-error', 'boot-msg-warning');
    if (severity === 'error') statusEl.classList.add('boot-msg-error');
    if (severity === 'warning') statusEl.classList.add('boot-msg-warning');
    // Errors and warnings must not look like loading animations (A6)
    if (severity !== 'info') animated = false;
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

interface BootAudioPlayback {
  done: Promise<void>;
  stop(): void;
}

function playTtsAudio(
  audioData: number[],
  sampleRate: number,
): BootAudioPlayback {
  if (!audioContext) audioContext = new AudioContext({ sampleRate });
  const buffer = audioContext.createBuffer(1, audioData.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < audioData.length; i++) {
    channel[i] = audioData[i]!;
  }
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (): void => {
    if (settled) return;
    settled = true;
    source.onended = null;
    resolveDone();
  };
  source.onended = finish;
  source.start();
  return {
    done,
    stop: () => {
      if (settled) return;
      try {
        source.stop();
      } catch {
        // The source may already have ended between the ownership check and stop().
      }
      finish();
    },
  };
}

/** Play an audio file from a URL, returns a promise that resolves when done. */
function playAudioFile(url: string, volume = 1.0): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.volume = volume;
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
let routerTerminal = false;
let routerAvailable = false;
let piperTerminal = false;
let piperAvailable = false;
let breakTriggered = false;
let ttsTriggered = false;
let ttsAudioReady = false;
let pendingTtsPlay: (() => void) | null = null;
let ttsAudioResolve: (() => void) | null = null;
let ttsRequestStartedAt: number | null = null;
let pendingTtsPlayTimer: ReturnType<typeof setTimeout> | null = null;
let bootDoneTimer: ReturnType<typeof setTimeout> | null = null;
let activeTtsPlayback: BootAudioPlayback | null = null;

const PIPER_TERMINAL_WAIT_MS = 8_000;
const SPLASH_TTS_REQUEST_WAIT_MS = 8_000;

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
      if (routerTerminal) {
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

        // Play genesis audio file at 50% volume
        playAudioFile('audio/sarah-corrupted.mp3', 0.5)
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
        void sarah.getConfig().then((config) => {
          return sarah.saveConfig({
            onboarding: { ...config.onboarding, firstStart: false },
          });
        }).catch((error) => {
          console.warn('[Boot] Genesis completion could not be persisted:', error);
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
      if (!ttsTriggered && elapsed() > PIPER_TERMINAL_WAIT_MS) {
        startPhase('boot-done');
        break;
      }

      if (routerAvailable && piperTerminal && piperAvailable && !ttsTriggered) {
        ttsTriggered = true;
        ttsRequestStartedAt = performance.now();
        ttsAudioResolve = () => {
          bootDoneTimer = setTimeout(() => {
            bootDoneTimer = null;
            startPhase('boot-done');
          }, 1000);
        };
        void sarah.splashTts('Huch, jetzt bin ich einsatzbereit!')
          .then((result) => {
            if (!result || phase !== 'boot-piper-wait') return;
            ttsAudioReady = true;
            pendingTtsPlay = () => {
              try {
                const playback = playTtsAudio(result.audio, result.sampleRate);
                activeTtsPlayback = playback;
                void playback.done.then(() => {
                  if (activeTtsPlayback === playback) activeTtsPlayback = null;
                  ttsAudioResolve?.();
                  ttsAudioResolve = null;
                });
              } catch (error) {
                console.warn('[Boot] Splash speech playback failed:', error);
                startPhase('boot-done');
              }
            };
          })
          .catch((error) => {
            console.warn('[Boot] Splash speech request failed:', error);
          });
      }

      if (piperTerminal && (!piperAvailable || !routerAvailable) && elapsed() > 1000) {
        startPhase('boot-done');
      }

      if (ttsAudioReady && !breakTriggered) {
        breakTriggered = true;
        orb.triggerBreak(3000);
        pendingTtsPlayTimer = setTimeout(() => {
          pendingTtsPlayTimer = null;
          if (phase === 'boot-piper-wait') pendingTtsPlay?.();
        }, 200);
      }

      // Degrade if Piper never reaches a terminal state. Once synthesis has
      // started it gets its own deadline; active playback owns the boot until
      // it has actually ended, so normal runtime audio can never overlap it.
      if (
        ttsTriggered
        && !ttsAudioReady
        && ttsRequestStartedAt !== null
        && performance.now() - ttsRequestStartedAt > SPLASH_TTS_REQUEST_WAIT_MS
      ) {
        startPhase('boot-done');
      }
      break;
    }

    case 'boot-done': {
      if (pendingTtsPlayTimer) clearTimeout(pendingTtsPlayTimer);
      pendingTtsPlayTimer = null;
      if (bootDoneTimer) clearTimeout(bootDoneTimer);
      bootDoneTimer = null;
      activeTtsPlayback?.stop();
      activeTtsPlayback = null;
      pendingTtsPlay = null;
      ttsAudioResolve = null;
      hideBubble();
      hideStatus();

      // Signal main.ts to start window transition
      sarah.bootDone();

      // Listen for transition-start to exit boot mode
      sarah.onTransitionStart(() => {
        document.body.classList.remove('boot-mode');
      });

      // Resolve the promise so AudioBridge can start
      if (bootDoneResolve) {
        bootDoneResolve();
        bootDoneResolve = null;
      }

      return; // Stop tick loop
    }
  }

  requestAnimationFrame(tick);
}

// ============================================================
// Exported entry point
// ============================================================
let bootDoneResolve: (() => void) | null = null;

export async function startBootSequence(orbInstance: SarahHexOrb): Promise<void> {
  orb = orbInstance;

  // Configuration is optional for the boot animation. If persistence is
  // temporarily unavailable, use the safe returning-user path and continue
  // until the runtime capability events provide the authoritative status.
  try {
    const config = await sarah.getConfig();
    isFirstStart = config.onboarding.firstStart;
  } catch (error) {
    isFirstStart = false;
    console.warn('[Boot] Configuration unavailable; continuing without Genesis:', error);
    showStatus('Konfiguration konnte nicht geladen werden. Sarah startet eingeschränkt.', false, 'warning');
  }

  return new Promise((resolve) => {
    bootDoneResolve = resolve;
    // Listen for boot status from main
    sarah.onBootStatus((data) => {
      switch (data.step) {
        case 'whisper':
        case 'router':
        case 'piper':
          if (data.message) showStatus(data.message, true, data.severity ?? 'info');
          break;
        case 'router-ready':
          routerTerminal = true;
          routerAvailable = true;
          hideStatus();
          break;
        case 'router-terminal':
          routerTerminal = true;
          routerAvailable = false;
          if (data.message) showStatus(data.message, false, data.severity ?? 'error');
          break;
        case 'whisper-ready':
          hideStatus();
          break;
        case 'whisper-unavailable':
          if (data.message) showStatus(data.message, false, data.severity ?? 'warning');
          break;
        case 'piper-ready':
          piperTerminal = true;
          piperAvailable = true;
          hideStatus();
          break;
        case 'piper-unavailable':
          piperTerminal = true;
          piperAvailable = false;
          if (data.message) showStatus(data.message, false, data.severity ?? 'warning');
          break;
      }
    });

    // Signal main.ts that we're ready for boot status
    sarah.bootReady();

    // Start phase loop
    requestAnimationFrame(tick);
  });
}
