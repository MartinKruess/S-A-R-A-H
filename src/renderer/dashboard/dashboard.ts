import { registerComponents } from '../components/index.js';
import { applyAccentColor } from '../shared/accent.js';
import { AudioBridge } from '../services/audio-bridge.js';
import { startBootSequence } from './boot-sequence.js';
import { orb } from './orb-scene.js';
import { installSarah } from '../shared/window-global.js';

import type { SarahApi } from '../../core/sarah-api.js';
import { CHAT_UNAVAILABLE_MESSAGE, isChatAvailable } from '../../core/chat-availability.js';

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
}

void sarah.getRuntimeStatus().then(applyRuntimeStatus).catch((error) => {
  console.warn('[Dashboard] Runtime status unavailable:', error);
  chatInput.disabled = true;
});
sarah.onRuntimeStatus(applyRuntimeStatus);

let chatMode = false;
let currentBubble: HTMLElement | null = null;

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
    currentBubble = addBubble('assistant', '');
    sarah.chat(text);
  }
});

// Streaming chunks. A chunk without an open bubble is a late assistant output
// (search summary, action error, timer notify) – it gets its own bubble (F2).
sarah.onChatChunk((data) => {
  if (!currentBubble) {
    currentBubble = addBubble('assistant', '');
  }
  currentBubble.textContent += data.text;
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Done
sarah.onChatDone(() => {
  currentBubble = null;
});

// Error
sarah.onChatError((data) => {
  if (currentBubble) {
    currentBubble.remove();
    currentBubble = null;
  }
  addBubble('error', data.message);
});

// One-time persistence warning (storage degraded — Sarah keeps talking, RAM only)
sarah.onStorageDegraded((data) => {
  addBubble('error', `⚠️ ${data.message}`);
});

// ── Voice Transcript → Chat Bubble ──
sarah.voice.onTranscript((data) => {
  addBubble('user', data.text);
  currentBubble = addBubble('assistant', '');
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
