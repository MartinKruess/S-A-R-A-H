// src/services/llm/media-context.ts
// Deterministic short-window media conversation context (Layer 1). Resolves
// terse follow-up commands ("weiter"/"zurück"/"stopp") using the last media
// action within a sliding window — no LLM in the resolution path.
import type { MediaAction } from '../actions/media-controller.js';

export const MEDIA_CONTEXT_WINDOW_MS = 12_000;

export interface ResolvedMedia {
  action: MediaAction;
  speak: string;
}

interface MediaContextState {
  lastAction: MediaAction;
  atMs: number;
}

// Whole-sentence inputs are never terse follow-ups.
const MAX_TERSE_TOKENS = 3;

const STOP_PHRASES = new Set(['stop', 'stopp', 'halt', 'pause']);
const BACK_PHRASES = new Set(['zurück', 'eins zurück', 'das vorherige']);
const NEXT_PHRASES = new Set(['nächstes']);
// Ambiguous: after a pause → resume; after a skip / while playing → next.
const FORWARD_PHRASES = new Set(['weiter', 'und weiter', 'noch eins']);

export class MediaContext {
  private state: MediaContextState | null = null;

  /** Record that a media_* command was issued (refreshes the window). */
  record(action: MediaAction, nowMs: number): void {
    this.state = { lastAction: action, atMs: nowMs };
  }

  /**
   * Resolve a terse follow-up to a media action, or null if the window is cold
   * or the text isn't a known terse follow-up (caller then routes normally).
   */
  resolve(text: string, nowMs: number): ResolvedMedia | null {
    const norm = text.normalize('NFC').trim().toLowerCase().replace(/[.,!?;:…]+$/, '').trim();
    if (!norm || norm.split(/\s+/).length > MAX_TERSE_TOKENS) return null;
    if (!this.state || nowMs - this.state.atMs > MEDIA_CONTEXT_WINDOW_MS) return null;

    if (STOP_PHRASES.has(norm)) return { action: 'media_pause', speak: 'Pausiert.' };
    if (BACK_PHRASES.has(norm)) return { action: 'media_previous', speak: 'Zurück.' };
    if (NEXT_PHRASES.has(norm)) return { action: 'media_next', speak: 'Nächstes Lied.' };
    if (FORWARD_PHRASES.has(norm)) {
      return this.state.lastAction === 'media_pause'
        ? { action: 'media_play', speak: 'Läuft wieder.' }
        : { action: 'media_next', speak: 'Nächstes Lied.' };
    }
    return null;
  }
}
