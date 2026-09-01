/**
 * Converts display-oriented clock notation into unambiguous German speech text.
 * The original UI/history text remains unchanged.
 *
 * @category Transformation
 */
export function prepareSpeechText(text: string): string {
  return text.replace(
    /\b([01]?\d|2[0-3]):([0-5]\d)\s+Uhr\b/giu,
    (_match, hour: string, minute: string) => (
      minute === '00'
        ? `${Number(hour)} Uhr`
        : `${Number(hour)} Uhr ${Number(minute)}`
    ),
  );
}
