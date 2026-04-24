# Metallic Shimmer (Chrom-Jitter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a subtle elliptical `background-position` jitter (4px / 2px amplitude, 16s cycle) to all `<sarah-panel>` instances so Cockpit panels feel like a slightly vibrating reflective metal surface rather than flat UI.

**Architecture:** Single-file change in `src/renderer/components/sarah-panel.ts`. Refactor existing `background` shorthand to `background-image` longhand so the new `background-size`/`background-position` survive accent-switch rules. Add a new `@keyframes cockpit-panel-jitter` block and extend the existing animation declaration. Randomize the `--jitter-phase` custom property per panel instance in `connectedCallback`, and add a pre-existing tech-debt fix (double-mount guard) while we're in the same function.

**Tech Stack:** CSS `@keyframes`, CSS Custom Properties with `color-mix`/`calc`, Shadow DOM Web Component (`SarahElement` base class), TypeScript.

**Test strategy:** This is a CSS/Shadow-DOM animation feature. Vitest runs in `node` environment without DOM, so the effect cannot be unit-tested. Verification is via `npm run typecheck` + `npm run test:run` (no regression in existing tests) + manual visual walkthrough in Electron. The Cockpit panels are statically mounted, so the double-mount guard is a "paranoid correctness" fix without a dedicated test.

**Spec:** `docs/superpowers/specs/2026-04-24-metallic-shimmer-design.md`

---

## File Structure

- **Modify:** `src/renderer/components/sarah-panel.ts` — CSS in the Shadow DOM block (5 rule changes + 1 new keyframes block + animation extension) and `connectedCallback` (2 line additions)

No new files. No changes to `styles/`, `settings.ts`, `wizard.ts`, `home.ts`, or any other file. Cockpit uses the default `--jitter-scale: 1` without any external override.

---

## Task 1: `background` → `background-image` Refactor

**Files:**
- Modify: `src/renderer/components/sarah-panel.ts` (5 CSS rules inside the `CSS` template string)

**Why:** The existing `background: <gradient>` shorthand resets all `background-*` longhand properties. When Task 2 adds `background-size` + `background-position` to the base rule, every `:host([accent="..."]) .panel-wrapper { background: ... }` switch would silently wipe them. Refactoring to `background-image` longhand first makes Task 2 safe.

- [ ] **Step 1: Change base `.panel-wrapper` rule**

Old (inside `src/renderer/components/sarah-panel.ts`, around line 37):
```css
  .panel-wrapper {
    position: relative;
    padding: 1px;
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-cyan) 15%, transparent);
```

New:
```css
  .panel-wrapper {
    position: relative;
    padding: 1px;
    background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-cyan) 15%, transparent);
```

- [ ] **Step 2: Change `accent="violet"` override**

Old (around line 50):
```css
  :host([accent="violet"]) .panel-wrapper {
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-violet));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-violet) 15%, transparent);
  }
```

New:
```css
  :host([accent="violet"]) .panel-wrapper {
    background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-violet));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-violet) 15%, transparent);
  }
```

- [ ] **Step 3: Change `accent="pink"` override**

Old (around line 59):
```css
  :host([accent="pink"]) .panel-wrapper {
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-pink));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-pink) 15%, transparent);
  }
```

New:
```css
  :host([accent="pink"]) .panel-wrapper {
    background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-pink));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-pink) 15%, transparent);
  }
```

- [ ] **Step 4: Change `accent="mint"` override**

Old (around line 68):
```css
  :host([accent="mint"]) .panel-wrapper {
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-mint));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-mint) 15%, transparent);
  }
```

New:
```css
  :host([accent="mint"]) .panel-wrapper {
    background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-mint));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-mint) 15%, transparent);
  }
```

- [ ] **Step 5: Change `state="error"` rule — uses solid color, different treatment**

Old (around line 76):
```css
  :host([state="error"]) .panel-wrapper {
    background: var(--cockpit-accent-red);
    box-shadow: 0 0 20px rgba(255, 59, 59, 0.25);
  }
```

New:
```css
  :host([state="error"]) .panel-wrapper {
    background-color: var(--cockpit-accent-red);
    background-image: none;
    box-shadow: 0 0 20px rgba(255, 59, 59, 0.25);
  }
```

The `background-image: none` is essential — without it, the accent-gradient would remain visible underneath and get tinted by the red `background-color`, producing a muddy overlay.

