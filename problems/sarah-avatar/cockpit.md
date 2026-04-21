# SARAH Dashboard – Electron Renderer (TypeScript + CSS)

Unten ist ein direkt nutzbares Grundgerüst für ein futuristisches SARAH-Dashboard in **Electron + TypeScript + CSS**.
Es besteht aus drei Dateien:

- `index.html`
- `styles.css`
- `renderer.ts`

Optional ist **Three.js** eingebunden, um im Hintergrund einen leuchtenden Orb / Core zu rendern. Das Dashboard selbst bleibt normales HTML/CSS, damit es wartbar bleibt.

---

## `index.html`

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;"
    />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0"
    />
    <title>SARAH Dashboard</title>
    <link
      rel="preconnect"
      href="https://fonts.googleapis.com"
    />
    <link
      rel="preconnect"
      href="https://fonts.gstatic.com"
      crossorigin
    />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Orbitron:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap"
      rel="stylesheet"
    />
    <link
      rel="stylesheet"
      href="./styles.css"
    />
  </head>
  <body>
    <div id="app-shell">
      <canvas id="orb-canvas"></canvas>
      <div class="bg-grid"></div>
      <div class="bg-noise"></div>

      <main class="dashboard">
        <header class="topbar panel sci-cut">
          <div>
            <p class="eyebrow">AI SYSTEM INTERFACE</p>
            <h1>SARAH Core Dashboard</h1>
          </div>

          <div class="topbar-right">
            <div class="status-pill">
              <span class="status-dot"></span>
              <span>ONLINE</span>
            </div>
            <div class="clock-block">
              <div id="clock-time">21:48</div>
              <div id="clock-date">Samstag, 18. April 2026</div>
            </div>
          </div>
        </header>

        <section class="grid-layout">
          <section class="left-column">
            <article class="panel sci-cut hero-panel">
              <div class="hero-copy">
                <p class="eyebrow">
                  SMART ASSISTANT FOR RESOURCE AND ADMINISTRATION HANDLING
                </p>
                <h2>
                  Systemkontrolle, Sprache, Termine und Live-Metriken in einer
                  Oberfläche.
                </h2>
                <p class="hero-text">
                  Futuristische Steuerzentrale für lokale KI, Audio-Ein- und
                  Ausgabe, Hardwarestatus, Termine und modulare Widgets.
                </p>
              </div>
              <div class="hero-badges">
                <div class="mini-chip">LOCAL AI</div>
                <div class="mini-chip">VOICE ACTIVE</div>
                <div class="mini-chip">GPU READY</div>
              </div>
            </article>

            <article class="panel sci-cut system-panel">
              <div class="panel-header">
                <div>
                  <p class="eyebrow">SYSTEM METRICS</p>
                  <h3>CPU · GPU · RAM</h3>
                </div>
                <button class="ghost-btn">Details</button>
              </div>

              <div class="metric-grid">
                <div class="metric-card cpu">
                  <div
                    class="ring"
                    data-value="34"
                  >
                    <svg viewBox="0 0 120 120">
                      <circle
                        class="ring-bg"
                        cx="60"
                        cy="60"
                        r="48"
                      ></circle>
                      <circle
                        class="ring-progress"
                        cx="60"
                        cy="60"
                        r="48"
                      ></circle>
                    </svg>
                    <div class="ring-label">
                      <strong id="cpuValue">34%</strong>
                      <span>CPU</span>
                    </div>
                  </div>
                  <div class="metric-meta mono">
                    <div>
                      <span>Takt</span><strong id="cpuClock">3.8 GHz</strong>
                    </div>
                    <div>
                      <span>Cores</span><strong id="cpuCores">8 / 16</strong>
                    </div>
                  </div>
                </div>

                <div class="metric-card gpu">
                  <div
                    class="ring"
                    data-value="61"
                  >
                    <svg viewBox="0 0 120 120">
                      <circle
                        class="ring-bg"
                        cx="60"
                        cy="60"
                        r="48"
                      ></circle>
                      <circle
                        class="ring-progress"
                        cx="60"
                        cy="60"
                        r="48"
                      ></circle>
                    </svg>
                    <div class="ring-label">
                      <strong id="gpuValue">61%</strong>
                      <span>GPU</span>
                    </div>
                  </div>
                  <div class="metric-meta mono">
                    <div>
                      <span>VRAM</span><strong id="gpuVram">6.1 / 8 GB</strong>
                    </div>
                    <div>
                      <span>Temp</span><strong id="gpuTemp">67°C</strong>
                    </div>
                  </div>
                </div>

                <div class="metric-card ram">
                  <div
                    class="ring"
                    data-value="72"
                  >
                    <svg viewBox="0 0 120 120">
                      <circle
                        class="ring-bg"
                        cx="60"
                        cy="60"
                        r="48"
                      ></circle>
                      <circle
                        class="ring-progress"
                        cx="60"
                        cy="60"
                        r="48"
                      ></circle>
                    </svg>
                    <div class="ring-label">
                      <strong id="ramValue">72%</strong>
                      <span>RAM</span>
                    </div>
                  </div>
                  <div class="metric-meta mono">
                    <div>
                      <span>Belegt</span><strong id="ramUsed">23.0 GB</strong>
                    </div>
                    <div>
                      <span>Total</span><strong id="ramTotal">32 GB</strong>
                    </div>
                  </div>
                </div>
              </div>
            </article>

            <article class="panel sci-cut voice-panel">
              <div class="panel-header">
                <div>
                  <p class="eyebrow">VOICE CONTROL</p>
                  <h3>Input / Output</h3>
                </div>
                <div class="voice-state-list">
                  <span class="state-tag active">Mic Live</span>
                  <span class="state-tag">TTS Ready</span>
                </div>
              </div>

              <div class="voice-grid">
                <section class="audio-card">
                  <div class="audio-card-header">
                    <h4>Voice In</h4>
                    <span
                      class="mono"
                      id="voiceInPercent"
                      >46%</span
                    >
                  </div>

                  <div class="device-row">
                    <label for="voiceInDevice">Eingabegerät</label>
                    <select id="voiceInDevice">
                      <option>Headset Mikrofon</option>
                      <option>USB Mikrofon</option>
                      <option>Default Device</option>
                    </select>
                  </div>

                  <div
                    class="waveform"
                    id="waveform-in"
                  ></div>

                  <div class="slider-row">
                    <label for="voiceInRange">Lautstärke Input</label>
                    <input
                      id="voiceInRange"
                      type="range"
                      min="0"
                      max="100"
                      value="46"
                    />
                  </div>
                </section>

                <section class="audio-card output">
                  <div class="audio-card-header">
                    <h4>Voice Out</h4>
                    <span
                      class="mono"
                      id="voiceOutPercent"
                      >68%</span
                    >
                  </div>

                  <div class="device-row">
                    <label for="voiceOutDevice">Ausgabegerät</label>
                    <select id="voiceOutDevice">
                      <option>Wireless Headset</option>
                      <option>Desktop Speaker</option>
                      <option>Default Device</option>
                    </select>
                  </div>

                  <div
                    class="waveform"
                    id="waveform-out"
                  ></div>

                  <div class="slider-row">
                    <label for="voiceOutRange">Lautstärke Output</label>
                    <input
                      id="voiceOutRange"
                      type="range"
                      min="0"
                      max="100"
                      value="68"
                    />
                  </div>
                </section>
              </div>
            </article>
          </section>

          <section class="right-column">
            <article class="panel sci-cut calendar-panel">
              <div class="panel-header">
                <div>
                  <p class="eyebrow">SCHEDULE</p>
                  <h3>Terminübersicht</h3>
                </div>
                <button class="ghost-btn">+ Event</button>
              </div>

              <div class="timeline-list">
                <div class="timeline-item active">
                  <div class="time mono">09:00</div>
                  <div class="timeline-node"></div>
                  <div class="timeline-content">
                    <strong>Daily System Check</strong>
                    <span>Monitoring · Logs · Health</span>
                  </div>
                </div>

                <div class="timeline-item">
                  <div class="time mono">11:30</div>
                  <div class="timeline-node"></div>
                  <div class="timeline-content">
                    <strong>Team Meeting</strong>
                    <span>Projektstatus und Aufgaben</span>
                  </div>
                </div>

                <div class="timeline-item">
                  <div class="time mono">14:00</div>
                  <div class="timeline-node"></div>
                  <div class="timeline-content">
                    <strong>TTS / STT Testlauf</strong>
                    <span>Audio-Pipeline und Latenz</span>
                  </div>
                </div>

                <div class="timeline-item">
                  <div class="time mono">17:30</div>
                  <div class="timeline-node"></div>
                  <div class="timeline-content">
                    <strong>Backup Sync</strong>
                    <span>Archive und HiDrive</span>
                  </div>
                </div>
              </div>
            </article>

            <article class="panel sci-cut weather-panel">
              <div class="panel-header compact">
                <div>
                  <p class="eyebrow">WEATHER</p>
                  <h3>Hamburg</h3>
                </div>
                <span class="status-pill thin"
                  ><span class="status-dot weather"></span>Live</span
                >
              </div>

              <div class="weather-main">
                <div>
                  <div class="weather-temp">21°</div>
                  <div class="weather-desc">Teilweise bewölkt</div>
                </div>
                <div class="weather-icon">☁</div>
              </div>

              <div class="weather-forecast mono">
                <span>12:00 · 20°</span>
                <span>15:00 · 22°</span>
                <span>18:00 · 19°</span>
                <span>21:00 · 16°</span>
              </div>
            </article>

            <article class="panel sci-cut assistant-panel">
              <div class="panel-header compact">
                <div>
                  <p class="eyebrow">SARAH CORE</p>
                  <h3>Status</h3>
                </div>
              </div>

              <div class="assistant-status-grid mono">
                <div><span>Router Model</span><strong>phi4-mini</strong></div>
                <div><span>Worker</span><strong>qwen3:8b</strong></div>
                <div><span>STT</span><strong>faster-whisper</strong></div>
                <div><span>TTS</span><strong>Piper</strong></div>
                <div><span>Latency</span><strong>5.4s</strong></div>
                <div><span>Mode</span><strong>Balanced</strong></div>
              </div>
            </article>
          </section>
        </section>
      </main>
    </div>

    <script
      type="module"
      src="./renderer.js"
    ></script>
  </body>
