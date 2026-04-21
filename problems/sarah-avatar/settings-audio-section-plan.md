# Settings Audio Section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Audio" section to the Settings view that lets the user pick default input + output audio devices, using the existing `hud-select` component.

**Architecture:** New `createAudioSection(config)` factory mirrors the five existing `sections/*.ts` builders. Persists via `save('audio', audio)`, relying on the Phase 1 `audio-config-changed` IPC to propagate to `AudioBridge`. Includes a 2-line pre-connect guard in `hud-select`'s `value` setter (latent crash path for non-empty values set before `connectedCallback`).

**Tech Stack:** TypeScript, custom elements (`hud-select`), existing Settings section helpers (`createSectionHeader`, `createSpacer`, `save`, `showSaved`), Vitest for typecheck + existing tests.

**Spec:** `problems/sarah-avatar/settings-audio-section-design.md`

---

## File Structure

- **Modify** `src/renderer/components/hud-select.ts` — lines 236–241 (`value` setter) — add pre-connect guard.
- **Create** `src/renderer/dashboard/views/sections/audio-section.ts` — new Audio section factory.
- **Modify** `src/renderer/dashboard/views/settings.ts` — add import + one `appendChild` between Controls section and Wizard button.

No new test files. The `hud-select` guard is a minimal defensive fix — regression is covered by the manual smoke-test pathway documented in the spec ("Pflichtpfad #2: returning user with stored device") plus the typecheck pass. Introducing a DOM-test environment (jsdom/happy-dom) is scope creep for a 2-line guard.

---

## Task 1: Pre-connect guard in `hud-select` value setter

**Files:**
- Modify: `src/renderer/components/hud-select.ts` — lines 236–241

