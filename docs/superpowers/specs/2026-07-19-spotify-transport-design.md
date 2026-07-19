# Spotify V2 — Transport-Controls (Design)

**Datum:** 2026-07-19
**Branch:** `feat/spotify-transport`
**Vorgänger:** Spotify V1 (Lautstärke), PR #27 gemergt — OAuth-Layer, `SpotifyActions`, Settings-Tab „Integrationen".

## Ziel

Sarah steuert die Spotify-Wiedergabe per Sprache: Play/Pause, nächster/vorheriger Titel,
Zufallswiedergabe und Wiederholung. Alles über die Spotify Web API. **Kein** Namen-Matching
(„spiel Lied X") — das ist V3. **Kein** Re-Auth nötig: Scope `user-modify-playback-state`
ist seit V1 vorhanden.

Voraussetzung zur Laufzeit (wie V1): Spotify **Premium** + ein **aktives Gerät**. Fehlen sie,
antwortet Sarah ehrlich — die Fehlerpfade sind schon in `statusToResult` (V1) abgedeckt.

## Nicht-Ziele (YAGNI)

- Kein Play/Pause-**Toggle** — Spotify hat keinen; „Pause" und „Weiter" sind explizit und eindeutig.
- Kein Namen-/Playlist-Matching, keine Suche → V3.
- Keine Playlist-Bearbeitung → V4.

## Actions

Sechs neue Actions, konsistent zum bestehenden Muster (Prefix `spotify_`, wie `spotify_volume`).
Jede Fähigkeit ist eine eigen benannte Action — es gibt bewusst **keinen** Sammel-Enum-Param
(gibt es nirgends im Code, und getrennte Namen routen im kleinen 2B-Modell zuverlässiger).

| Action | Param-Schema | HTTP-Call |
|---|---|---|
| `spotify_play` | `z.literal('')` | `PUT /me/player/play` |
| `spotify_pause` | `z.literal('')` | `PUT /me/player/pause` |
| `spotify_next` | `z.literal('')` | `POST /me/player/next` |
| `spotify_previous` | `z.literal('')` | `POST /me/player/previous` |
| `spotify_shuffle` | `z.enum(['on','off'])` | `PUT /me/player/shuffle?state=true\|false` |
| `spotify_repeat` | `z.enum(['track','context','off'])` | `PUT /me/player/repeat?state=track\|context\|off` |

Die param-losen vier folgen `lock_screen` (`z.literal('')`). `shuffle`/`repeat` haben **einen**
Namen mit Enum-Param, analog zu `spotify_volume:<0-100>`.

### Repeat-Mapping (drei Zustände, 1:1 zur API)

- „Lied/Song/Titel wiederholen", „diesen Titel loopen" → `track`
- „Playlist/Album wiederholen", „Wiederholen an", „Loop an" → `context`
- „Wiederholen aus", „Loop aus" → `off`

## Änderungen je Datei

### 1. `src/services/actions/action-schemas.ts`

Sechs Einträge in `ACTION_SCHEMAS`. `RouterService` importiert die Allowlist von hier — kein
zweiter Ort (bestehende Invariante R4-Mi4).

```ts
spotify_play:     z.literal(''),
spotify_pause:    z.literal(''),
spotify_next:     z.literal(''),
spotify_previous: z.literal(''),
spotify_shuffle:  z.enum(['on', 'off']),
spotify_repeat:   z.enum(['track', 'context', 'off']),
```

**Gate-Stämme** (`ACTION_HINT_STEMS`): konservativ um drei distinktive Stämme ergänzen —
`'pausier'`, `'shuffle'`, `'wiederhol'`. Die vorhandenen `'spotify'`/`'musik'` decken
„Spotify pause"/„Musik weiter" bereits ab. Sehr allgemeine Wörter („weiter", „zurück",
„nächst") bleiben **draußen** — sie würden im laufenden 9B-Gespräch dauernd fehl-swappen.
(Over-Matching kostet nur einen extra Routing-Swap, nie eine falsche Action — aber „weiter"
ist zu häufig, um es zu rechtfertigen.)

### 2. `src/services/actions/spotify-actions.ts`

Sechs Methoden auf `SpotifyActions`, gleiche Mechanik wie `setVolume`: Token holen →
`NOT_CONNECTED` wenn `null` → fetch → `statusToResult`. Ein privater Helfer kapselt
try/fetch/catch, damit die Methoden Einzeiler bleiben:

```ts
private async command(method: 'PUT' | 'POST', path: string): Promise<LaunchResult> {
  const token = await this.oauth.getAccessToken('spotify');
  if (token === null) return NOT_CONNECTED;
  try {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    return statusToResult(res.status);
  } catch (err) {
    console.warn('[SpotifyActions] command failed:', method, path, (err as Error).message);
    return { ok: false, speak: 'Das hat bei Spotify gerade nicht geklappt.' };
  }
}

play()     { return this.command('PUT',  '/me/player/play'); }
pause()    { return this.command('PUT',  '/me/player/pause'); }
next()     { return this.command('POST', '/me/player/next'); }
previous() { return this.command('POST', '/me/player/previous'); }
shuffle(state: 'on' | 'off')                { return this.command('PUT', `/me/player/shuffle?state=${state === 'on'}`); }
repeat(state: 'track' | 'context' | 'off')  { return this.command('PUT', `/me/player/repeat?state=${state}`); }
```

`statusToResult` bleibt unverändert und liefert die Fehlerpfade gratis: 404 → kein Gerät,
403 → Premium, 401 → neu verbinden, 200/204 → still ok.

### 3. `src/services/actions/action-service.ts`

Sechs `case`-Zweige im Dispatch-Switch, analog zu `spotify_volume`:

```ts
case 'spotify_play':     return this.deps.spotify.play();
case 'spotify_pause':    return this.deps.spotify.pause();
case 'spotify_next':     return this.deps.spotify.next();
case 'spotify_previous': return this.deps.spotify.previous();
case 'spotify_shuffle':  return this.deps.spotify.shuffle(parsed.data as 'on' | 'off');
case 'spotify_repeat':   return this.deps.spotify.repeat(parsed.data as 'track' | 'context' | 'off');
```

### 4. `src/services/llm/routing-prompt.ts`

Sechs Zeilen in der STEP-1-Command-Liste + deutsche Beispiele. Beim Repeat mehrere Beispiele,
damit das 2B-Modell „Lied" (`track`) von „Playlist" (`context`) trennt:

```
- spotify_play — Wiedergabe fortsetzen ("Weiter", "Play", "Mach weiter")
- spotify_pause — Wiedergabe pausieren ("Pause", "Stopp", "Halt an")
- spotify_next — nächster Titel ("Nächstes Lied", "Skip")
- spotify_previous — vorheriger Titel ("Vorheriges Lied", "Zurück", "Nochmal von vorn")
- spotify_shuffle:<on|off> — Zufallswiedergabe ("Shuffle an", "Zufallswiedergabe aus")
- spotify_repeat:<track|context|off> — Wiederholung ("Lied wiederholen" → track, "Playlist wiederholen"/"Loop an" → context, "Wiederholung aus" → off)
```

Beispiele im EXAMPLES-Block, u. a.:
```
User: "Pause" → [ACTION:spotify_pause] Ich pausiere.
User: "Nächstes Lied" → [ACTION:spotify_next] Weiter zum nächsten.
User: "Shuffle an" → [ACTION:spotify_shuffle:on] Zufallswiedergabe ist an.
User: "Wiederhol das Lied" → [ACTION:spotify_repeat:track] Ich lasse den Titel wiederholen.
```

## Tests (mirror V1)

- **`spotify-actions.test.ts`**: je Methode ein Test — korrekte URL + Methode + Bearer-Header,
  Status-Mapping (204 → ok, 403/404/401 → richtiger deutscher Speak, Netzwerk-Throw → generisch),
  `NOT_CONNECTED` ohne Token (fetch nie aufgerufen). `shuffle`/`repeat`: Query-String je Wert.
- **`action-schemas.test.ts`**: `spotify_shuffle`/`spotify_repeat` akzeptieren nur die Enum-Werte,
  param-lose Actions nur `''`. `isActionName` kennt die sechs neuen Namen.
- **`action-service.test.ts`**: Dispatch ruft die jeweils richtige `SpotifyActions`-Methode
  mit korrektem Argument; unbekannter/invalider Param → „Das kann ich noch nicht."

## Verifikation

- `npm run typecheck`, `npm test`, `npm run build` grün (Claude).
- Manuell (Martin, `npm start`): Musik läuft auf einem Gerät → „Pause"/„Weiter"/„Nächstes Lied"/
  „Shuffle an"/„Lied wiederholen" durchsprechen; ohne aktives Gerät → ehrliche Ansage prüfen.

## Doku-Nachzug

`problems/features.md`: V2 nach Merge auf „✅ umgesetzt" schieben, Roadmap-Zeile aktualisieren.
