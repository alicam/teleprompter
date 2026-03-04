# 📺 Teleprompter

A real-time, zero-latency teleprompter that turns your iPhone into a professional prompting display — controlled from any laptop or desktop browser. No app install. No subscription. Just deploy once to Cloudflare and it's yours forever.

> 🖼️ *Screenshot coming soon*

---

## ✨ Why This Exists

Professional teleprompters cost thousands of dollars and require dedicated hardware. Teleprompter apps are clunky, require subscriptions, and don't give you precise remote control.

This project is different. It runs entirely on **Cloudflare's edge** — your script is loaded on a laptop, and your iPhone acts as the display. Both sides stay in perfect sync over a persistent WebSocket connection, with sub-100ms latency anywhere in the world.

---

## 🏗️ Architecture

The magic is powered by two Cloudflare primitives:

```
┌─────────────────────┐        WebSocket (WSS)       ┌──────────────────────┐
│   Master (Laptop)   │ ◄──────────────────────────► │  Cloudflare Worker   │
│   index.html        │                               │  + Durable Object    │
└─────────────────────┘                               │  (TeleprompterSession│
                                                      └──────────┬───────────┘
┌─────────────────────┐        WebSocket (WSS)                   │
│   Slave (iPhone)    │ ◄─────────────────────────────────────── ┘
│   slave.html        │
└─────────────────────┘
```

- **[Cloudflare Workers](https://workers.cloudflare.com/)** — serves the static UI and handles WebSocket upgrades at the edge, globally.
- **[Durable Objects](https://developers.cloudflare.com/durable-objects/)** — a single `TeleprompterSession` object holds the authoritative state (script, playback, speed, scroll position) and brokers messages between master and slave clients in real time.
- **Static Assets** — HTML, JS, and CSS are served directly from the Worker using the `ASSETS` binding — no separate CDN needed.

There is **no database**, **no server to manage**, and **no cold starts**. The Durable Object keeps the session alive as long as clients are connected.

---

## 🚀 Features

### Master (Laptop / Desktop)
- **Script editor** — paste or type your script with full Markdown support
- **Live preview** — rendered script mirrors exactly what the slave sees
- **Amber keyline overlay** — a live bounding box on the preview shows precisely which lines are currently visible on the iPhone's screen
- **Play / Pause / Reset** — one-click playback control
- **Variable speed** — smooth 5–300 px/s range with a live slider
- **Slave position tracking** — see exactly how far through the script the reader is (% progress)
- **Keyboard shortcuts** for hands-free control:

| Key | Action |
|---|---|
| `Space` (hold) | Push-to-pause — hold to pause, release to resume |
| `↑` / `↓` | Seek back / forward one line |
| `←` / `→` | Speed down / up |
| `R` | Reset to start |

### Slave (iPhone / iPad)
- **Auto-detected** — iPhones visiting `/` are automatically redirected to the slave view
- **Full-screen black display** — high-contrast white text on black, optimised for on-camera reading
- **Large, responsive text** — fluid font sizing from 1.5rem to 2.25rem based on screen width
- **Screen wake lock** — keeps the display on while prompting using the native Wake Lock API, with a NoSleep.js fallback for older iOS versions
- **Smooth scrolling engine** — float-precision scroll accumulator avoids the sub-pixel stalling that plagues iOS Safari at slow speeds
- **Fullscreen mode** — one-tap fullscreen, with an "Add to Home Screen" tip for true full-screen on iOS Safari
- **Auto-reconnect** — if the connection drops, the slave reconnects silently and picks up where it left off

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
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

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

That's it. Wrangler will print your Worker URL (e.g. `https://teleprompter.yourname.workers.dev`).

---

## 🎬 Using It

1. **Open the Worker URL on your laptop** — this is the Master view
2. **Open the same URL on your iPhone** — it auto-redirects to the Slave view, or tap "Open Slave ↗" from the master
3. On the iPhone, tap **Begin Prompting** (this triggers the wake lock and WebSocket connection)
4. On the laptop, paste your script and click **Load Script →**
5. Hit **▶ Play** and start reading

---

## 🗂️ Project Structure

```
teleprompter/
├── src/
│   └── worker.js          # Cloudflare Worker + Durable Object
├── public/
│   ├── index.html         # Master UI
│   ├── master.js          # Master page logic
│   ├── slave.html         # Slave UI (iPhone display)
│   ├── slave.js           # Slave page logic + scroll engine
│   ├── md.js              # Lightweight Markdown parser
│   └── nosleep.js         # Wake lock fallback (NoSleep.js)
└── wrangler.toml          # Cloudflare deployment config
```

---

## 📄 License

MIT — do whatever you like with it.
