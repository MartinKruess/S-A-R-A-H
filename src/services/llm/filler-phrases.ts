// src/services/llm/filler-phrases.ts
//
// Static bridging phrases ("Füllsätze") spoken over the router↔worker model-swap
// silence in voice mode. Phrases are coupled to the technical state, not the topic
// (see problems/features.md §11-14). V1 wires only two categories:
//   - frontendThinking → spoken on the 2B→9B route (routing a complex message).
//   - switchingBack    → spoken on the 9B→2B gate (device command while 9B active).
// The remaining categories are defined for future states but are NOT triggered yet.

/** Technical states a bridging phrase can be attached to. */
export type FillerCategory =
  | 'frontendThinking'
  | 'backgroundAccepted'
  | 'deepSearchStarted'
  | 'backendBusy'
  | 'programStarting'
  | 'programLoading'
  | 'programReady'
  | 'memoryLoading'
  | 'taskCompleted'
  | 'switchingBack';

/**
 * One global pool per state (not per personality). `frontendThinking` carries the
 * full actively-used list (features.md §11.1); the future-use categories carry the
 * sample phrases from §12. `switchingBack` is not in the doc and is defined here.
 */
export const feedbackTexts: Record<FillerCategory, string[]> = {
  frontendThinking: [
    'Das schaue ich mir genauer an.',
    'Einen Moment, ich gehe etwas tiefer darauf ein.',
    'Lass mich das kurz durchdenken.',
    'Das ist eine interessante Frage.',
    'Ich beschäftige mich kurz damit.',
    'Lass mich eine vernünftige Antwort darauf vorbereiten.',
    'Einen Augenblick, ich ordne das kurz.',
    'Ich sehe mir das etwas genauer an.',
    'Da lohnt sich ein genauerer Blick.',
    'Moment, ich denke das einmal sauber durch.',
  ],

  backgroundAccepted: [
    'Alles klar, ich kümmere mich im Hintergrund darum.',
    'Die Aufgabe läuft jetzt im Hintergrund.',
    'Das ist angestoßen. Wir können währenddessen weitermachen.',
  ],

  deepSearchStarted: [
    'Ich gehe dem ausführlicher nach.',
    'Dafür starte ich eine gründlichere Recherche.',
    'Ich untersuche das etwas umfassender.',
  ],

  backendBusy: [
    'Ich arbeite im Hintergrund noch an einer größeren Aufgabe.',
    'Ich kann momentan nur eine große Aufgabe gleichzeitig bearbeiten.',
    'Die vorherige Aufgabe läuft noch.',
  ],

  programStarting: [
    'Alles klar, ich starte das Programm.',
    'Ich fahre die Anwendung hoch.',
    'Startbefehl ist raus.',
  ],

  programLoading: [
    'Das Programm fährt noch hoch.',
    'Die Anwendung lädt gerade.',
    'Der Start dauert noch einen Moment.',
  ],

  programReady: [
    'Das Programm ist jetzt einsatzbereit.',
    'Die Anwendung läuft.',
    'Alles bereit.',
  ],

  memoryLoading: [
    'Ich schaue kurz in unsere bisherigen Gespräche.',
    'Einen Moment, ich rufe den letzten Stand ab.',
    'Ich sehe kurz nach, wo wir aufgehört haben.',
  ],

  taskCompleted: [
    'Übrigens, die Recherche ist jetzt fertig.',
    'Ich habe inzwischen das Ergebnis deiner Anfrage vorliegen.',
    'Die Hintergrundaufgabe ist abgeschlossen.',
  ],

  switchingBack: ['Einen Moment.', 'Sofort.', 'Mach ich gleich.'],
};

/** Fallback spoken when a category's pool is empty. */
const EMPTY_POOL_FALLBACK = 'Einen Moment bitte.';

/**
 * Per-category ring of the last `historySize` phrases, so repeated calls avoid
 * saying the same line twice in a row. Module-internal state — intentionally NOT
 * a pure function; the `rng` param exists so tests can make randomness deterministic.
 */
const recentTexts: Record<string, string[]> = {};

/**
 * Pick a bridging phrase for `category`, avoiding the last `historySize` phrases
 * used for that category. Falls back to the full pool when everything is recent
 * (small pool), returns EMPTY_POOL_FALLBACK for an empty pool, and never loops on
 * a single-item pool. Updates the per-category history as a side effect.
 */
export function getFeedback(
  category: FillerCategory,
  historySize = 4,
  rng: () => number = Math.random,
): string {
  const texts = feedbackTexts[category];

  if (!texts || texts.length === 0) {
    return EMPTY_POOL_FALLBACK;
  }

  const recent = recentTexts[category] ?? [];
  const available = texts.filter((text) => !recent.includes(text));
  const pool = available.length > 0 ? available : texts;

  const selected = pool[Math.floor(rng() * pool.length)];

  recentTexts[category] = [...recent, selected].slice(-historySize);

  return selected;
}