- [ ] **Step 6: Typecheck renderer**

Run: `npm run typecheck:renderer`
Expected: exit code 0, no errors reported.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/sarah-panel.ts
git commit -m "refactor(panel): use background-image longhand for accent and error rules"
```

---

## Task 2: Add Jitter Animation + Keyframes

**Files:**
- Modify: `src/renderer/components/sarah-panel.ts` (base `.panel-wrapper` rule + new keyframes block)

- [ ] **Step 1: Add `background-size` + `background-position` to base `.panel-wrapper`**

Old (inside base rule after Task 1, around line 36-43):
```css
  .panel-wrapper {
    position: relative;
    padding: 1px;
    background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-cyan) 15%, transparent);
    clip-path: ${CHAMFER_WRAPPER};
    height: 100%;
    transition: box-shadow 200ms ease;
    animation: cockpit-panel-breathe 6s ease-in-out infinite;
  }
```

New:
```css
  .panel-wrapper {
    position: relative;
    padding: 1px;
    background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
    background-size: calc(100% + 16px) calc(100% + 16px);
    background-position: 50% 50%;
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-cyan) 15%, transparent);
    clip-path: ${CHAMFER_WRAPPER};
    height: 100%;
    transition: box-shadow 200ms ease;
    animation:
      cockpit-panel-breathe 6s ease-in-out infinite,
      cockpit-panel-jitter 16s linear infinite;
    animation-delay: 0s, var(--jitter-phase, 0s);
  }
