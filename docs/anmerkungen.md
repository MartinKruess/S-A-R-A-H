# Programm-Scan — offene Punkte

> Stand 18.07.2026. Erledigt und entfernt: `type`-Feld (exe/launcher/appx/updater) und die appx-Launch-Logik (`explorer.exe shell:AppsFolder\<AUMID>`, Spotify verifiziert) sind im Action-Layer umgesetzt. Hier bleiben nur die noch offenen Scan-Probleme.

## ⚠️ Falsche / suboptimale Pfade

### 1. Discord — zeigt auf den Updater
```
"path": "C:\\Users\\Martin\\AppData\\Local\\Discord\\Update.exe"
```
Das ist nicht die App, sondern der Updater. Der Launcher **lehnt** `type: updater` zwar ehrlich ab, aber der Eintrag sollte auf die echte Exe zeigen:
```
C:\Users\Martin\AppData\Local\Discord\app-*\Discord.exe
```

### 2. PDFgear — Launcher statt Hauptprogramm
```
"path": "C:\\Program Files\\PDFgear\\PDFLauncher.exe"
```
Launcher, kein direktes Hauptprogramm. Kann funktionieren → beobachten, ggf. ersetzen.

## ⚠️ Grenzfälle (funktionieren evtl., aber beachten)

### 3. OneDrive
`OneDrive.exe` läuft oft als Hintergrunddienst → Starten bringt nicht immer ein sichtbares Ergebnis.

### 4. Epic Games Launcher
`...Win32\EpicGamesLauncher.exe` — Pfad wirkt ungewöhnlich (Win32 statt Win64). Nur prüfen, ob korrekt.

### 5. RocketLeague
`E:\rocketleague\Binaries\Win64\RocketLeague.exe` — Spiel evtl. Launcher-/Anti-Cheat-abhängig; kann direkt starten, aber nicht immer stabil.

## ⚠️ OpenOffice — überschneidende Aliases
Vorhanden: `soffice.exe` (Hauptprogramm) ✅, `scalc.exe`, `swriter.exe`, `sbase.exe`.
Die Aliases überschneiden sich (alle „OpenOffice"). Der Matcher fragt bei Mehrdeutigkeit nach, die Überschneidung selbst bleibt.
Empfehlung: `soffice.exe` = Default, die anderen nur spezifisch nutzen.
