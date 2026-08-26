import { registerComponents } from '../components/index.js';
import { applyAccentColor } from '../shared/accent.js';
import { AudioBridge } from '../services/audio-bridge.js';
import { startBootSequence } from './boot-sequence.js';
import { orb } from './orb-scene.js';
import { installSarah } from '../shared/window-global.js';

import type { SarahApi } from '../../core/sarah-api.js';
import {
  CHAT_UNAVAILABLE_MESSAGE,
  STT_UNAVAILABLE_MESSAGE,
  TTS_UNAVAILABLE_MESSAGE,
  WORKER_UNAVAILABLE_MESSAGE,
  isChatAvailable,
} from '../../core/chat-availability.js';

declare const sarah: SarahApi;

installSarah(sarah);

registerComponents();

// Apply accent color on load — always, so data-theme gets set even for default cyan
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor ?? '#00d4ff';
  applyAccentColor(color);
});

// Nav buttons open separate windows
const navButtons = document.querySelectorAll<HTMLButtonElement>('.nav-item');

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view!;
    if (view !== 'sarah') {
      sarah.openDialog(view);
    }
  });
});

// ── Chat ──
const sarahArea = document.getElementById('sarah-area')!;
const chatMessages = document.getElementById('chat-messages')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatModeToggle = document.getElementById('chat-mode-toggle')!;
let runtimeErrorBubble: HTMLElement | null = null;
let workerWarningBubble: HTMLElement | null = null;
let sttWarningBubble: HTMLElement | null = null;
let ttsWarningBubble: HTMLElement | null = null;

function applyRuntimeStatus(snapshot: Awaited<ReturnType<SarahApi['getRuntimeStatus']>>): void {
  const available = isChatAvailable(snapshot);
  chatInput.disabled = !available;
  chatInput.placeholder = chatInput.disabled
    ? 'Sarah ist derzeit nicht verfügbar'
    : 'Nachricht an Sarah...';

  const router = snapshot.capabilities.router;
  const routerFailed = router && ['degraded', 'unavailable', 'error'].includes(router.state);
  if (!available && routerFailed) {
    const detail = router.message ? ` ${router.message}` : '';
    const message = `${CHAT_UNAVAILABLE_MESSAGE}${detail}`;
    if (!runtimeErrorBubble) runtimeErrorBubble = addBubble('error', message);
    else runtimeErrorBubble.textContent = message;
  } else if (runtimeErrorBubble) {
    runtimeErrorBubble.remove();
    runtimeErrorBubble = null;
  }

  const worker = snapshot.capabilities.local_worker;
  const workerFailed = worker && ['degraded', 'unavailable', 'error'].includes(worker.state);
  if (available && workerFailed) {
    if (!workerWarningBubble) {
      workerWarningBubble = addBubble('error', WORKER_UNAVAILABLE_MESSAGE);
    }
  } else if (workerWarningBubble) {
    workerWarningBubble.remove();
    workerWarningBubble = null;
  }

  const stt = snapshot.capabilities.stt;
  const sttFailed = stt && ['degraded', 'unavailable', 'error'].includes(stt.state);
  if (available && sttFailed) {
    if (!sttWarningBubble) {
      sttWarningBubble = addBubble('error', STT_UNAVAILABLE_MESSAGE);
    }
  } else if (sttWarningBubble) {
    sttWarningBubble.remove();
    sttWarningBubble = null;
  }

  const tts = snapshot.capabilities.tts;
  const ttsFailed = tts && ['degraded', 'unavailable', 'error'].includes(tts.state);
  if (available && ttsFailed) {
    if (!ttsWarningBubble) {
      ttsWarningBubble = addBubble('error', TTS_UNAVAILABLE_MESSAGE);
    }
  } else if (ttsWarningBubble) {
    ttsWarningBubble.remove();
    ttsWarningBubble = null;
  }
}

void sarah.getRuntimeStatus().then(applyRuntimeStatus).catch((error) => {
  console.warn('[Dashboard] Runtime status unavailable:', error);
  chatInput.disabled = true;
});
sarah.onRuntimeStatus(applyRuntimeStatus);

