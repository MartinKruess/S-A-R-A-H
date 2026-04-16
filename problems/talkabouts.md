# Housekeeping Audit - Befunde

## Orphaned Files (loeschen)

| # | Pfad | Grund |
|---|---|---|
| 1 | `src/renderer/.gitkeep` | Renderer-Ordner hat Inhalt, Placeholder ueberfluessig |
| 2 | `test-detect.js` | Prototyp, Feature seit langem in main.ts eingebaut |
| 3 | `src/services/voice/providers/whisper-provider.ts` | Durch FasterWhisperProvider ersetzt, kein Import mehr |
| 4 | `styles/components.css` | Komplett leer, nirgends referenziert |

## Tote Variablen in src/main.ts

| # | Variable | Grund |
|---|---|---|
| 5 | `whisperError` | Wird gesetzt, aber nie gelesen - Boot laeuft immer weiter |
| 6 | `routerError` | Identische Situation |

## Totes IPC-Tripel (isFirstRun)

| # | Stelle | Grund |
|---|---|---|
| 7 | main.ts Handler + preload.ts Bridge + sarah-api.ts Type | Kein Renderer ruft sarah.isFirstRun() auf - alle lesen direkt config.onboarding via getConfig() |

## Stale Config

| # | Datei | Grund |
|---|---|---|
| 8 | tsconfig.json exclude `src/sarahOrb.ts` | Alter Dateiname - Datei heisst jetzt sarahHexOrb.ts, Exclusion greift nicht mehr |

## Totes CSS

| # | Regel | Grund |
|---|---|---|
| 9 | `.sarah-placeholder` in styles/dashboard.css | Klasse existiert in keinem HTML oder TS-File |

## Test fuer toten Code

| # | Datei | Grund |
|---|---|---|
| 10 | `tests/services/voice/whisper-provider.test.ts` | Testet whisper-provider.ts - das selbst dead code ist (Nr. 3) |

Wichtiger Hinweis Nr. 8: Der falsche tsconfig.json-Exclude fuehrt dazu, dass sarahHexOrb.ts vom Main-Process-Compiler mitverarbeitet wird (unbeabsichtigt).