</html>
```

---

## `styles.css`

```css
:root {
  --bg: #05070d;
  --bg-2: #0b1220;
  --panel: rgba(11, 18, 32, 0.72);
  --panel-strong: rgba(17, 24, 39, 0.88);
  --line: rgba(126, 231, 255, 0.18);
  --line-strong: rgba(126, 231, 255, 0.34);

  --cyan: #00e5ff;
  --purple: #7c3aed;
  --pink: #ff2fd1;
  --mint: #22ffc0;
  --red: #ff4b5c;
  --text: #edf6ff;
  --text-muted: #99a9c3;

  --shadow-cyan: 0 0 24px rgba(0, 229, 255, 0.14);
  --shadow-purple: 0 0 28px rgba(124, 58, 237, 0.14);
  --shadow-pink: 0 0 24px rgba(255, 47, 209, 0.12);

  --radius: 18px;
  --radius-sm: 12px;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(
      circle at 50% 30%,
      rgba(124, 58, 237, 0.14),
      transparent 30%
    ),
    radial-gradient(circle at 65% 45%, rgba(0, 229, 255, 0.1), transparent 28%),
    linear-gradient(180deg, #07101b 0%, #05070d 100%);
  color: var(--text);
  font-family: Inter, system-ui, sans-serif;
}

body {
  position: relative;
}

#app-shell {
  position: relative;
  width: 100%;
  height: 100%;
}

