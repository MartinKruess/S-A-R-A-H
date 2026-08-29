import { registerComponents } from '../components/index.js';
import { applyAccentColor } from '../shared/accent.js';
import { AudioBridge } from '../services/audio-bridge.js';
import { startBootSequence } from './boot-sequence.js';
import { orb } from './orb-scene.js';
import { installSarah } from '../shared/window-global.js';
import {
  beginChatProcessing,
  handleRejectedChatSubmission,
  isChatMessageWithinLimit,
  removeChatProcessing,
  shouldRemoveIncompleteAssistantOutput,
  takeChatProcessing,
} from './chat-submission.js';
import {
  pruneDetachedTurnBubbles,
  removeIncognitoSection,
  resolveIncognitoStart,
} from './incognito-visibility.js';
import { synchronizeRuntimeStatus } from './runtime-status-sync.js';
import { getSlashCommandSuggestions } from './slash-command-suggestions.js';

import type { SarahApi } from '../../core/sarah-api.js';
import type { CustomCommand } from '../../core/config-schema.js';
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

let configuredCustomCommands: CustomCommand[] = [];

// Apply accent color on load — always, so data-theme gets set even for default cyan
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor ?? '#00d4ff';
  applyAccentColor(color);
  configuredCustomCommands = config.controls.customCommands;
  renderSlashCommandSuggestions();
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
const chatInputBar = document.getElementById('chat-input-bar')!;
const chatModeToggle = document.getElementById('chat-mode-toggle')!;
const slashCommandList = document.createElement('div');
slashCommandList.className = 'slash-command-list';
slashCommandList.id = 'slash-command-list';
slashCommandList.setAttribute('role', 'listbox');
slashCommandList.hidden = true;
chatInputBar.appendChild(slashCommandList);
chatInput.setAttribute('aria-controls', slashCommandList.id);
chatInput.setAttribute('aria-expanded', 'false');
let visibleSlashCommands = getSlashCommandSuggestions('', []);
let selectedSlashCommand = 0;
let runtimeErrorBubble: HTMLElement | null = null;
let workerWarningBubble: HTMLElement | null = null;
let sttWarningBubble: HTMLElement | null = null;
let ttsWarningBubble: HTMLElement | null = null;
let storageWarningBubble: HTMLElement | null = null;
let incognitoStart: Element | null = null;

function renderRecoveryBubble(current: HTMLElement | null, message: string): HTMLElement {
  const bubble = current ?? addBubble('error', '');
  bubble.replaceChildren();
  const label = document.createElement('span');
  label.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'runtime-retry-button';
  retry.textContent = 'Erneut versuchen';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    retry.textContent = 'Wird geprüft …';
    try {
      const result = await sarah.retryRuntimeRecovery();
      applyRuntimeStatus(await sarah.getRuntimeStatus());
      if (!result.ok && result.message) retry.title = result.message;
    } catch (error) {
      retry.title = error instanceof Error ? error.message : String(error);
    } finally {
      if (retry.isConnected) {
        retry.disabled = false;
        retry.textContent = 'Erneut versuchen';
      }
    }
  });
  bubble.append(label, retry);
  return bubble;
}

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
    runtimeErrorBubble = renderRecoveryBubble(runtimeErrorBubble, message);
  } else if (runtimeErrorBubble) {
    runtimeErrorBubble.remove();
    runtimeErrorBubble = null;
  }

  const worker = snapshot.capabilities.local_worker;
  const workerFailed = worker && ['degraded', 'unavailable', 'error'].includes(worker.state);
  if (available && workerFailed) {
    workerWarningBubble = renderRecoveryBubble(workerWarningBubble, WORKER_UNAVAILABLE_MESSAGE);
  } else if (workerWarningBubble) {
    workerWarningBubble.remove();
    workerWarningBubble = null;
  }

  const stt = snapshot.capabilities.stt;
  const sttFailed = stt && ['degraded', 'unavailable', 'error'].includes(stt.state);
  if (available && sttFailed) {
    sttWarningBubble = renderRecoveryBubble(sttWarningBubble, STT_UNAVAILABLE_MESSAGE);
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

  const storage = snapshot.capabilities.storage;
  const storageFailed = storage && ['degraded', 'unavailable', 'error'].includes(storage.state);
  if (storageFailed) {
    const message = storage.message
      ?? 'Speichern ist derzeit nicht möglich. Neue Unterhaltungen bleiben nur bis zum Neustart erhalten.';
    if (!storageWarningBubble) storageWarningBubble = addBubble('error', message);
    else storageWarningBubble.textContent = message;
  } else if (storageWarningBubble) {
    storageWarningBubble.remove();
    storageWarningBubble = null;
  }
}

