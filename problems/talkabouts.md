# Talkabouts — Beobachtete Bugs & Analyse

---

## Bug 1: Spotify-Start — Fehlmeldung obwohl Spotify startet

### Beobachtung

1. Sarah sagt „Okay, ich starte Spotify" (LLM-Feedback aus dem Router)
2. Spotify startet sichtbar im Hintergrund
3. Direkt danach: „Spotify ließ sich nicht starten — vielleicht ist die App nicht mehr installiert."

### Ursache (Code-Analyse)

`ProgramLauncher.launchAppx()` in `src/main/program-launcher.ts`:

```typescript
this.execFileFn('explorer.exe', [`shell:AppsFolder\\${aumid}`], (err) => {
  if (err) {
    resolve({
      ok: false,
      speak: `${program.name} ließ sich nicht starten — ...`,
    });
  } else {
    resolve({ ok: true });
  }
});
```

**Das Problem:** `explorer.exe shell:AppsFolder\<AUMID>` startet den App-Launch und beendet sich sofort — die eigentliche Startarbeit erledigt der _laufende Windows-Shell-Service_ asynchron im Hintergrund.

In der Praxis kann es passieren, dass `explorer.exe` einen **Nicht-Null-Exit-Code** zurückgibt (weil es den Request nur delegiert hat), obwohl der Shell-Service die App danach korrekt hochfährt. Der Code-Kommentar sagt zwar „exit 0 even for stale AUMID", aber in bestimmten Windows-Konfigurationen (z.B. wenn ein zweiter Explorer-Prozess startet und sich nach Delegation beendet) kommt tatsächlich ein Nicht-Null-Code an.

Resultat: `err !== null` → Fehlermeldung, während Spotify gleichzeitig startet.

### Warum stimmt die Timing-Beobachtung?

Der User beobachtet: „Es überprüft viel zu schnell ob das Ding fertig ist."

`execFile` feuert den Callback sobald explorer.exe sich beendet — das passiert in Millisekunden. Ob die App wirklich läuft, ist zu diesem Zeitpunkt noch unbekannt.

### Lösungsansatz

Nach dem `execFile`-Callback (egal ob Fehler oder nicht) eine **kurze Wartezeit + Prozess-Verifikation** einbauen:

```typescript
// Nach execFile-Callback: 2-3 Sekunden warten, dann tasklist prüfen
setTimeout(() => {
  execFile(
    'tasklist',
    ['/FI', `IMAGENAME eq Spotify.exe`, '/FO', 'CSV', '/NH'],
    (err2, stdout) => {
      const running = stdout?.includes('Spotify.exe');
      resolve(
        running
          ? { ok: true }
          : { ok: false, speak: `${program.name} ließ sich nicht starten.` },
      );
    },
  );
}, 2500);
```

Das würde sowohl False-Negatives (Explorer sagt Fehler, App läuft trotzdem) als auch das zu-frühe Prüfen lösen. Der Prozessname müsste pro App konfigurierbar sein (neues Feld `processName` in `ProgramEntry`).

**Alternativ:** `launchAppx` ignoriert `err` generell (da der Kommentar sagt: exit 0 selbst bei falscher AUMID) und gibt immer `{ ok: true }` zurück — Verifikation dann optional via `processName`.

---

## Bug 2: Lautstärke — System-Master statt App-Lautstärke, und Relativ vs. Absolut

### Teilproblem 2a: Bleibt bei 100%

#### Beobachtung

Beim Befehl „Lautstärke auf 50%" verändert sich zwar etwas im System-Sound-Panel, aber der Regler bleibt bei 100%.

#### Was der Code macht

`SystemActions.setVolume(percent)` in `src/services/actions/system-actions.ts`:

```typescript
const scalar = String(Math.round(percent) / 100); // 50 → "0.5"
// PowerShell-Script: [Audio]::SetVolume(0.5)
// → SetMasterVolumeLevelScalar(0.5f) auf IAudioEndpointVolume
```

Für `setVolume(50)` sollte der Scalar `0.5` korrekt produziert und der Systemlautstärke-Regler auf 50% gesetzt werden.

#### Mögliche Ursachen für „bleibt bei 100%"

**Hypothese A — LLM generiert relativen Delta statt absoluten Wert:**
Das Routing-Prompt zeigt:

```
"Mach die Musik leiser" → [ACTION:set_volume:30]
```

Das LLM weiß den aktuellen Wert nicht. Bei „Lautstärke um 50% erhöhen" könnte es `150` ausgeben (current=100 angenommen + 50). Zod-Schema `z.coerce.number().int().min(0).max(100)` würde `150` **ablehnen** → Aktion wird abgebrochen → keine Meldung, keine Änderung. Aber: der User sieht trotzdem etwas im Mixer → das könnte ein anderes Windows-Event sein.