#orb-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  opacity: 0.95;
}

.bg-grid,
.bg-noise {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.bg-grid {
  z-index: 1;
  background-image:
    linear-gradient(rgba(0, 229, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.045) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(circle at center, black 35%, transparent 95%);
}

.bg-noise {
  z-index: 2;
  opacity: 0.08;
  background-image:
    radial-gradient(
      circle at 20% 20%,
      rgba(255, 255, 255, 0.45) 0.6px,
      transparent 0.8px
    ),
    radial-gradient(
      circle at 70% 40%,
      rgba(255, 255, 255, 0.25) 0.6px,
      transparent 0.8px
    ),
    radial-gradient(
      circle at 45% 75%,
      rgba(255, 255, 255, 0.32) 0.7px,
      transparent 0.9px
    );
  background-size:
    190px 190px,
    240px 240px,
    170px 170px;
}

.dashboard {
  position: relative;
  z-index: 3;
  width: 100%;
  height: 100%;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 96px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 18px;
}

.clock-block {
  text-align: right;
}

#clock-time {
  font-family: Orbitron, sans-serif;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

#clock-date {
  color: var(--text-muted);
  font-size: 0.9rem;
}

.grid-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1.55fr 0.95fr;
  gap: 18px;
}

.left-column,
.right-column {
  min-height: 0;
  display: grid;
  gap: 18px;
}

