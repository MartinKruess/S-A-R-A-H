import { describe, expect, it } from 'vitest';
import { looksLikeExplicitSpecialistGoal } from '../../../src/services/llm/specialist-goal-candidate.js';

describe('looksLikeExplicitSpecialistGoal', () => {
  it.each([
    'Baue TTS in Sarah ein',
    'Bitte implementiere die Audioausgabe im Sarah-Projekt',
    'Kannst du den Fehler im Repository reparieren?',
    'Refaktoriere diesen Code',
    'Recherchiere die aktuelle Studienlage zu Fahrradhelmen',
    'Bitte recherchiere belastbare Quellen über das Kolosseum',
  ])('recognizes an explicit delegation goal: %s', (text) => {
    expect(looksLikeExplicitSpecialistGoal(text)).toBe(true);
  });

  it.each([
    'Wie implementiert man TTS?',
    'Kannst du mir erklären, wie ich diesen Code repariere?',
    'Ich möchte wissen, wie ich den Fehler im Repository behebe',
    'Was ist Refactoring?',
    'Wann fand die Fußball-WM statt?',
    'Erkläre mir die aktuelle Studienlage',
    'Schreibe mir ein Gedicht',
    'Baue mir ein Bücherregal',
    'Öffne VS Code',
    'Hallo Sarah',
  ])('keeps an ordinary single request off the specialist gate: %s', (text) => {
    expect(looksLikeExplicitSpecialistGoal(text)).toBe(false);
  });
});
