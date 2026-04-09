import { registerComponents } from '../components/index.js';
import { applyAccentColor } from './accent.js';
import { AudioBridge } from '../services/audio-bridge.js';

declare const sarah: {
  version: string;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectFolder: (title?: string) => Promise<string | null>;
  openDialog: (view: string) => Promise<void>;
  chat: (message: string) => Promise<void>;
  onChatChunk: (cb: (data: { text: string }) => void) => () => void;
  onChatDone: (cb: (data: { fullText: string }) => void) => () => void;
  onChatError: (cb: (data: { message: string }) => void) => () => void;
  voice: {
    getState: () => Promise<string>;
    onStateChange: (cb: (data: { state: string }) => void) => () => void;
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
    onError: (cb: (data: { message: string }) => void) => () => void;
    sendAudioChunk: (chunk: number[]) => Promise<void>;
  };
};

(window as any).__sarah = sarah;

registerComponents();

// Apply saved accent color on load
sarah.getConfig().then((config: any) => {
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

// ── Voice Audio Bridge ──
const audioBridge = new AudioBridge();
audioBridge.start().catch((err) => {
  console.error('[Dashboard] AudioBridge failed to start:', err);
});