.left-column {
  grid-template-rows: 0.8fr 1fr 1.15fr;
}

.right-column {
  grid-template-rows: 1.35fr 0.62fr 0.62fr;
}

.panel {
  position: relative;
  overflow: hidden;
  background: linear-gradient(
    180deg,
    rgba(11, 18, 32, 0.86),
    rgba(11, 18, 32, 0.68)
  );
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow:
    var(--shadow-cyan),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  padding: 18px 18px 16px;
}

.sci-cut {
  clip-path: polygon(
    12px 0,
    calc(100% - 12px) 0,
    100% 12px,
    100% calc(100% - 12px),
    calc(100% - 12px) 100%,
    12px 100%,
    0 calc(100% - 12px),
    0 12px
  );
}

.panel::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(
    135deg,
    rgba(0, 229, 255, 0.07),
    transparent 30%,
    rgba(255, 47, 209, 0.05)
  );
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--cyan);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-size: 0.68rem;
  font-weight: 700;
}

h1,
h2,
h3,
h4,
p {
  margin: 0;
}

h1,
h2,
h3 {
  font-family: Orbitron, sans-serif;
}

h1 {
  font-size: 1.7rem;
}

h2 {
  font-size: 1.55rem;
  line-height: 1.25;
  max-width: 760px;
}

h3 {
  font-size: 1.05rem;
}

h4 {
  font-size: 0.95rem;
}

.hero-panel {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.hero-copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hero-text {
  color: var(--text-muted);
  max-width: 760px;
  line-height: 1.5;
}

.hero-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.mini-chip,
.status-pill,
.state-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(0, 229, 255, 0.2);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text);
  font-size: 0.8rem;
}

.status-pill.thin {
  min-height: 28px;
  font-size: 0.72rem;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mint);
  box-shadow: 0 0 12px rgba(34, 255, 192, 0.7);
}

.status-dot.weather {
  background: var(--cyan);
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.7);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.panel-header.compact {
  margin-bottom: 14px;
}

.ghost-btn {
  border: 1px solid rgba(0, 229, 255, 0.24);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text);
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: 180ms ease;
}

.ghost-btn:hover {
  border-color: rgba(0, 229, 255, 0.5);
  box-shadow: 0 0 20px rgba(0, 229, 255, 0.12);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  height: calc(100% - 62px);
}

.metric-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 16px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 12px;
}

.ring {
  position: relative;
  width: 140px;
  height: 140px;
  margin: 0 auto;
}

.ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.ring-bg,
.ring-progress {
  fill: none;
  stroke-width: 8;
}

.ring-bg {
  stroke: rgba(255, 255, 255, 0.08);
}

