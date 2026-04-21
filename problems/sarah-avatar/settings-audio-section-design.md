# Settings Audio Section — Design

**Datum:** 2026-04-21
**Branch:** `feat/dashboard` (Fortsetzung nach voice-panels Phase 6)
**Bezug:** `voice-panels-plan.md` — Phase 7 („Settings-Gegenstück", bisher als optional markiert)
**Revision:** v2 — 2026-04-21 nach `settings-audio-section-design-lücken.md`-Audit

## Kontext

Phase 7 aus dem voice-panels-Plan ist das Settings-Pendant zu den Cockpit Voice-Panels. Statt kompletter Spiegelung wird eine minimale Variante gebaut: nur die Default-Device-Pickers (Input + Output) erscheinen in Settings. Mute / Volume / Gain bleiben Cockpit-exklusiv.

Design-Treiber: Der HUD-Stil des Cockpits wandert demnächst auf den Rest der App. `hud-select` wird deshalb direkt in Settings eingesetzt statt eine zweite Settings-Variante zu pflegen — der Umbau fällt bei der späteren Style-Migration automatisch weg.

## Ziel

Neue Section „Audio" in der Settings-View, in der der Nutzer Default-Eingabe- und Ausgabegerät wählt. Änderungen werden über das bestehende `AudioSchema` persistiert und über den in Phase 1 verdrahteten IPC-Kanal `audio-config-changed` an die `AudioBridge` im Cockpit weitergereicht.

## Nicht-Ziele

- Kein Mute-Toggle in Settings (bleibt nur im Cockpit).
- Keine Volume-/Gain-Slider in Settings.
- Keine Live-Sync-Subscription zwischen Settings- und Cockpit-View (die sind im SPA nicht gleichzeitig gemountet — jede View liest Config frisch beim Aufbau).

## Scope-Erweiterung: `hud-select` Pre-Connection-Guard (Lücke 2)

`HudSelect` initialisiert DOM-Felder (`trigger`, `triggerLabel`, `listbox`) erst in `connectedCallback`. Der `value`-Setter ruft aber sofort `syncTriggerLabel()` + `syncOptionSelection()` auf, die auf diese Felder zugreifen. Wird `value` vor Einhängung in den Dokumentbaum gesetzt, gibt es einen `TypeError`.

**Fix (kleinster möglicher Eingriff):** Setter guarden.

```ts
set value(v: string) {
  if (this._value === v) return;
  this._value = v;
  if (this.triggerLabel && this.trigger) {
    this.syncTriggerLabel();
    this.syncOptionSelection();
  }
}
```

Das ist ein latenter Bug, den die Cockpit-Panels nie ausgelöst haben, weil sie `hud-select` erst nach Mount befüllen. Die Settings-Section baut aber offline (`createAudioSection` läuft bevor `settings.ts` den Container anhängt). Nach dem Fix speichert der Setter nur `_value`; `connectedCallback` → `setOptions()` ruft ohnehin `syncTriggerLabel` + `syncOptionSelection` auf, und der gespeicherte `_value` wird dort genutzt. Sobald `refreshDevices()` die echte Device-Liste nachlädt, re-rendert `setOptions()` nochmal und der gespeicherte `_value` wählt die korrekte Option aus.

## Architektur

**Neue Datei:** `src/renderer/dashboard/views/sections/audio-section.ts`

**Export:** `createAudioSection(config: SarahConfig): HTMLElement`

**Mount-Punkt:** `src/renderer/dashboard/views/settings.ts` — zwischen der bestehenden Controls-Section und dem Wizard-„Einrichtung erneut durchführen"-Button.

## UI

Struktur der Section:

1. Section-Header „Audio" + Save-Feedback-Span (via `createSectionHeader('Audio')`).
2. `<hud-select kind="audioinput">` — zeigt im Trigger „Mikrofon: \<Device\>".
3. Vertikaler Spacer (`createSpacer()`).
4. `<hud-select kind="audiooutput">` — zeigt im Trigger „Ausgabe: \<Device\>".

Die hud-select-internen Prefix-Labels („Mikrofon: …" / „Ausgabe: …") liefern die Control-Beschriftung; ein zusätzliches Outer-Label wäre redundant und wird weggelassen. Section-Header „Audio" gibt den Oberkontext.

Initial-Flash: Vor Abschluss von `refreshDevices()` zeigen beide Trigger „Mikrofon/Ausgabe: System-Standard", auch wenn bereits ein Device in `config.audio` gespeichert ist. Sobald die Enumeration zurückkommt (typisch <50ms), rendert `setOptions()` neu und der Trigger zeigt den echten Gerätenamen. Akzeptabel — kein zusätzliches Masking nötig.

## Datenfluss

Initialisierung (vollständiges Snippet):

```ts
import { createSectionHeader, createSpacer, save, showSaved } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

export function createAudioSection(config: SarahConfig): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Audio');
  section.appendChild(header);

  const audio = { ...(config.audio ?? {}) };

  const inputEl = document.createElement('hud-select') as HTMLElement & { value: string };
  inputEl.setAttribute('kind', 'audioinput');
  inputEl.value = audio.inputDeviceId ?? '';
  inputEl.addEventListener('change', (e) => {
    const value = (e as CustomEvent<{ value: string }>).detail.value;
    audio.inputDeviceId = value || undefined;
    save('audio', audio);
    showSaved(feedback);
  });
  section.appendChild(inputEl);

  section.appendChild(createSpacer());

  const outputEl = document.createElement('hud-select') as HTMLElement & { value: string };
  outputEl.setAttribute('kind', 'audiooutput');
  outputEl.value = audio.outputDeviceId ?? '';
  outputEl.addEventListener('change', (e) => {
    const value = (e as CustomEvent<{ value: string }>).detail.value;
    audio.outputDeviceId = value || undefined;
    save('audio', audio);
    showSaved(feedback);
  });
  section.appendChild(outputEl);

  return section;
}
```

Leerer String = „System-Standard" (im Schema `undefined`). `value || undefined` hält das Schema sauber.

`save('audio', audio)` ruft `window.sarah.saveConfig({ audio })`. Der Main-Prozess erkennt den `audio`-Diff, feuert `audio-config-changed` an den Renderer, `AudioBridge.applyAudioConfig` reagiert und das Cockpit-Panel synchronisiert seine eigene Anzeige automatisch.

Der `value`-Setter vor `appendChild` funktioniert nur mit dem Guard aus „Scope-Erweiterung" oben — ohne den Guard wäre die Zeile ein Runtime-Crash.

## Fehlerbehandlung

`hud-select` deckt bereits ab:
- `enumerateDevices()` schlägt fehl → stille Fallback-Liste (nur „System-Standard").
- Permission beim ersten Open verweigert → Options ohne Labels, System-Standard bleibt wählbar.
- Device-Hotplug → interner `devicechange`-Listener aktualisiert die Liste.

Defensive: `{ ...(config.audio ?? {}) }` falls `config.audio` wider Erwarten fehlt; das `AudioSchema` füllt Defaults beim Save wieder auf.

## Testing

**Unit:**
- Keine neuen Tests für `audio-section.ts` — die Section ist eine reine Verdrahtung existierender APIs, kein eigenständiges Verhalten zu testen.
- Bestehende Coverage ehrlich: `hud-select.test.ts` testet nur die pure Funktion `toDeviceOptions`; die `HudSelect`-Klasse (connectedCallback, `value`-Setter, `change`-Event, Device-Refresh) hat **keine** DOM-Tests. Der neue Setter-Guard ist also durch Unit-Tests nicht abgesichert.
- **Neu zu ergänzen (empfohlen):** Ein minimaler JSDOM-Test für `HudSelect`, der den pre-connect value-Pfad abdeckt: Element erzeugen → `value = 'xyz'` → anhängen → erwarten, dass kein Throw und `element.value === 'xyz'`. Hält den latenten Bug künftig abgedeckt.

**Manuell (Pflichtpfade):**
1. Settings öffnen → Audio-Section zeigt beide Pickers; nach ~50ms Trigger-Texte aktualisiert.
2. Bereits gespeichertes Device in Config → nach Enumeration zeigt Trigger genau dieses Device ausgewählt (nicht „System-Standard"). *Deckt den Setter-Guard-Fix ab.*
3. Erstes Öffnen des Input-Pickers im `voiceMode='off'` → OS-Mic-Permission-Prompt erscheint (gleiches Verhalten wie im Cockpit).
4. Input-Device wechseln → Settings neu öffnen → Auswahl bleibt bestehen.
5. Output-Device wechseln → Cockpit aufrufen → Voice-Out-Panel zeigt dasselbe Gerät ausgewählt.
6. Im Cockpit Device wechseln → zurück zu Settings → Picker zeigt neuen Wert (frischer Config-Read beim View-Aufbau).

## Dateien

**Neu:**
- `src/renderer/dashboard/views/sections/audio-section.ts`
- *(empfohlen)* `src/renderer/components/hud-select.dom.test.ts` — Pre-Connect value-Setter-Smoke

**Geändert:**
- `src/renderer/dashboard/views/settings.ts` (ein Import, ein `appendChild`)
- `src/renderer/components/hud-select.ts` (`value`-Setter-Guard, 2 Zeilen)

## Offene Punkte

Keine — alle drei Lücken aus dem Audit adressiert.
