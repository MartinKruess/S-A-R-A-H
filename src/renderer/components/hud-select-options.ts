/**
 * Pure helpers for the hud-select device picker.
 *
 * Kept DOM-free so the transform is unit-testable in a Node vitest environment
 * without pulling the SarahElement base class (which extends HTMLElement).
 */

export type HudSelectKind = 'audioinput' | 'audiooutput';

export interface HudSelectOption {
  value: string;
  label: string;
}

/** Shape compatible with `navigator.mediaDevices.enumerateDevices()` results. */
export interface DeviceInfoLike {
  deviceId: string;
  kind: string;
  label: string;
}

const FALLBACK_PREFIX: Record<HudSelectKind, string> = {
  audioinput: 'Mikrofon',
  audiooutput: 'Lautsprecher',
};

export const LABEL_PREFIX: Record<HudSelectKind, string> = {
  audioinput: 'Mikrofon',
  audiooutput: 'Ausgabe',
};

export const SYSTEM_DEFAULT_LABEL = 'System-Standard';

/**
 * Pure transform: `MediaDeviceInfo[]` → option list. The list is always
 * prepended with the "System-Standard" sentinel (value = ''). Devices whose
 * kind does not match are filtered out. Empty labels fall back to
 * `${FALLBACK_PREFIX[kind]} N`.
 */
export function toDeviceOptions(
  devices: readonly DeviceInfoLike[],
  kind: HudSelectKind,
): HudSelectOption[] {
  const matching = devices.filter((d) => d.kind === kind);
  const fallbackName = FALLBACK_PREFIX[kind];
  const mapped: HudSelectOption[] = matching.map((d, index) => ({
    value: d.deviceId,
    label:
      d.label && d.label.trim().length > 0
        ? d.label
        : `${fallbackName} ${index + 1}`,
  }));
  return [{ value: '', label: SYSTEM_DEFAULT_LABEL }, ...mapped];
}