let chatMode = false;
const outputBubbles = new Map<string, {
  turnId: string;
  bubble: HTMLElement;
  nextSequence: number;
}>();
const terminalTurns = new Set<string>();

function addBubble(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

// Toggle chat mode
chatModeToggle.addEventListener('click', () => {
  chatMode = !chatMode;
  sarahArea.classList.toggle('chatmode', chatMode);
  sarah.voice.setInteractionMode(chatMode ? 'chat' : 'voice');
  if (chatMode) {
    chatInput.focus();
  }
});

// Send message on Enter
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && chatInput.value.trim()) {
    const text = chatInput.value.trim();
    chatInput.value = '';

    addBubble('user', text);
    const turnId = crypto.randomUUID();
    void sarah.chat(text, turnId).then((result) => {
      if (!result.accepted) terminalTurns.add(turnId);
    }).catch((error) => {
      terminalTurns.add(turnId);
      console.warn('[Dashboard] Chat submission failed:', error);
      addBubble('error', 'Die Nachricht konnte nicht gesendet werden.');
    });
  }
});

// Streaming chunks. A chunk without an open bubble is a late assistant output
// (search summary, action error, timer notify) – it gets its own bubble (F2).
sarah.onChatChunk((data) => {
  if (terminalTurns.has(data.turnId)) return;
  let output = outputBubbles.get(data.outputId);
  if (!output) {
    output = { turnId: data.turnId, bubble: addBubble('assistant', ''), nextSequence: 0 };
    outputBubbles.set(data.outputId, output);
  }
  if (data.sequence !== output.nextSequence) {
    if (data.sequence > output.nextSequence) {
      console.warn('[Dashboard] Out-of-order assistant chunk discarded', data);
    }
    return;
  }
  output.bubble.textContent += data.text;
  output.nextSequence += 1;
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Done
sarah.onChatDone((data) => {
  const output = outputBubbles.get(data.outputId);
  if (output && data.sequence !== output.nextSequence) {
    console.warn('[Dashboard] Assistant completion sequence mismatch', data);
  }
  outputBubbles.delete(data.outputId);
});

// Error
sarah.onChatError((data) => {
  if (terminalTurns.has(data.turnId)) return;
  addBubble('error', data.message);
});

sarah.onTurnTerminal((data) => {
  terminalTurns.add(data.turnId);
  for (const [outputId, output] of outputBubbles) {
    if (output.turnId !== data.turnId) continue;
    if (data.status === 'canceled') output.bubble.remove();
    outputBubbles.delete(outputId);
  }
  if (terminalTurns.size > 500) {
    const oldest = terminalTurns.values().next().value as string | undefined;
    if (oldest) terminalTurns.delete(oldest);
  }
});

// One-time persistence warning (storage degraded — Sarah keeps talking, RAM only)
sarah.onStorageDegraded((data) => {
  addBubble('error', `⚠️ ${data.message}`);
});

// ── Voice Transcript → Chat Bubble ──
sarah.voice.onTranscript((data) => {
  addBubble('user', data.text);
});

sarah.voice.onError((data) => {
  if (data.message === STT_UNAVAILABLE_MESSAGE && sttWarningBubble) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return;
  }
  addBubble('error', data.message);
});

// ── Voice Audio Bridge ──
// Delay AudioBridge start until boot mode ends to avoid double TTS playback
// (boot-sequence has its own audio handler during boot)
let audioBridge: AudioBridge | null = null;

function startAudioBridge(): void {
  if (audioBridge) return;
  audioBridge = new AudioBridge();
  audioBridge.start().catch((err) => {
    console.error('[Dashboard] AudioBridge failed to start:', err);
  });
}

window.addEventListener('beforeunload', () => {
  audioBridge?.destroy();
});

// ── Boot Sequence ──
if (document.body.classList.contains('boot-mode') && orb) {
  startBootSequence(orb).then(() => startAudioBridge());
} else {
  startAudioBridge();
}
