const DISPLAY_INTENT_PATTERN = /(?:^|[^\p{L}])(?:öffn\p{L}*|zeig\p{L}*|anzeig\p{L}*|ruf\p{L}*|aufruf\p{L}*)(?=$|[^\p{L}])/iu;

const ORDINAL_PATTERNS: ReadonlyArray<readonly [number, RegExp]> = [
  [1, /(?:^|[^\p{L}])(?:erste|erster|erstes|ersten|erstem)(?=$|[^\p{L}])/iu],
  [2, /(?:^|[^\p{L}])(?:zweite|zweiter|zweites|zweiten|zweitem)(?=$|[^\p{L}])/iu],
  [3, /(?:^|[^\p{L}])(?:dritte|dritter|drittes|dritten|drittem)(?=$|[^\p{L}])/iu],
  [4, /(?:^|[^\p{L}])(?:vierte|vierter|viertes|vierten|viertem)(?=$|[^\p{L}])/iu],
  [5, /(?:^|[^\p{L}])(?:fünfte|fünfter|fünftes|fünften|fünftem)(?=$|[^\p{L}])/iu],
  [6, /(?:^|[^\p{L}])(?:sechste|sechster|sechstes|sechsten|sechstem)(?=$|[^\p{L}])/iu],
  [7, /(?:^|[^\p{L}])(?:siebte|siebter|siebtes|siebten|siebtem)(?=$|[^\p{L}])/iu],
  [8, /(?:^|[^\p{L}])(?:achte|achter|achtes|achten|achtem)(?=$|[^\p{L}])/iu],
];

/**
 * @param text - Natürliche Folgeanweisung nach einer erfolgreichen Websuche.
 *
 * - Erkennt nur sichtbare Öffnen-/Zeigen-Absichten.
 * - Wandelt Ziffern und deutsche Ordnungszahlen 1 bis 8 in den Session-Index um.
 * - Extrahiert nach „Ergebnis“ oder „Treffer“ alternativ einen Titel-Suchbegriff.
 *
 * @returns Index oder Titel-Suchbegriff für show_browser; sonst null.
 *
 * @category Business Logic Transformation
 */
export function resolveBrowserResultFollowup(text: string): string | null {
  const normalized = text.normalize('NFC').trim();
  if (!DISPLAY_INTENT_PATTERN.test(normalized)) return null;

  const numeric = normalized.match(/(?:^|[^\d])([1-8])(?:\s*\.|\b)/u)?.[1];
  if (numeric) return numeric;

  for (const [index, pattern] of ORDINAL_PATTERNS) {
    if (pattern.test(normalized)) return String(index);
  }

  const keyword = normalized.match(
    /(?:^|[^\p{L}])(?:ergebnis|treffer)\s+(?:zu\s+|mit\s+(?:dem\s+)?titel\s+)?(.+)$/iu,
  )?.[1]
    ?.replace(/\s+(?:im|in dem)\s+browser\s*$/iu, '')
    .trim();
  return keyword || null;
}
