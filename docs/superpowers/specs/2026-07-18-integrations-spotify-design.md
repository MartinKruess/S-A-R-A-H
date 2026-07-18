# Integrationen V1 — Spotify per-App-Lautstärke via OAuth — Design

**Branch:** `feat/integrations-spotify` · **Stand:** 2026-07-18

## Problem / Ziel

Sarah soll gezielt die **Spotify-Lautstärke** steuern („Musik auf 50 %", „Spotify leiser") statt des Windows-Masters. Umsetzung über die **Spotify-Web-API** (`PUT /me/player/volume`). Dafür braucht es einen **einmaligen OAuth-Login** — und den bauen wir nicht Spotify-spezifisch, sondern als **generischen Verbindungs-Layer** („Integrationen"), dessen erster Provider Spotify ist. Später docken hier weitere Dienste an (GitHub/Gmail via OAuth, OpenAI/Claude/Codex via API-Key fürs Coding-Modul) — die Registry ist dafür erweiterbar zu bauen, aber **V1 verkabelt nur Spotify**.

## Scope

**In V1:**
- Generischer `OAuthConnectionService` (Main) + verschlüsselter Token-Store; **nur Spotify als Provider** registriert.
- Settings-Tab **„Integrationen"** mit „Verbinden/Trennen" pro Dienst.
- Actions `spotify_volume` (absolut) + `spotify_volume_adjust` (relativ), Routing + Gate-Wörter.
- Client-ID aus **env `SPOTIFY_CLIENT_ID`** (einmalige Dev-App-Registrierung dokumentiert).

**Nicht in V1 (bewusst):**
- Play/Pause/Skip/andere Spotify-Endpoints (nur Volume).
- Weitere Provider (GitHub/Gmail/OpenAI …) und **API-Key**-Verbindungstyp — Registry wird nur *vorbereitet*, nicht gebaut.
- Per-App-Mixer für Browser/Games (Windows `ISimpleAudioVolume`) — eigene spätere Runde.
- Master-Volume-Bug (`set_volume`) — separat/geparkt.

## Neue Abhängigkeit
`npm i openid-client` (v6, funktionale API): PKCE (`randomPKCECodeVerifier`/`calculatePKCECodeChallenge`), `buildAuthorizationUrl`, `authorizationCodeGrant`, `refreshTokenGrant`, `None()` für Public-Client ohne Secret.

---

## Architektur

### 1. `OAuthConnectionService` (Main, `src/services/integrations/oauth-connection-service.ts`)
Plain class (kein `SarahService`/Registry-Eintrag — analog `ProgramLauncher`/`SandboxBrowser`; wird via IPC und von `SpotifyActions` aufgerufen). Arbeitet mit einer **Provider-Registry** (Config-getrieben):

```ts
interface OAuthProvider {
  id: string;                 // 'spotify'
  displayName: string;        // 'Spotify'
  issuer: string;             // 'https://accounts.spotify.com'
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  clientId: string;           // aus env
}
```
(Struktur bewusst so, dass ein späterer `type: 'oauth' | 'apiKey'` + Key-Provider ergänzt werden kann, ohne Umbau.)

Methoden:
- `connect(providerId): Promise<void>` — PKCE erzeugen, **Loopback-Server** auf `http://127.0.0.1:8888/callback` starten, `shell.openExternal(buildAuthorizationUrl(...))`, Code+State abfangen, `authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier, expectedState })`, Tokens speichern, Server schließen. Timeout (5 min) + Fehler → Server schließen, Reject.
- `getAccessToken(providerId): Promise<string | null>` — Token-Blob laden; gültig (`expiresAt - now > 60s`) → zurückgeben; sonst `refreshTokenGrant` → neuen Access-Token. **Refresh-Token nur persistieren, wenn der Response einen neuen liefert (`refresh_token` ist im Refresh-Response OPTIONAL — Spotify rotiert nicht garantiert), sonst den bestehenden behalten** (Review-P3). Refresh-Fehler (widerrufen) → Verbindung als getrennt markieren, `null`.
- `disconnect(providerId): Promise<void>` — Token-Eintrag löschen.
- `getStatus(providerId): { connected: boolean; expiresAt?: number }`.
- `listConnections(): ConnectionInfo[]` — alle registrierten Provider + Status.

**openid-client-Config (Spotify hat kein OIDC-Discovery):**
```ts
const config = new client.Configuration(
  { issuer, authorization_endpoint, token_endpoint },  // ServerMetadata manuell
  clientId, undefined, client.None(),                  // Public-Client, kein Secret
);
```
Redirect-URI `http://127.0.0.1:8888/callback` (Loopback-IP `127.0.0.1`, nicht `localhost`). **Fester Port ist erforderlich** (Review-P1): Spotify verlangt eine **exakt vorregistrierte** Redirect-URI und unterstützt KEINE variablen Loopback-Ports (ein `:0`-Zufallsport nach RFC 8252 würde `INVALID_CLIENT: Invalid redirect URI` liefern). Port per env `SPOTIFY_REDIRECT_PORT` (Default `8888`) konfigurierbar, damit ein Konflikt durch env + Dashboard-Eintrag lösbar ist. Scopes: `user-modify-playback-state user-read-playback-state`.

### 2. Token-Store (`src/services/integrations/token-store.ts`)
Verschlüsselte Datei `connections.enc` in `userData`, Verschlüsselung über den bestehenden **`KeyManager`** (`src/core/crypto/key-manager.ts`, safeStorage + Maschinen-Fallback) — kein Klartext-Token auf Platte, keine DB-Kopplung (Secrets bleiben aus `config`/`messages` raus). Format:
```ts
type TokenStore = Record<string /*providerId*/, {
  refreshToken: string; accessToken: string; expiresAt: number; scope: string;
}>;
```

### 3. `SpotifyActions` (Main, `src/services/actions/spotify-actions.ts`)
Analog `SystemActions`; bekommt `OAuthConnectionService` injiziert. Nutzt `fetch` (injizierbar für Tests).
- `setVolume(percent): Promise<LaunchResult>` — `getAccessToken('spotify')`; kein Token → `{ ok:false, speak:'Verbinde Spotify zuerst in den Einstellungen.' }`. Sonst `PUT https://api.spotify.com/v1/me/player/volume?volume_percent=<p>` mit `Authorization: Bearer`.
- `adjustVolume(delta): Promise<LaunchResult>` — `GET /me/player` → `device.volume_percent` lesen, `clamp(cur+delta, 0, 100)`, dann PUT. Kein aktives Gerät → ehrliche Meldung.
- **Fehlerpfade (ehrliche `speak`):** `401` → nach einem Refresh-Retry weiterhin fehlgeschlagen: „Bitte verbinde Spotify neu."; `403` → „Dafür brauchst du Spotify Premium."; `404`/kein Gerät → „Ich sehe gerade kein aktives Spotify-Gerät."; sonst generisch „Das hat bei Spotify nicht geklappt."

### 4. Actions verdrahten
- **`action-schemas.ts`:** `spotify_volume: z.coerce.number().int().min(0).max(100)`, `spotify_volume_adjust: z.coerce.number().int().min(-100).max(100)` (signiert; Parser liefert z. B. `"-25"`). Gate-Stämme `ACTION_HINT_STEMS` um `'spotify'`, `'musik'` ergänzen.
- **`action-service.ts`:** neuer Dep `spotify: SpotifyActions` in `ActionDeps`; `case 'spotify_volume'` / `'spotify_volume_adjust'` im dispatch-`switch`.
- **`main.ts` (~Z. 90–112):** `oauth = new OAuthConnectionService(...)`, `spotifyActions = new SpotifyActions(oauth)`, in die `ActionService`-Deps aufnehmen.
- **`routing-prompt.ts`:** neue Zeilen + Beispiele:
  ```
  spotify_volume:<0-100> — Spotify/Musik auf absoluten Wert ("Musik auf 50", "Spotify auf 30 Prozent")
  spotify_volume_adjust:<signed> — Spotify/Musik relativ ("Spotify leiser" -25, "etwas leiser" -5, "10% leiser" -10, "lauter" +25)
  set_volume:<0-100> — NUR wenn ausdrücklich "Systemlautstärke" gesagt wird
  ```

### 5. IPC + `window.sarah`-API
- **`src/core/ipc-contract.ts`:** `IpcCommands` erweitern:
  - `'connections-list': { input: void; output: ConnectionInfo[] }`
  - `'connection-connect': { input: string; output: { ok: boolean; error?: string } }`
  - `'connection-disconnect': { input: string; output: void }`
  - `ConnectionInfo = { id: string; displayName: string; connected: boolean; expiresAt?: number }`.
- **`src/main/ipc-connections.ts`** (neu, Muster wie `ipc-config.ts`): registriert die drei Handler, delegiert an `OAuthConnectionService`.
- **`sarah-api.ts` + `preload.ts`:** `SarahConnectionsApi { list(); connect(id); disconnect(id); }` als `sarah.connections`.

### 6. Settings-Tab „Integrationen"
- **`settings.ts`:** `TabId` um `'integrations'` erweitern, `TABS`-Eintrag, `buildPanelContent` → `createConnectionsSection(config)`.
- **`sections/connections-section.ts`** (neu, Muster wie `controls-section.ts`): lädt `sarah.connections.list()`, rendert je Provider Name + Status-Badge („Verbunden"/„Nicht verbunden") + Button „Verbinden"/„Trennen" → ruft `sarah.connections.connect/disconnect`, aktualisiert danach die Liste. Deutsche UI-Texte.

---

## Datenfluss

**Verbinden:** Settings → „Verbinden" → `sarah.connections.connect('spotify')` → IPC → `OAuthConnectionService.connect` → System-Browser (Spotify-Login/Consent) → Loopback fängt Code → Token-Tausch → verschlüsselt gespeichert → IPC resolved → UI zeigt „Verbunden".

**Sprachbefehl „Musik auf 50 %":** Router → `[ACTION:spotify_volume:50]` → `ActionService` → `SpotifyActions.setVolume(50)` → `getAccessToken` (ggf. Refresh) → `PUT /me/player/volume?volume_percent=50` → `action:result` (silent ok oder ehrliche Fehlermeldung).

---

## Sicherheit
- **PKCE + Public-Client (`None()`)** — kein Client-Secret im Build (passt zur Distributions-Strategie: kein Secret im ausgelieferten Endkunden-Build).
- **`state`-Param** gegen CSRF im Callback (`expectedState`).
- **Loopback nur `127.0.0.1`**, Server nur während des Connect-Flows offen, danach geschlossen.
- **Tokens verschlüsselt** (KeyManager/safeStorage), nie in `config`/DB/Logs.

## Edge-Cases
- Redirect-Port (`SPOTIFY_REDIRECT_PORT`, Default 8888) belegt → Connect bricht mit klarer Meldung ab („Port … ist belegt — in `SPOTIFY_REDIRECT_PORT` einen freien Port setzen und im Spotify-Dashboard eintragen"). Server ist nur während des Connect-Flows offen.
- `SPOTIFY_CLIENT_ID` fehlt → Provider erscheint als „nicht konfiguriert", Connect-Button deaktiviert, **konkreter Hinweis mit Verweis auf den Einrichtungs-Abschnitt** (Review-P2): „Spotify-Client-ID fehlt — App im Spotify-Dashboard anlegen, Redirect-URI `http://127.0.0.1:8888/callback` eintragen, Client-ID als `SPOTIFY_CLIENT_ID` setzen (siehe Einrichtung unten)."
- Refresh-Token widerrufen → Status „getrennt", Volume-Befehl bittet um Neu-Verbinden.
- Kein aktives Spotify-Gerät → ehrliche Meldung (kein stiller Fehlschlag).

## Tests
- `OAuthConnectionService`: Token-Roundtrip (gestubbter KeyManager), `getAccessToken` gültig vs. Refresh bei Ablauf (openid-client-Aufrufe injiziert/gemockt), `disconnect` leert; Refresh-Fehler → getrennt.
- `SpotifyActions`: gemockter `fetch` → `setVolume` 204 ok; `adjustVolume` liest Ist-Wert + clampt; Fehlerpfade 401/403/404/nicht-verbunden → korrekte `speak`.
- `action-schemas`: Bounds/Signed für die zwei neuen Schemas; Gate erkennt „Spotify/Musik leiser".
- `connections-section` (Renderer): rendert Provider, Buttons rufen die API, Status-Update nach connect/disconnect.

## Einmalige Einrichtung (dokumentiert, Martin vor dem Testen)
1. developer.spotify.com/dashboard → **Create app**.
2. Redirect-URI **exakt** `http://127.0.0.1:8888/callback` eintragen.
3. Scopes brauchen keine Vorab-Freigabe (User-Consent beim Login).
4. **Client-ID** kopieren → `SPOTIFY_CLIENT_ID` als env setzen (Dev). Für die spätere Distribution: eine Projekt-App, öffentliche Client-ID mitgeliefert (PKCE, kein Secret).

## Umsetzungsreihenfolge (für die Plan-Phase)
1. `npm i openid-client` + Provider-Config/Registry + Token-Store (KeyManager) + Tests.
2. `OAuthConnectionService` (connect/loopback/refresh/getAccessToken) + Tests.
3. IPC (`ipc-connections.ts` + Contract + preload + sarah-api).
4. Settings-Tab „Integrationen" + `connections-section`.
5. `SpotifyActions` + Actions/Schemas/Dispatch/main-Wiring + Routing/Gate-Wörter + Tests.
6. Manueller End-to-End-Test (Martin) — **erst NACH Schritt 5**, sonst greifen die Gate-Wörter/Actions noch nicht (Review-P5): Verbinden → „Musik auf 30 %".