**Hypothese B — Windows klemmt den Wert:**
Falls die Zod-Validierung für Werte > 100 versehentlich umgangen wird (z.B. durch direkte Rohdaten), würde `SetMasterVolumeLevelScalar(1.5f)` von Windows auf `1.0f` (100%) geclampt — sichtbar als „bleibt bei 100%". Das wäre das Bug-Pattern, das der User beschreibt.

**Hypothese C — PowerShell-Fehler ohne Speak:**
Das PowerShell-Inline-Script schlägt fehl (z.B. wegen fehlendem Zugriff auf den Audio-Endpoint), aber `execFn` gibt `err = null` zurück (Exit 0 trotz Exception). In diesem Fall würde `{ ok: true }` returned und keine Fehlermeldung erscheinen — und die Lautstärke ändert sich nicht.

#### Zu prüfen

- Was erzeugt das LLM exakt für „Lautstärke auf 50%"? → Logging ist vorhanden: `[Actions] set_volume:...` in der Main-Konsole prüfen
- Gibt PowerShell einen Fehler aus? → In der Konsole nach `[SystemActions] setVolume failed` suchen

### Teilproblem 2b: System-Lautstärke statt App-Lautstärke (Feature-Idee)

#### Beobachtung / Wunsch

Der User möchte nicht den Windows-Master-Lautstärkeregler ändern, sondern gezielt die **Spotify-App-Lautstärke im Windows Volume Mixer** (per-app volume). Der Systemlautstärke-Regler wird vom User nie manuell angefasst.

#### Aktueller Stand

`IAudioEndpointVolume::SetMasterVolumeLevelScalar` → ändert den **Master-Endpunkt-Volume** (entspricht dem Lautstärkeregler im System-Tray). Das ist die globale Systemlautstärke für alle Apps.

#### Ansatz für App-spezifische Lautstärke

Windows Core Audio bietet `IAudioSessionManager2` → `ISimpleAudioVolume`, mit dem man pro Audio-Session (= pro laufende App) die Lautstärke steuern kann:

1. Default-Playback-Endpoint holen (wie bisher)
2. `IAudioSessionManager2` aktivieren
3. Alle Sessions enumerieren (`GetSessionEnumerator`)
4. Session filtern: `IAudioSessionControl2::GetProcessId()` → PID gegen `tasklist` matchen für „Spotify"
5. `ISimpleAudioVolume::SetMasterVolume(scalar, &guid)` aufrufen

Das PowerShell-Inline-C#-Script wäre deutlich umfangreicher, aber machbar. Alternativ: ein Node.js-Addon via `ffi-napi` oder ein kleines C#-CLI-Helfer-Binary.

#### Schema-Erweiterung (Vorschlag)

Neue Action `set_app_volume` mit Param-Format `"spotify:50"` (appName:percent) ODER `set_volume` um ein optionales App-Targeting erweitern. Einfachste V2-Lösung wäre eine eigene Action:

```
set_app_volume:<appname>:<0-100> — set volume of a specific running app in the Volume Mixer
```

Routing-Prompt-Ergänzung:

```
set_app_volume:<appname>:<0-100> — per-app volume ("Mach Spotify leiser", "Spotify auf 50%")
set_volume:<0-100> — system master volume only if user explicitly says "Systemlautstärke"
```

---

## Offene Punkte / Nächste Schritte

| #   | Thema                                                                                           | Priorität |
| --- | ----------------------------------------------------------------------------------------------- | --------- |
| 1   | Bug: `launchAppx` — Verzögerung + Prozess-Verifikation via `tasklist` einbauen                  | Hoch      |
| 2   | Debug: `[Actions]`-Log im Prod-Run prüfen — was schickt das LLM als Param für set_volume?       | Hoch      |
| 3   | Debug: PowerShell-Stderr für `setVolume` auslesen — schlägt es fehl?                            | Hoch      |
| 4   | Routing-Prompt: Klarstellen dass `set_volume` ABSOLUTEN Zielwert (0-100) erwartet, nicht Deltas | Mittel    |
| 5   | Feature: `set_app_volume` Action für per-App-Lautstärke (Spotify, Chrome, etc.)                 | Mittel    |

1. öffne Spotify: Ja! aber mit meldung: Ist gestartet. Startet irgendwie nicht scheint nicht installiert zu sein. (Start + vordergrund = erfolgreich)
2. Musik Lautzstärke auf 50%: geht nicht!!!!

Weiterer Hinweis:
PUT https://api.spotify.com/v1/me/player/volume?volume_percent=5

Spotify auf x Prozent
Spotify etwas leiser (-5%)
Spotify leiser (-25%)
Spotify etwas lauter (+5%)
Spotify lauter (+25%)
Spotify x Prozent leiser
Musik auf x Prozent

Systemsound (die selben befehle)
Gezielte dinge wie Games, Browser und andere apps vllt auch??
