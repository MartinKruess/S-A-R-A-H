import type { CustomCommand } from './config-schema.js';
import { resolveSlashCommand } from '../services/commands/slash-command-resolver.js';

export type TurnId = string;
export type OutputId = string;
export type VoiceCaptureId = string;
export type PlaybackId = string;
export type TurnMode = 'chat' | 'voice';
export type TurnSource = 'chat' | 'voice' | 'system';
export type TurnTerminalStatus = 'done' | 'error' | 'canceled';

export interface TurnRequest {
  turnId: TurnId;
  source: Exclude<TurnSource, 'system'>;
  mode: TurnMode;
  originalText: string;
  createdAt: string;
  captureId?: VoiceCaptureId;
}

export type TurnCommand =
  | { kind: 'none' }
  | { kind: 'custom'; command: string; arguments: string; expandedText: string }
  | { kind: 'anonymous'; command: '/anonymous' | '/incognito'; arguments: string }
  | { kind: 'confirmation'; command: '/confirm'; arguments: string }
  | { kind: 'memory'; command: '/showcontext' | '/remember' | '/correctmemory' | '/forget' | '/deletememory' | '/exportmemory'; arguments: string }
  | { kind: 'builtin_unavailable'; command: string; arguments: string }
  | { kind: 'unknown'; command: string; arguments: string };

export interface TurnEnvelope extends TurnRequest {
  normalizedText: string;
  effectiveText: string;
  command: TurnCommand;
}

/**
 * @param request - Unveränderte, bereits korrelierte Nutzereingabe.
 * @param customCommands - Aktuell konfigurierte sichere Prompt-Makros.
 *
 * - Normalisiert den Text genau einmal.
 * - Trennt Command-Herkunft und Expansion vom wirksamen Text.
 * - Führt weder Modelle noch Tools aus.
 *
 * @returns Vollständiger Turn-Envelope für die serielle Verarbeitung.
 *
 * @category Transformation Validation
 */
export function prepareTurnEnvelope(
  request: TurnRequest,
  customCommands: readonly CustomCommand[],
): TurnEnvelope {
  const normalizedText = request.originalText.normalize('NFC').trim();
  const resolution = resolveSlashCommand(normalizedText, customCommands);

  if (resolution.kind === 'custom') {
    return {
      ...request,
      normalizedText,
      effectiveText: resolution.expandedText,
      command: {
        kind: resolution.kind,
        command: resolution.command,
        arguments: resolution.arguments,
        expandedText: resolution.expandedText,
      },
    };
  }

  if (resolution.kind === 'builtin') {
    if (resolution.command === '/anonymous' || resolution.command === '/incognito') {
      return {
        ...request,
        normalizedText,
        effectiveText: resolution.arguments,
        command: {
          kind: 'anonymous',
          command: resolution.command,
          arguments: resolution.arguments,
        },
      };
    }
    if (resolution.command !== '/confirm') {
      return {
        ...request,
        normalizedText,
        effectiveText: normalizedText,
        command: {
          kind: 'memory',
          command: resolution.command,
          arguments: resolution.arguments,
        },
      };
    }
    return {
      ...request,
      normalizedText,
      effectiveText: normalizedText,
      command: {
        kind: 'confirmation',
        command: resolution.command,
        arguments: resolution.arguments,
      },
    };
  }

  if (resolution.kind === 'builtin_unavailable' || resolution.kind === 'unknown') {
    return {
      ...request,
      normalizedText,
      effectiveText: normalizedText,
      command: {
        kind: resolution.kind,
        command: resolution.command,
        arguments: resolution.arguments,
      },
    };
  }

  return {
    ...request,
    normalizedText,
    effectiveText: normalizedText,
    command: resolution,
  };
}
