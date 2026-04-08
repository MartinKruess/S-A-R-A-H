⚠️ Verdächtige / „Fake“-Exe (nicht ideal zum Starten)

1. Discord
   "path": "C:\\Users\\Martin\\AppData\\Local\\Discord\\Update.exe"

👉 Problem:

Das ist nicht die eigentliche App
das ist der Updater

👉 Besser:

C:\Users\Martin\AppData\Local\Discord\app-\*\Discord.exe 2. PDFgear
"path": "C:\\Program Files\\PDFgear\\PDFLauncher.exe"

👉 Problem:

Launcher, kein direktes Hauptprogramm
kann funktionieren, aber ist nicht optimal

👉 Beobachten, ggf. ersetzen

3. LinkedIn / Outlook / Spotify (appx)
   "path": "appx:..."

👉 Problem:

keine .exe
Windows Store Apps

👉 Wichtig:

brauchst später separate Launch-Logik
NICHT mit exec starten
⚠️ Grenzfälle (können funktionieren, aber beachten) 4. OneDrive
"OneDrive.exe"

👉 läuft oft als Hintergrunddienst
→ starten bringt nicht immer sichtbares Ergebnis

5. Epic Games Launcher (Win32)
   ...Win32\EpicGamesLauncher.exe

👉 funktioniert, aber:

Pfad wirkt ungewöhnlich (Win32 statt Win64)
nur prüfen, ob korrekt 6. RocketLeague
E:\rocketleague\Binaries\Win64\RocketLeague.exe

👉 okay, aber:

Spiel → evtl. Launcher/Anti-Cheat abhängig
kann direkt starten, aber nicht immer stabil
✅ Gute Einträge (sauber)

Die hier sind perfekt:

Chrome
Firefox
VLC
VS Code
Audacity
OBS
DaVinci Resolve
Steam
OpenOffice (soffice.exe)
Opera GX

👉 das sind echte Haupt-Executables

⚠️ OpenOffice Spezialfall

Du hast:

soffice.exe (Hauptprogramm) ✅
scalc.exe
swriter.exe
sbase.exe

👉 Problem:
Aliases überschneiden sich (OpenOffice)

👉 Empfehlung:

soffice.exe = Default
die anderen nur spezifisch nutzen
🧠 Empfehlung für dein System (wichtig)

Füge pro Programm optional hinzu:

"type": "exe" | "launcher" | "appx"
Beispiel
{
"name": "Discord",
"path": "...\\Update.exe",
"type": "launcher",
"fixSuggested": true
}