const stopRuntimeStatusSync = synchronizeRuntimeStatus(sarah, applyRuntimeStatus, (error) => {
  console.warn('[Dashboard] Runtime status unavailable:', error);
  chatInput.disabled = true;
});

let chatMode = false;
const outputBubbles = new Map<string, {
  turnId: string;
  bubble: HTMLElement;
  nextSequence: number;
}>();
const pendingTurnBubbles = new Map<string, HTMLElement>();
const turnUserBubbles = new Map<string, HTMLElement>();
const terminalTurns = new Set<string>();

function addBubble(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

function selectSlashCommand(index: number): void {
  const suggestion = visibleSlashCommands[index];
  if (!suggestion) return;
  chatInput.value = `${suggestion.command} `;
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  visibleSlashCommands = [];
  slashCommandList.hidden = true;
  chatInput.setAttribute('aria-expanded', 'false');
  chatInput.removeAttribute('aria-activedescendant');
  chatInput.focus();
}

function updateSlashCommandSelection(): void {
  const options = slashCommandList.querySelectorAll<HTMLButtonElement>('.slash-command-option');
  options.forEach((option, index) => {
    const selected = index === selectedSlashCommand;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', String(selected));
  });
  const selected = options[selectedSlashCommand];
  if (!selected) {
    chatInput.removeAttribute('aria-activedescendant');
    return;
  }
  chatInput.setAttribute('aria-activedescendant', selected.id);
  const optionTop = selected.offsetTop;
  const optionBottom = optionTop + selected.offsetHeight;
  if (optionTop < slashCommandList.scrollTop) {
    slashCommandList.scrollTop = optionTop;
  } else if (optionBottom > slashCommandList.scrollTop + slashCommandList.clientHeight) {
    slashCommandList.scrollTop = optionBottom - slashCommandList.clientHeight;
  }
}

function renderSlashCommandSuggestions(): void {
  visibleSlashCommands = getSlashCommandSuggestions(chatInput.value, configuredCustomCommands);
  selectedSlashCommand = Math.min(selectedSlashCommand, Math.max(0, visibleSlashCommands.length - 1));
  slashCommandList.replaceChildren();
  slashCommandList.hidden = visibleSlashCommands.length === 0;
  chatInput.setAttribute('aria-expanded', String(visibleSlashCommands.length > 0));
  if (visibleSlashCommands.length === 0) {
    chatInput.removeAttribute('aria-activedescendant');
    return;
  }
  visibleSlashCommands.forEach((suggestion, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.id = `slash-command-option-${index}`;
    item.className = 'slash-command-option';
    item.classList.toggle('selected', index === selectedSlashCommand);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === selectedSlashCommand));
    item.title = suggestion.description;
    const command = document.createElement('span');
    command.className = 'slash-command-name';
    command.textContent = suggestion.command;
    const description = document.createElement('span');
    description.className = 'slash-command-description';
    description.textContent = suggestion.description;
    item.append(command, description);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectSlashCommand(index);
    });
    slashCommandList.appendChild(item);
  });
  updateSlashCommandSelection();
}