**Context:** The current `value` setter unconditionally calls `this.syncTriggerLabel()` which touches `this.triggerLabel.textContent`. These DOM fields are only initialised in `connectedCallback`, so a `value = 'some-id'` before mount throws `TypeError`. The cockpit panels never hit this path (`voice-in.ts` / `voice-out.ts` pass `value: ''` which the setter's early-return short-circuits), but the Settings section will set a non-empty stored device id pre-mount on every returning user.

- [ ] **Step 1: Read the current setter for confirmation**

Run:
```bash
sed -n '230,245p' src/renderer/components/hud-select.ts
```

Expected output:
```
  // ── Public API ────────────────────────────────────────────────────────────

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    if (this._value === v) return;
    this._value = v;
    this.syncTriggerLabel();
    this.syncOptionSelection();
  }

  setKind(kind: HudSelectKind): void {
```

- [ ] **Step 2: Replace the setter with the guarded version**

In `src/renderer/components/hud-select.ts`, replace lines 236–241 with:

```ts
  set value(v: string) {
    if (this._value === v) return;
    this._value = v;
    // Guard: `value` may be set before the element is connected to the DOM
    // (e.g. when a view builds its subtree in-memory and appends later).
    // `triggerLabel` / `trigger` are only assigned in `connectedCallback`,
    // so we skip the sync calls here and let `setOptions()` (called from
    // `connectedCallback` and `refreshDevices`) apply the stored `_value`
    // once the DOM is in place.
    if (!this.triggerLabel || !this.trigger) return;
    this.syncTriggerLabel();
    this.syncOptionSelection();
  }
```

- [ ] **Step 3: Run the renderer typecheck**

Run:
```bash
npm run typecheck:renderer
```

Expected: exits 0 with no errors.

- [ ] **Step 4: Run the existing test suite**

Run:
```bash
npm run test:run
```

Expected: all existing tests still pass (the guard adds a branch but doesn't change any tested behavior — `toDeviceOptions` unit tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/hud-select.ts
git commit -m "fix(hud-select): guard value setter against pre-connect use

The setter unconditionally called syncTriggerLabel()/syncOptionSelection(),
both of which touch DOM fields only populated in connectedCallback. Setting
value before mount with a non-empty string threw TypeError. Cockpit panels
never hit this because they always pass value: '' (which the early-return
short-circuits), but the upcoming Settings audio section needs to pre-set
a stored device id on returning users before the section is appended.

With the guard the stored _value is kept and applied once setOptions()
runs in connectedCallback (and again after refreshDevices completes)."
```

---

## Task 2: Create `audio-section.ts`

**Files:**
- Create: `src/renderer/dashboard/views/sections/audio-section.ts`

**Context:** Five sibling section files already exist in `src/renderer/dashboard/views/sections/` — this new one follows the same shape: imports helpers from `settings-utils`, exports a `create<Name>Section(config)` factory that returns an `HTMLElement`. `hud-select` is registered globally via `registerComponents()` in `dashboard.ts`, so no explicit import is needed.

- [ ] **Step 1: Create the file**

Create `src/renderer/dashboard/views/sections/audio-section.ts` with the following content:

```ts
import { createSectionHeader, createSpacer, save, showSaved } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

type HudSelectElement = HTMLElement & { value: string };

export function createAudioSection(config: SarahConfig): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Audio');
  section.appendChild(header);

  const audio = { ...(config.audio ?? {}) };

  const inputEl = document.createElement('hud-select') as HudSelectElement;
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

  const outputEl = document.createElement('hud-select') as HudSelectElement;
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

- [ ] **Step 2: Verify `config.audio` is part of `SarahConfig`**

Run:
```bash
grep -n "audio" src/core/config-schema.ts | head -20
```

Expected: at least one line referencing `AudioSchema` and one where `audio:` appears inside the `SarahConfigSchema`. If not, the Phase 1 IPC work is incomplete — stop and escalate before proceeding.

- [ ] **Step 3: Run the renderer typecheck**

Run:
```bash
npm run typecheck:renderer
```

Expected: exits 0 with no errors. If there's a type error on `config.audio`, it means the optional chaining (`config.audio ?? {}`) isn't enough — widen the spread type with `Partial<...>` as needed and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/views/sections/audio-section.ts
git commit -m "feat(settings): add audio section with device pickers

New sections/audio-section.ts mirrors the existing section pattern
and uses hud-select directly for input + output device selection.
Saves via save('audio', audio), which triggers the Phase 1
audio-config-changed IPC so the cockpit voice panels stay in sync.
Empty string from hud-select maps back to undefined to keep the
AudioSchema optional fields clean."
```

---

## Task 3: Mount the section in `settings.ts`

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

**Context:** The settings view appends its sections sequentially. The Audio section slots between the Controls section and the Wizard re-run button.

- [ ] **Step 1: Read the current `settings.ts`**

Run:
```bash
cat src/renderer/dashboard/views/settings.ts
```

Expected: imports for all five existing sections, a `createSettingsView` function that appends them, and a `wizardSection` created after.

- [ ] **Step 2: Add the import**

In `src/renderer/dashboard/views/settings.ts`, after the existing `import { createControlsSection }` line, add:

```ts
import { createAudioSection } from './sections/audio-section.js';
```

- [ ] **Step 3: Append the section**

After the line `container.appendChild(createControlsSection(config));` and before `// Wizard re-run button`, insert:

```ts
  container.appendChild(createAudioSection(config));
```

Keep the existing two-space indentation of the surrounding block.

- [ ] **Step 4: Run the renderer typecheck**

Run:
```bash
npm run typecheck:renderer
```

Expected: exits 0 with no errors.

- [ ] **Step 5: Run the main typecheck**

Run:
```bash
npm run typecheck:main
```

Expected: exits 0 with no errors.

- [ ] **Step 6: Run the test suite**

Run:
```bash
npm run test:run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "feat(settings): mount audio section between controls and wizard

One import + one appendChild. Audio section appears under the
Steuerung section in the settings view."
```

---

## Task 4: Full build + hand off for UI verification

**Files:** none (verification only)

**Context:** Per project rule, Claude runs typecheck / tests / build; Martin exercises the UI via `npm start`. The build is the last automated gate before the manual smoke tests from the spec.

- [ ] **Step 1: Run the full build**

Run:
```bash
npm run build
```

Expected: exits 0. Watch for esbuild or tsc errors in `audio-section.ts` or the modified files — a failure here is almost certainly a missing `.js` extension in the import or a typo in `hud-select` attribute handling.

- [ ] **Step 2: Report completion**

Write a short summary for Martin listing:
- Which 3 files were changed / created
- The 6 manual smoke-test paths from the spec ("Testing > Manuell (Pflichtpfade)") — he runs these via `npm start`
- Explicitly call out #2 ("bereits gespeichertes Device in Config") as the one that validates the hud-select guard fix

Do NOT run `npm start` — that is Martin's verification step.

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Scope-Erweiterung: hud-select guard | Task 1 |
| Architektur (new file, mount point) | Tasks 2, 3 |
| UI (two hud-selects, spacer, header) | Task 2 |
| Datenfluss (save + IPC roundtrip) | Task 2 |
| Fehlerbehandlung (inherited from hud-select) | n/a — no code needed |
| Testing — Unit (none new) | n/a |
| Testing — Manuell (6 paths) | Task 4 Step 2 (handoff) |
| Dateien (2 new / 2 modified — dropped JSDOM test, kept regression guard) | Tasks 1–3 |

**Placeholder scan:** No "TBD"/"TODO"/"implement later" in any task.

**Type consistency:** `HudSelectElement` is a local type alias in audio-section.ts; `change` event payload matches the `CustomEvent<{ value: string }>` emitted in `hud-select.ts:~509`. `save('audio', audio)` matches the `save()` signature in `settings-utils.ts`.

**Scope:** Single focused feature, one spec, three files. No decomposition needed.

**Deviations from spec:** Dropped the "recommended JSDOM smoke test" (`hud-select.dom.test.ts`) — deferred as scope creep (would require adding `jsdom`/`happy-dom` as devDep just for one test). The manual smoke-test path #2 covers the regression.
