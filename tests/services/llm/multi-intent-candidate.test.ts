import { describe, expect, it } from 'vitest';
import { looksLikeBoundedMultiIntentCandidate } from '../../../src/services/llm/multi-intent-candidate.js';

describe('looksLikeBoundedMultiIntentCandidate', () => {
  it.each([
    'Setze die Lautstärke auf 30 Prozent und öffne Spotify',
    'Erinnere mich morgen an Tee, anschließend sperre den Bildschirm',
    'Pausiere die Musik; daraufhin spiele sie weiter',
    'Öffne meinen Editor sowie starte den Browser',
    'Erkläre Fahrräder. Erkläre Rom',
    'Erkläre Fahrräder, erkläre Rom',
    'Erkläre Fahrräder & erkläre Rom',
    'Stelle einen Timer oder öffne Spotify',
    'Open Spotify and start Photoshop',
    'Explain bicycles, then explain Rome',
    'Set a timer or open Spotify',
    'Search for hotels afterwards explain the results',
    'Sarah, öffne Spotify und stelle einen Timer',
    'Hey Sarah, erkläre Fahrräder. Erkläre Rom',
    'Kannst du Spotify öffnen und einen Timer stellen?',
    'Hey Sarah, kannst du bitte Spotify öffnen und einen Timer stellen?',
    'Could you open Spotify and set a timer?',
  ])('recognizes an explicit multi-intent or alternative request: %s', (text) => {
    expect(looksLikeBoundedMultiIntentCandidate(text)).toBe(true);
  });

  it.each([
    'Setze die Lautstärke auf 30 Prozent',
    'Erkläre Vor- und Nachteile von Fahrrädern',
    'Suche Hotels oder Ferienwohnungen',
    'Und was war nochmal Chlorophyll?',
    'Der Timer und Spotify sind praktisch',
    'Open Spotify',
    'What is Rome?',
    'Sarah, öffne Spotify',
    'Hey Sarah, wie spät ist es?',
    'Kannst du Spotify öffnen?',
    'Kannst du Spotify und Photoshop öffnen?',
    'Kannst du Vor- und Nachteile erklären?',
    'Kannst du mir sagen, was Rom ist?',
    'Hey Sarah, kannst du erklären, warum der Himmel blau ist?',
  ])('keeps a single intent or compound phrase outside the plan gate: %s', (text) => {
    expect(looksLikeBoundedMultiIntentCandidate(text)).toBe(false);
  });
});