```

Three changes in this single edit:
- Added `background-size: calc(100% + 16px) calc(100% + 16px)` (8px extra each side, headroom for ±4px movement)
- Added `background-position: 50% 50%` (start position)
- Extended `animation:` to include `cockpit-panel-jitter 16s linear infinite`
- Added `animation-delay: 0s, var(--jitter-phase, 0s)` longhand — using longhand for the delay because `var()` inside an animation shorthand is ambiguous when two time values are present

- [ ] **Step 2: Add the new `@keyframes cockpit-panel-jitter` block**

Find the existing `@keyframes cockpit-panel-breathe` block (around line 85). Insert the new block immediately after it.

Old:
```css
  @keyframes cockpit-panel-breathe {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.98; }
  }

  @media (prefers-reduced-motion: reduce) {
```

New:
```css
  @keyframes cockpit-panel-breathe {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.98; }
  }

  @keyframes cockpit-panel-jitter {
    0% {
      background-position:
        calc(50% + 4px * var(--jitter-scale, 1))
        50%;
    }
    25% {
      background-position:
        50%
        calc(50% + 2px * var(--jitter-scale, 1));
    }
    50% {
      background-position:
        calc(50% - 4px * var(--jitter-scale, 1))
        50%;
    }
    75% {
      background-position:
        50%
        calc(50% - 2px * var(--jitter-scale, 1));
    }
    100% {
      background-position:
        calc(50% + 4px * var(--jitter-scale, 1))
        50%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
```

Four keyframe stops plus loop-close — describes a clockwise ellipse (right → down → left → up → right). `linear` easing keeps the motion continuous without easing dwell at the extremes. `var(--jitter-scale, 1)` default-preserves amplitude; external overrides (e.g., `0.5` for subliminal) scale proportionally.

- [ ] **Step 3: Verify reduced-motion block still covers the new animation (no code change expected)**

Find the existing block (around line 91 after insertion):
```css
  @media (prefers-reduced-motion: reduce) {
    .panel-wrapper {
      transition: none;
      animation: none;
    }
  }
```

Confirm: `animation: none` is the longhand-reset for all animations, so it stops both `cockpit-panel-breathe` and the new `cockpit-panel-jitter`. No change required.

- [ ] **Step 4: Typecheck renderer**

Run: `npm run typecheck:renderer`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/sarah-panel.ts
git commit -m "feat(panel): add cockpit-panel-jitter background-position animation"
```

---

## Task 3: Phase Randomizer + Double-Mount Guard in `connectedCallback`

**Files:**
- Modify: `src/renderer/components/sarah-panel.ts` (two line additions inside `connectedCallback`, around lines 226–298)

**Why:** Without a random phase offset per instance, all panels would animate in lockstep — we want async so the Cockpit feels organic. The double-mount guard is a pre-existing tech-debt fix recommended in the review feedback; it costs nothing while we're editing this method and prevents invisible bugs if the panel is ever disconnected and reconnected later.

- [ ] **Step 1: Add the double-mount guard at the very top of `connectedCallback`**

Old (around line 226):
```ts
  connectedCallback(): void {
    this.injectStyles(CSS);

    if (!isAccent(this.getAttribute('accent'))) {
      this.setAttribute('accent', 'cyan');
    }
```

New:
```ts
  connectedCallback(): void {
    if (this.wrapperEl) return;
    this.injectStyles(CSS);

    if (!isAccent(this.getAttribute('accent'))) {
      this.setAttribute('accent', 'cyan');
    }
```

`this.wrapperEl` is declared as `private wrapperEl!: HTMLElement` (non-null assertion). At runtime, before the first mount it is `undefined`, so the truthy check correctly returns early on re-entry.

- [ ] **Step 2: Add the phase randomizer after the state-default block**

Old (around line 233-236):
```ts
    if (!isState(this.getAttribute('state'))) {
      this.setAttribute('state', 'idle');
    }

    this.wrapperEl = document.createElement('div');
```

New:
```ts
    if (!isState(this.getAttribute('state'))) {
      this.setAttribute('state', 'idle');
    }

    this.style.setProperty('--jitter-phase', `${-Math.random() * 16}s`);

    this.wrapperEl = document.createElement('div');
```

`Math.random()` returns `[0, 1)`. Multiplying by 16 gives `[0, 16)`; negating gives `(-16, 0]`. A negative `animation-delay` tells the browser "this animation has already been running for N seconds" — so each panel starts at a different point in the 16-second cycle.

- [ ] **Step 3: Typecheck both main and renderer**

Run: `npm run typecheck`
Expected: exit code 0. Both `typecheck:main` (`tsc --noEmit`) and `typecheck:renderer` (`tsc -p tsconfig.renderer.json --noEmit`) pass clean.

- [ ] **Step 4: Run the existing test suite — verify no regressions**

Run: `npm run test:run`
Expected: All existing tests still pass. (Pre-existing `sqlite`-native failures, if any, are unrelated to this change — verify by comparing pass/fail count against the pre-change baseline if in doubt.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/sarah-panel.ts
git commit -m "feat(panel): randomize jitter phase per instance, add mount guard"
```

---

## Task 4: Manual Visual Verification

**Files:**
- None modified. Pure verification task.

- [ ] **Step 1: Start the development build**

Run: `npm run dev`
Expected: `concurrently` spawns 4 processes (main, types, rnd, app). Electron window opens with the Cockpit view. No build errors in the terminal.

- [ ] **Step 2: Inspect a `<sarah-panel>` in DevTools**

In the Electron window: `Ctrl+Shift+I` → Elements tab → find any `<sarah-panel>` → expand its shadow root → select `.panel-wrapper`.

Check the **Computed** styles pane:
- `animation-name` lists both `cockpit-panel-breathe` and `cockpit-panel-jitter`
- `animation-duration` is `6s, 16s`
- `animation-delay` shows `0s, <some-negative-value>s`
- `background-size` is `calc(100% + 16px) calc(100% + 16px)` (or resolved px value)

On the `<sarah-panel>` host element (Styles pane, not computed):
- `--jitter-phase` is a custom property set to a negative seconds value (e.g., `-7.34s`)

Expected: All values as described.

- [ ] **Step 3: Observe async phase across panels**

Watch the Cockpit for ~30 seconds. The 6 sarah-panels (SystemLoad, VoiceIn, VoiceOut, Termine, Wetter, Media) should show **slightly different** Hotspot positions — the bright areas of each panel's gradient should NOT reach their leftmost/rightmost points at the same moment.

Expected: Panels are clearly out-of-sync. If they all move in perfect unison, the randomizer didn't kick in (check Task 3 Step 2).

- [ ] **Step 4: Click through all 8 theme presets**

Open Settings → Personalisierung → Akzentfarbe/Theme picker. Click each of the 8 preset colors.

For each theme, confirm:
- Colors change as expected (accent gradient visibly updates)
- Jitter animation continues uninterrupted across theme changes — the motion does not pause, reset, or judder when the gradient source swaps
- System-load rings, hero planet, and panels all re-theme together (unrelated to this plan, but ensures we haven't broken Iteration 2)

Expected: Smooth theme switching with continuous jitter.

- [ ] **Step 5: Test error-state**

In DevTools Console:
```js
document.querySelectorAll('sarah-panel')[0].setAttribute('state', 'error');
```

Expected: The first panel turns solid red. The jitter animation is technically still running, but no motion is visible — a solid color has no inner hotspots that could appear to shift. This is the designed behavior (error should feel static/clear).

Revert with:
```js
document.querySelectorAll('sarah-panel')[0].setAttribute('state', 'idle');
```

- [ ] **Step 6: Test `prefers-reduced-motion`**

DevTools → three-dot menu → More tools → Rendering → scroll to "Emulate CSS media feature prefers-reduced-motion" → set to `reduce`.

Expected: Both `cockpit-panel-breathe` (subtle opacity pulse) and `cockpit-panel-jitter` stop. `background-position` is static at `50% 50%`. No visible motion on any panel.

Revert: set the emulation back to "No emulation".

- [ ] **Step 7: (Optional) Test double-mount guard**

In DevTools Console:
```js
const panel = document.querySelectorAll('sarah-panel')[0];
const parent = panel.parentNode;
parent.removeChild(panel);
parent.appendChild(panel);

// Inspect shadow root
panel.shadowRoot.querySelectorAll('.panel-wrapper').length;  // expect 1
panel.shadowRoot.querySelectorAll('style').length;           // expect 1
```

Expected: Exactly one `.panel-wrapper` and one `<style>` in the shadow root. Without the guard, both counts would be 2.

- [ ] **Step 8: Stop the dev server**

Close the Electron window and `Ctrl+C` the `npm run dev` process.

No commit — this task produces no code changes.

---

## Task 5: Final Full Typecheck + Test Suite

**Files:**
- None modified.

- [ ] **Step 1: Full typecheck (main + renderer)**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 2: Full test suite**

Run: `npm run test:run`
Expected: All tests pass. (Again: if pre-existing `sqlite`-native fails appear, they are unrelated.)

- [ ] **Step 3: Visual + build sanity check**

Run: `npm run build`
Expected: exit code 0. `tsc`, `esbuild`, and the renderer-types pass produce `dist/` output without errors.

- [ ] **Step 4: Hand off for user signoff**

Report to the user: Typecheck clean, tests green, build passes, manual visual walkthrough completed successfully. Offer merging via `superpowers:finishing-a-development-branch` — the jitter work is ready to be squash-merged into the existing `feat/cockpit-themes` branch's PR scope (or can stay as-is if a separate PR is preferred).

No commit.

---

## Spec-Coverage Check

| Spec Requirement | Covered In |
|---|---|
| `background` → `background-image` refactor (5 rules) | Task 1 Steps 1–5 |
| Error-state: `background-image: none` to unsuppress gradient | Task 1 Step 5 |
| `background-size: calc(100% + 16px)` for movement headroom | Task 2 Step 1 |
| `background-position: 50% 50%` start | Task 2 Step 1 |
| Animation combined (breathe + jitter) with longhand delay | Task 2 Step 1 |
| `@keyframes cockpit-panel-jitter` elliptical 4-point motion | Task 2 Step 2 |
| `--jitter-scale` default 1, `var()` multiplied amplitudes | Task 2 Step 2 (inside keyframes) |
| `--jitter-phase` randomized per instance | Task 3 Step 2 |
| Double-mount guard (recommended tech-debt) | Task 3 Step 1 |
| Reduced-motion already covered by existing block | Task 2 Step 3 (verification only) |
| Cockpit-only scope, no external overrides needed | File Structure section (no settings.ts/wizard.ts changes) |
| Async phase visibly uncorrelated across panels | Task 4 Step 3 |
| All 4 accents + error stability | Task 4 Steps 4–5 |
| Reduced-motion kills both animations | Task 4 Step 6 |

## Rollback

Each Task commits atomically to a single file. To roll back:
- Task 3 only: `git revert <task3-hash>` — phase randomizer + mount guard gone, visual animation still works in lockstep
- Task 2 + 3: `git revert <task2-hash>..<task3-hash>` — jitter feature removed cleanly, refactor stays
- All three tasks: `git revert <task1-hash>..<task3-hash>` — full feature removed, panel returns to pre-iteration-2 static state

## Execution

Recommended: **Subagent-Driven** (`superpowers:subagent-driven-development`). Tasks are small, each has clear verification (typecheck/test/visual), and the subagent-review cadence catches any String-mismatch in the CSS edits early.