chatInput.addEventListener('input', () => {
  selectedSlashCommand = 0;
  renderSlashCommandSuggestions();
});

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
  if (visibleSlashCommands.length > 0) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      selectedSlashCommand = (
        selectedSlashCommand + direction + visibleSlashCommands.length
      ) % visibleSlashCommands.length;
      updateSlashCommandSelection();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectSlashCommand(selectedSlashCommand);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      visibleSlashCommands = [];
      slashCommandList.hidden = true;
      chatInput.setAttribute('aria-expanded', 'false');
      chatInput.removeAttribute('aria-activedescendant');
      return;
    }
  }
  if (e.key === 'Enter' && chatInput.value.trim()) {
    const text = chatInput.value.trim();
    if (!isChatMessageWithinLimit(text)) {
      addBubble('error', 'Die Nachricht ist zu lang. Maximal erlaubt sind 4.000 Zeichen.');
      return;
    }
    chatInput.value = '';
    renderSlashCommandSuggestions();

    const userBubble = addBubble('user', text);
    const turnId = crypto.randomUUID();
    turnUserBubbles.set(turnId, userBubble);
    beginChatProcessing(turnId, pendingTurnBubbles, (message) => addBubble('assistant', message));
    void sarah.chat(text, turnId, chatMode ? 'chat' : 'voice').then((result) => {
      if (!result.accepted) {
        turnUserBubbles.delete(turnId);
        removeChatProcessing(turnId, pendingTurnBubbles);
        handleRejectedChatSubmission(turnId, terminalTurns, userBubble, (message) => {
          addBubble('error', message);
        });
      }
    }).catch((error) => {
      turnUserBubbles.delete(turnId);
      terminalTurns.add(turnId);
      removeChatProcessing(turnId, pendingTurnBubbles);
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
    const bubble = takeChatProcessing(data.turnId, pendingTurnBubbles)
      ?? addBubble('assistant', '');
    output = { turnId: data.turnId, bubble, nextSequence: 0 };
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
  if (terminalTurns.has(data.turnId)) return;
  const output = outputBubbles.get(data.outputId);
  if (!output) {
    const bubble = takeChatProcessing(data.turnId, pendingTurnBubbles);
    if (data.fullText) {
      const completedBubble = bubble ?? addBubble('assistant', '');
      completedBubble.textContent = data.fullText;
    } else {
      bubble?.remove();
    }
    return;
  }
  if (output.turnId !== data.turnId) {
    console.warn('[Dashboard] Assistant completion owner mismatch', data);
    return;
  }
  if (data.sequence !== output.nextSequence) {
    console.warn('[Dashboard] Assistant completion sequence mismatch', data);
    output.bubble.textContent = data.fullText;
  }
  outputBubbles.delete(data.outputId);
});

// Error
sarah.onChatError((data) => {
  if (terminalTurns.has(data.turnId)) return;
  removeChatProcessing(data.turnId, pendingTurnBubbles);
  addBubble('error', data.message);
});

sarah.onTurnTerminal((data) => {
  terminalTurns.add(data.turnId);
  turnUserBubbles.delete(data.turnId);
  removeChatProcessing(data.turnId, pendingTurnBubbles);
  for (const [outputId, output] of outputBubbles) {
    if (output.turnId !== data.turnId) continue;
    if (shouldRemoveIncompleteAssistantOutput(data.status)) output.bubble.remove();
    outputBubbles.delete(outputId);
  }
  if (terminalTurns.size > 500) {
    const oldest = terminalTurns.values().next().value as string | undefined;
    if (oldest) terminalTurns.delete(oldest);
  }
});

// One-time persistence warning (storage degraded — Sarah keeps talking, RAM only)
sarah.onStorageDegraded((data) => {
  const message = `⚠️ ${data.message}`;
  if (!storageWarningBubble) storageWarningBubble = addBubble('error', message);
  else storageWarningBubble.textContent = message;
});

function applyIncognitoState(active: boolean, turnId?: string): void {
  if (active) {
    if (turnId) {
      const last = chatMessages.lastElementChild;
      // Chat mode has a processing bubble after the user command; voice mode has
      // only the transcript. Bind the privacy boundary to the owning turn instead
      // of guessing from DOM siblings, which previously deleted an older normal
      // conversation bubble for voice activation.
      incognitoStart = resolveIncognitoStart(turnId, turnUserBubbles, last);
    } else if (!incognitoStart) {
      const restoredBoundary = document.createElement('div');
      restoredBoundary.hidden = true;
      restoredBoundary.dataset.incognitoBoundary = 'restored';
      chatMessages.appendChild(restoredBoundary);
      incognitoStart = restoredBoundary;
    }
    chatInput.dataset.incognito = 'true';
    chatInput.placeholder = 'Anonymous – dieser Abschnitt wird nicht gespeichert';
    return;
  }
  if (incognitoStart) {
    removeIncognitoSection(incognitoStart);
  }
  pruneDetachedTurnBubbles(turnUserBubbles);
  for (const [turnId, bubble] of pendingTurnBubbles) {
    if (!bubble.isConnected) pendingTurnBubbles.delete(turnId);
  }
  for (const [outputId, output] of outputBubbles) {
    if (!output.bubble.isConnected) outputBubbles.delete(outputId);
  }
  incognitoStart = null;
  delete chatInput.dataset.incognito;
  chatInput.placeholder = 'Nachricht an Sarah...';
}

let privacyEventObserved = false;
sarah.onIncognitoChanged(({ active, turnId }) => {
  privacyEventObserved = true;
  applyIncognitoState(active, turnId);
});

void sarah.getPrivacyState()
  .then(({ incognitoActive }) => {
    // Do not let a slower startup snapshot overwrite a newer runtime event.
    if (!privacyEventObserved) applyIncognitoState(incognitoActive);
  })
  .catch(() => {
    // The event channel remains authoritative if main is still booting.
  });

// ── Voice Transcript → Chat Bubble ──
sarah.voice.onTranscript((data) => {
  turnUserBubbles.set(data.turnId, addBubble('user', data.text));
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
  stopRuntimeStatusSync();
  void audioBridge?.destroy();
});

// ── Boot Sequence ──
if (document.body.classList.contains('boot-mode') && orb) {
  void startBootSequence(orb)
    .then(() => startAudioBridge())
    .catch((error) => {
      console.error('[Dashboard] Boot sequence failed; continuing in degraded mode:', error);
      document.body.classList.remove('boot-mode');
      sarah.bootDone();
      startAudioBridge();
    });
} else {
  startAudioBridge();
}
