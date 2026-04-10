# Audio/STT-Fix für Claude

Stand: 2026-04-09

## Problem

Die Spracheingabe kommt sehr wahrscheinlich bis zum `VoiceService` durch, aber nicht als brauchbarer Text aus der STT-Stufe zurück. Deshalb wird am Ende kein `chat:message` an Sarah emittiert.

Die relevante Abbruchstelle ist im `VoiceService`:

- Wenn `transcribe(...)` einen leeren String liefert, wird direkt abgebrochen.
- Dann wird weder `voice:transcript` noch `chat:message` emittiert.

## Wahrscheinlichste Ursache

Der aktuelle `WhisperProvider` schreibt einfach den rohen `Float32Array`-Speicher als `.raw` auf Platte und ruft damit `whisper-cli` auf.

Das ist wahrscheinlich aus drei Gründen fehleranfällig:

1. Das Audio wird nicht sauber in ein eindeutig erwartetes Format umgewandelt.
2. Der übergebene `sampleRate` wird im Provider aktuell gar nicht verwendet.
3. Es wird `--output-txt` gesetzt, aber anschließend nur `stdout` ausgewertet. Je nach Verhalten von `whisper-cli` kann dadurch der eigentliche Transkripttext verfehlt werden.

## Was Claude prüfen und wahrscheinlich ändern sollte

### 1. Audioformat sauber machen

Nicht einfach den `Float32Array`-Buffer roh wegschreiben.

Stattdessen:

- `Float32` Samples aus `[-1, 1]` sauber nach `Int16 PCM` konvertieren.
- Eine echte `WAV`-Datei schreiben.
- Format klar auf `mono`, `16 kHz`, `16-bit PCM` festlegen.

Nur ein WAV-Header ohne passende PCM16-Konvertierung reicht nicht.

### 2. Sample-Rate wirklich berücksichtigen

Der `sampleRate`-Parameter von `transcribe(audio, sampleRate)` darf nicht ignoriert werden.

Claude soll prüfen:

- Kommt wirklich `16000` an?
- Passt die Datei, die an Whisper übergeben wird, tatsächlich zu dieser Sample-Rate?

### 3. Whisper-Ausgabe korrekt lesen

Claude soll prüfen, wie `whisper-cli.exe` in dieser Konfiguration den Transkripttext wirklich ausgibt.

Aktuell ist riskant:

- `--output-txt` wird gesetzt
- aber nur `stdout` wird zurückgegeben

Claude soll daher entweder:

- die erzeugte `.txt`-Datei lesen,

oder

- `whisper-cli` so aufrufen, dass der eigentliche Text sicher über `stdout` kommt.

### 4. Kurz verifizieren

Nach dem Fix nicht nur Unit-Tests laufen lassen, sondern einmal gezielt prüfen:

1. Mikrofon aufnehmen
2. `transcribe(...)` liefert nicht-leeren Text
3. `voice:transcript` wird emittiert
4. `chat:message` erreicht den LLM-Service

## Kurzfassung für Claude

Der Fehler ist sehr wahrscheinlich **nicht** mehr die Audio-Pipeline bis zum `VoiceService`, sondern die Übergabe an Whisper.

Die wahrscheinlich richtige Richtung ist:

1. `Float32` -> `PCM16 WAV`
2. `sampleRate` korrekt verwenden
3. Whisper-Text aus dem richtigen Kanal lesen

Erst wenn `transcribe(...)` zuverlässig echten Text zurückgibt, erscheint Spracheingabe wieder als Chat-Text bei Sarah.