.ring-progress {
  stroke-linecap: round;
  stroke-dasharray: 301.59;
  stroke-dashoffset: 301.59;
  transition: stroke-dashoffset 450ms ease;
  filter: drop-shadow(0 0 8px currentColor);
}

.metric-card.cpu .ring-progress {
  stroke: var(--cyan);
  color: var(--cyan);
}

.metric-card.gpu .ring-progress {
  stroke: var(--purple);
  color: var(--purple);
}

.metric-card.ram .ring-progress {
  stroke: var(--pink);
  color: var(--pink);
}

.ring-label {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.ring-label strong {
  font-family: Orbitron, sans-serif;
  font-size: 1.5rem;
}

.ring-label span {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.metric-meta {
  display: grid;
  gap: 8px;
}

.metric-meta > div,
.assistant-status-grid > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.metric-meta span,
.assistant-status-grid span {
  color: var(--text-muted);
}

.mono {
  font-family: 'JetBrains Mono', monospace;
}

.voice-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.audio-card {
  border-radius: 16px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(0, 229, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.audio-card.output {
  border-color: rgba(255, 47, 209, 0.12);
}

.audio-card-header,
.device-row,
.slider-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.device-row {
  flex-direction: column;
  align-items: stretch;
}

.device-row label,
.slider-row label {
  color: var(--text-muted);
  font-size: 0.82rem;
}

select,
input[type='range'] {
  width: 100%;
}

select {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.035);
  color: var(--text);
  border-radius: 12px;
  padding: 12px 14px;
  outline: none;
}

input[type='range'] {
  appearance: none;
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    rgba(0, 229, 255, 0.55),
    rgba(255, 47, 209, 0.55)
  );
  outline: none;
}

input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 0 18px rgba(0, 229, 255, 0.65);
  cursor: pointer;
}

.waveform {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  min-height: 84px;
  padding: 12px 8px;
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.03),
    rgba(255, 255, 255, 0.015)
  );
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.wave-bar {
  width: 100%;
  min-width: 6px;
  border-radius: 999px;
  background: linear-gradient(
    180deg,
    rgba(0, 229, 255, 0.95),
    rgba(124, 58, 237, 0.72)
  );
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
  transition: height 120ms linear;
}

.output .wave-bar {
  background: linear-gradient(
    180deg,
    rgba(255, 47, 209, 0.95),
    rgba(0, 229, 255, 0.72)
  );
}

.timeline-list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-left: 8px;
}

.timeline-list::before {
  content: '';
  position: absolute;
  left: 76px;
  top: 6px;
  bottom: 6px;
  width: 1px;
  background: linear-gradient(
    180deg,
    rgba(0, 229, 255, 0.4),
    rgba(255, 47, 209, 0.12)
  );
}

.timeline-item {
  display: grid;
  grid-template-columns: 58px 18px 1fr;
  align-items: start;
  gap: 12px;
}

.timeline-item .time {
  color: var(--text-muted);
  padding-top: 2px;
}

.timeline-node {
  width: 12px;
  height: 12px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 16px rgba(0, 229, 255, 0.85);
}

.timeline-item.active .timeline-node {
  background: var(--pink);
  box-shadow: 0 0 18px rgba(255, 47, 209, 0.9);
}

.timeline-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.timeline-content span,
.weather-desc,
.weather-forecast {
  color: var(--text-muted);
}

.weather-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 14px;
}

.weather-temp {
  font-family: Orbitron, sans-serif;
  font-size: 2.4rem;
}

.weather-icon {
  font-size: 3rem;
  color: var(--cyan);
  text-shadow: 0 0 18px rgba(0, 229, 255, 0.4);
}

