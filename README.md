# 📺 Teleprompter

A real-time, zero-latency teleprompter that turns any phone or tablet into a professional prompting display — controlled from any laptop or desktop browser. No app install. No subscription. Just deploy once to Cloudflare and it's yours forever.

![Teleprompter screenshot](docs/screenshot.png)

---

## ✨ Why This Exists

Professional teleprompters cost thousands of dollars and require dedicated hardware. Teleprompter apps are clunky, require subscriptions, and don't give you precise remote control.

This project is different. It runs entirely on **Cloudflare's edge** — your script is loaded on a laptop, and your phone acts as the display. Both sides stay in perfect sync over a persistent WebSocket connection, with sub-100ms latency anywhere in the world.

---

## 🏗️ Architecture

The magic is powered by two Cloudflare primitives:

```
┌──────────────────────┐      WebSocket (WSS)      ┌────────────────────────┐
│  Controller (Laptop) │ ◄───────────────────────► │  Cloudflare Worker     │
│     index.html       │                           │  + Durable Object      │
└──────────────────────┘                           │  (TeleprompterSession) │
                                                   └──────────┬─────────────┘
┌──────────────────────┐      WebSocket (WSS)                 │
│  Display (Phone/Tab) │ ◄────────────────────────────────────┘
│    display.html      │
└──────────────────────┘
```

- **[Cloudflare Workers](https://workers.cloudflare.com/)** — serves the static UI and handles WebSocket upgrades at the edge, globally.
- **[Durable Objects](https://developers.cloudflare.com/durable-objects/)** — a single `TeleprompterSession` object holds the authoritative state (script, playback, speed, scroll position) and brokers messages between the controller and display clients in real time.
- **Static Assets** — HTML, JS, and CSS are served directly from the Worker using the `ASSETS` binding — no separate CDN needed.

There is **no database**, **no server to manage**, and **no cold starts**. The Durable Object keeps the session alive as long as clients are connected.

---

## 🚀 Features

### Controller (Laptop / Desktop)
- **Script editor** — paste or type your script with full Markdown support
- **Live preview** — rendered script mirrors exactly what the display shows
- **Amber keyline overlay** — a live bounding box on the preview shows precisely which lines are currently visible on the display screen
- **Play / Pause / Reset** — one-click playback control
- **Variable speed** — smooth 5–300 px/s range with a live slider
- **Display position tracking** — see exactly how far through the script the reader is (% progress)
- **Robust reconnection** — a heartbeat ping/pong detects dead connections and reconnects automatically; controls are disabled while disconnected so clicks never vanish silently
- **Keyboard shortcuts** for hands-free control:

| Key | Action |
|---|---|
| `Space` (hold) | Push-to-pause — hold to pause, release to resume |
| `↑` / `↓` | Seek back / forward one line |
| `←` / `→` | Speed down / up |
| `R` | Reset to start |

### Display (Phone / Tablet)
- **Auto-detected** — Android and iOS devices visiting `/` are automatically redirected to the display view
- **Full-screen black display** — high-contrast white text on black, optimised for on-camera reading
- **Large, responsive text** — fluid font sizing from 1.5rem to 2.25rem based on screen width
- **Screen wake lock** — keeps the display on while prompting using the native Wake Lock API (Chrome 84+, Safari 16.4+, Firefox 126+), with a NoSleep.js video-loop fallback for older browsers
- **Smooth scrolling engine** — float-precision scroll accumulator avoids the sub-pixel stalling that affects slow scroll speeds on some mobile browsers
- **Fullscreen mode** — one-tap fullscreen via the Fullscreen API, with platform-appropriate "Add to Home Screen" instructions as a fallback on browsers that restrict it
- **Auto-reconnect** — if the connection drops, the display reconnects silently and picks up where it left off

### Both
- **Markdown formatting** — enrich your script with structure:
  - `**bold**` → bright white emphasis
  - `*italic*` → golden yellow cue
  - `==highlight==` → amber highlight block
  - `# H1`, `## H2`, `### H3` → visual section breaks
  - `` `code` `` → red monospace (great for phonetic cues)
- **Real-time sync** — all state (script, play/pause, speed, scroll position) is synchronised instantly via WebSocket
- **Zero install** — runs in any modern browser, no app required

---

## 📋 Requirements

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed via `npm install`)

---

## 🛠️ Deploying

```bash
# 1. Clone the repo
git clone https://github.com/alicam/teleprompter.git
cd teleprompter

# 2. Install dependencies
npm install

# 3. Authenticate with Cloudflare
npx wrangler login

# 4. Deploy
npx wrangler deploy
```

Wrangler will print your Worker URL (e.g. `https://teleprompter.yourname.workers.dev`).

---

## 🎬 Using It

1. **Open the Worker URL on your laptop** — this is the Controller view
2. **Open the same URL on your phone** — it auto-redirects to the Display view, or tap "Open Display ↗" from the controller
3. On the phone, tap **Begin Prompting** (this acquires the wake lock and opens the WebSocket)
4. On the laptop, paste your script and click **Load Script →**
5. Hit **▶ Play** and start reading

> **Tip:** For a truly full-screen display on mobile, use "Add to Home Screen" and open from there. On iOS: tap **Share → Add to Home Screen**. On Android Chrome: tap the **⋮ menu → Add to Home Screen**.

---

## 🗂️ Project Structure

```
teleprompter/
├── src/
│   └── worker.js          # Cloudflare Worker + Durable Object (routing + real-time state)
├── public/
│   ├── index.html         # Controller UI (laptop/desktop)
│   ├── controller.js      # Controller logic — WebSocket, playback, keyline overlay
│   ├── display.html       # Display UI (phone/tablet)
│   ├── display.js         # Display logic — scroll engine, wake lock, fullscreen
│   ├── md.js              # Lightweight Markdown parser (no dependencies)
│   └── nosleep.js         # Screen wake lock fallback (silent video loop)
└── wrangler.toml          # Cloudflare deployment config
```

---

## ⚙️ How the WebSocket Protocol Works

The server acts as a simple message broker. Controllers send commands; displays execute them and report back their scroll position. Here is the full message flow:

```
Controller                    Server (Durable Object)               Display
    │                                  │                               │
    │── setScript ──────────────────►  │── scriptUpdate ─────────────►│
    │── play ────────────────────────► │── command: play ────────────►│
    │                                  │◄──── scrollUpdate ────────────│
    │◄── displayPosition ──────────────│                               │
    │── pause ───────────────────────► │── command: pause ───────────►│
    │── ping ────────────────────────► │── pong ──────────────────────│ (heartbeat)
```

See the top of `src/worker.js` for the full message type reference.

---

## 🔧 Customisation Ideas

- **Multi-room support** — change `idFromName('global')` in `worker.js` to use a room code from the URL, allowing multiple independent sessions
- **Font / colour themes** — edit the CSS variables in `display.html` and `index.html`
- **Script persistence** — store the script in [Cloudflare KV](https://developers.cloudflare.com/kv/) so it survives Durable Object eviction
- **Mirror mode** — add a CSS `scaleX(-1)` transform to `#script-text` for use with a physical beam-splitter rig
- **Speed presets** — add preset buttons (Slow / Medium / Fast) that snap the slider to common values

---

## 📄 License

MIT — do whatever you like with it.
