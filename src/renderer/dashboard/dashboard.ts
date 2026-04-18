import { registerComponents } from '../components/index.js';
import { applyAccentColor } from '../shared/accent.js';
import { AudioBridge } from '../services/audio-bridge.js';
import { startBootSequence } from './boot-sequence.js';
import { orb } from './orb-scene.js';

import type { SarahApi } from '../../core/sarah-api.js';

declare const sarah: SarahApi;

(window as any).__sarah = sarah;

registerComponents();

// Apply saved accent color on load
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor;
  if (color && color !== '#00d4ff') {
    applyAccentColor(color);
  }
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

// Streaming chunks
sarah.onChatChunk((data) => {
  if (currentBubble) {
    currentBubble.textContent += data.text;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
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