.weather-forecast {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.weather-forecast span {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.assistant-status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.voice-state-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.state-tag.active {
  border-color: rgba(34, 255, 192, 0.3);
  box-shadow: 0 0 20px rgba(34, 255, 192, 0.1);
}

@media (max-width: 1280px) {
  .grid-layout {
    grid-template-columns: 1fr;
  }

  .metric-grid,
  .voice-grid,
  .assistant-status-grid,
  .weather-forecast {
    grid-template-columns: 1fr;
  }

  body {
    overflow: auto;
  }

  .dashboard {
    height: auto;
    min-height: 100%;
  }
}
```

---

## `renderer.ts`

```ts
import * as THREE from 'three';

type MetricIds = {
  valueEl: HTMLElement;
  ringEl: HTMLElement;
};

const CIRCLE_LENGTH = 2 * Math.PI * 48;

function setupClock(): void {
  const timeEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('clock-date');

  if (!timeEl || !dateEl) return;

  const update = () => {
    const now = new Date();

    timeEl.textContent = new Intl.DateTimeFormat('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);

    dateEl.textContent = new Intl.DateTimeFormat('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(now);
  };

  update();
  window.setInterval(update, 1000);
}

function setRingProgress(ringContainer: HTMLElement, percent: number): void {
  const circle =
    ringContainer.querySelector<SVGCircleElement>('.ring-progress');
  if (!circle) return;

  const clamped = Math.max(0, Math.min(100, percent));
  const offset = CIRCLE_LENGTH - (clamped / 100) * CIRCLE_LENGTH;

  circle.style.strokeDasharray = `${CIRCLE_LENGTH}`;
  circle.style.strokeDashoffset = `${offset}`;
  ringContainer.setAttribute('data-value', String(clamped));
}

function initMetricRings(): void {
  const rings = document.querySelectorAll<HTMLElement>('.ring');
  rings.forEach((ring) => {
    const value = Number(ring.dataset.value || 0);
    setRingProgress(ring, value);
  });
}

function updateMetric(metric: MetricIds, percent: number): void {
  metric.valueEl.textContent = `${percent}%`;
  setRingProgress(metric.ringEl, percent);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function initMockSystemMetrics(): void {
  const cpuValueEl = document.getElementById('cpuValue');
  const gpuValueEl = document.getElementById('gpuValue');
  const ramValueEl = document.getElementById('ramValue');

  const cpuClockEl = document.getElementById('cpuClock');
  const gpuVramEl = document.getElementById('gpuVram');
  const gpuTempEl = document.getElementById('gpuTemp');
  const ramUsedEl = document.getElementById('ramUsed');
  const ramTotalEl = document.getElementById('ramTotal');

  const rings = document.querySelectorAll<HTMLElement>('.metric-card .ring');
  if (
    !cpuValueEl ||
    !gpuValueEl ||
    !ramValueEl ||
    !cpuClockEl ||
    !gpuVramEl ||
    !gpuTempEl ||
    !ramUsedEl ||
    !ramTotalEl ||
    rings.length < 3
  ) {
    return;
  }

  const cpuMetric: MetricIds = { valueEl: cpuValueEl, ringEl: rings[0] };
  const gpuMetric: MetricIds = { valueEl: gpuValueEl, ringEl: rings[1] };
  const ramMetric: MetricIds = { valueEl: ramValueEl, ringEl: rings[2] };

  const update = () => {
    const cpu = randomBetween(18, 72);
    const gpu = randomBetween(28, 88);
    const ram = randomBetween(42, 84);

    updateMetric(cpuMetric, cpu);
    updateMetric(gpuMetric, gpu);
    updateMetric(ramMetric, ram);

    cpuClockEl.textContent = `${(3.3 + Math.random() * 1.1).toFixed(1)} GHz`;

    const usedVram = (2.2 + Math.random() * 5.2).toFixed(1);
    gpuVramEl.textContent = `${usedVram} / 8 GB`;
    gpuTempEl.textContent = `${randomBetween(52, 74)}°C`;

    const ramUsed = (ram / 100) * 32;
    ramUsedEl.textContent = `${ramUsed.toFixed(1)} GB`;
    ramTotalEl.textContent = `32 GB`;
  };

  update();
  window.setInterval(update, 2500);
}

function createWaveBars(container: HTMLElement, count = 24): HTMLDivElement[] {
  const bars: HTMLDivElement[] = [];
  container.innerHTML = '';

  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement('div');
    bar.className = 'wave-bar';
    bar.style.height = `${12 + Math.random() * 50}px`;
    container.appendChild(bar);
    bars.push(bar);
  }

  return bars;
}

function animateWaveBars(
  bars: HTMLDivElement[],
  intensity: () => number,
): void {
  const tick = () => {
    const level = intensity();

    bars.forEach((bar, index) => {
      const variance = Math.sin(Date.now() * 0.004 + index * 0.55) * 16;
      const randomBoost = Math.random() * 18;
      const height = Math.max(10, 18 + level * 0.52 + variance + randomBoost);
      bar.style.height = `${height}px`;
    });

    requestAnimationFrame(tick);
  };

  tick();
}

function initAudioControls(): void {
  const inRange = document.getElementById(
    'voiceInRange',
  ) as HTMLInputElement | null;
  const outRange = document.getElementById(
    'voiceOutRange',
  ) as HTMLInputElement | null;
  const inPercent = document.getElementById('voiceInPercent');
  const outPercent = document.getElementById('voiceOutPercent');
  const waveformIn = document.getElementById('waveform-in');
  const waveformOut = document.getElementById('waveform-out');

  if (
    !inRange ||
    !outRange ||
    !inPercent ||
    !outPercent ||
    !waveformIn ||
    !waveformOut
  ) {
    return;
  }

  const updateIn = () => {
    inPercent.textContent = `${inRange.value}%`;
  };

  const updateOut = () => {
    outPercent.textContent = `${outRange.value}%`;
  };

  inRange.addEventListener('input', updateIn);
  outRange.addEventListener('input', updateOut);

  updateIn();
  updateOut();

  const barsIn = createWaveBars(waveformIn, 26);
  const barsOut = createWaveBars(waveformOut, 26);

  animateWaveBars(barsIn, () => Number(inRange.value));
  animateWaveBars(barsOut, () => Number(outRange.value));
}

function initThreeOrb(): void {
  const canvas = document.getElementById(
    'orb-canvas',
  ) as HTMLCanvasElement | null;
  if (!canvas) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.set(0, 0.2, 5.8);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const ambient = new THREE.AmbientLight(0x88ccff, 0.55);
  scene.add(ambient);

  const point1 = new THREE.PointLight(0x00e5ff, 2.8, 20);
  point1.position.set(2.4, 2.2, 4.5);
  scene.add(point1);

  const point2 = new THREE.PointLight(0xff2fd1, 2.4, 16);
  point2.position.set(-2.8, -1.5, 3.2);
  scene.add(point2);

  const orbGroup = new THREE.Group();
  scene.add(orbGroup);

  const coreGeometry = new THREE.SphereGeometry(0.95, 64, 64);
  const coreMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x0d1f3b,
    emissive: 0x00bfff,
    emissiveIntensity: 1.25,
    roughness: 0.18,
    metalness: 0.3,
    transmission: 0.08,
    clearcoat: 0.8,
    clearcoatRoughness: 0.18,
  });
  const core = new THREE.Mesh(coreGeometry, coreMaterial);
  orbGroup.add(core);

  const shellGeometry = new THREE.IcosahedronGeometry(1.4, 1);
  const shellMaterial = new THREE.MeshStandardMaterial({
    color: 0x17263f,
    emissive: 0x4b1ba8,
    emissiveIntensity: 0.22,
    roughness: 0.58,
    metalness: 0.42,
    wireframe: true,
    transparent: true,
    opacity: 0.42,
  });
  const shell = new THREE.Mesh(shellGeometry, shellMaterial);
  orbGroup.add(shell);

  const haloGeometry = new THREE.TorusGeometry(2.05, 0.025, 16, 180);
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 0.28,
  });
  const halo = new THREE.Mesh(haloGeometry, haloMaterial);
  halo.rotation.x = Math.PI / 2.8;
  halo.rotation.y = 0.2;
  orbGroup.add(halo);

  orbGroup.position.set(0.6, 0.35, -0.8);

  const particlesGeometry = new THREE.BufferGeometry();
  const particleCount = 200;
  const positions = new Float32Array(particleCount * 3);

  for (let i = 0; i < particleCount; i += 1) {
    const i3 = i * 3;
    positions[i3] = (Math.random() - 0.5) * 12;
    positions[i3 + 1] = (Math.random() - 0.5) * 7;
    positions[i3 + 2] = (Math.random() - 0.5) * 4;
  }

  particlesGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions, 3),
  );

  const particlesMaterial = new THREE.PointsMaterial({
    color: 0x8fdfff,
    size: 0.03,
    transparent: true,
    opacity: 0.6,
  });

  const particles = new THREE.Points(particlesGeometry, particlesMaterial);
  scene.add(particles);

  const onResize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };

  window.addEventListener('resize', onResize);

  const animate = () => {
    const t = performance.now() * 0.001;

    core.rotation.y += 0.0035;
    shell.rotation.x += 0.0018;
    shell.rotation.y -= 0.0022;
    halo.rotation.z += 0.002;

    core.position.y = Math.sin(t * 1.2) * 0.08;
    shell.position.y = core.position.y;
    halo.position.y = core.position.y;

    coreMaterial.emissiveIntensity = 1.1 + Math.sin(t * 2.1) * 0.18;
    point1.intensity = 2.6 + Math.sin(t * 1.7) * 0.25;
    point2.intensity = 2.2 + Math.cos(t * 1.3) * 0.22;

    particles.rotation.y += 0.0008;
    particles.rotation.x += 0.00035;

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };

  animate();
}

function bootstrap(): void {
  setupClock();
  initMetricRings();
  initMockSystemMetrics();
  initAudioControls();
  initThreeOrb();
}

document.addEventListener('DOMContentLoaded', bootstrap);
```

---

## Installation / Einbindung

### 1. Three.js installieren

```bash
npm install three
npm install -D @types/three
```

### 2. TypeScript im Renderer kompilieren

Du brauchst am Ende eine `renderer.js`, die aus `renderer.ts` gebaut wird.

Beispiel mit normalem TS-Compile oder Vite/webpack/esbuild.

---

## Sinnvolle nächste Ausbaustufen

### Reale Metriken statt Mockdaten

Später kannst du im Electron-Preload echte Werte aus Node liefern, z. B. mit:

- `systeminformation`
- `os`
- `node-os-utils`

Dann ersetzt du in `initMockSystemMetrics()` die Zufallswerte durch IPC-Daten.

### Reale Audio-Devices

Für echte Input-/Output-Geräte kannst du im Renderer oder via Preload anbinden:

- `navigator.mediaDevices.enumerateDevices()` für Mic-Inputs
- Output-Device-Auswahl je nach Browser-/Electron-Support eingeschränkt

### Wetter / Kalender live

- Wetter per API
- Termine lokal aus deiner App / DB / IPC

### Orb weiter auf SARAH trimmen

Später kann der Orb:

- auf Spracheingabe reagieren
- bei TTS pulsieren
- je nach Accent Color umlackiert werden
- in einen „thinking mode“ wechseln

---

## Architektonischer Hinweis

Für Electron sauber trennen:

- **Main Process** → Systemdaten, Dateizugriff, APIs, Prozesse
- **Preload** → sichere Bridge via `contextBridge`
- **Renderer** → nur UI und Darstellung

Für dieses Dashboard ist das ideal, weil:

- UI futuristisch bleiben kann
- echte Hardwaredaten nicht direkt unsicher im Renderer liegen
- Voice / Calendar / Weather modular nachrüstbar bleiben

---

Wenn du willst, erweitere ich das im nächsten Schritt direkt auf eine **echte Electron-Struktur mit `main.ts`, `preload.ts`, IPC-Bridge und echten CPU/GPU/RAM-Daten`**.
