/**
 * worker.js — Cloudflare Worker entry point + Durable Object.
 *
 * Architecture overview:
 *   The Worker handles HTTP routing and WebSocket upgrades at the edge.
 *   All shared real-time state (script, playback, scroll position) lives
 *   inside a single TeleprompterSession Durable Object, which brokers
 *   messages between every connected controller and display in real time.
 *
 * WebSocket roles:
 *   controller  (/ws?role=controller)  — laptop/desktop master control UI
 *   display     (/ws?role=display)     — phone/tablet teleprompter display
 *
 * ── Message protocol ─────────────────────────────────────────────────────────
 *
 * controller → server:
 *   { type: 'setScript',  text: string }
 *   { type: 'play' }
 *   { type: 'pause' }
 *   { type: 'reset' }
 *   { type: 'setSpeed',   speed: number }              // px/sec, clamped 5–300
 *   { type: 'seek',       ratio: number }               // 0–1 fraction of scroll height
 *   { type: 'command',    action: 'seekDelta', lines: number }
 *   { type: 'ping' }                                    // heartbeat — server replies with pong
 *
 * display → server:
 *   { type: 'scrollUpdate', scrollTop, scrollHeight, clientHeight,
 *                           clientWidth, lineHeight, fontSize }
 *   { type: 'ping' }
 *
 * server → controller:
 *   { type: 'init',                state: TeleprompterState }
 *   { type: 'displayConnected' }
 *   { type: 'displayDisconnected' }
 *   { type: 'displayPosition',     scrollTop, scrollHeight, clientHeight,
 *                                  clientWidth, lineHeight, fontSize }
 *   { type: 'pong' }
 *
 * server → display:
 *   { type: 'init',         state: TeleprompterState }
 *   { type: 'scriptUpdate', text: string }
 *   { type: 'command',      action: 'play' | 'pause' | 'reset' | 'setSpeed' | 'seek' | 'seekDelta', ... }
 *   { type: 'pong' }
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket upgrade → route to the Durable Object
    if (request.headers.get('Upgrade') === 'websocket') {
      const id  = env.TELEPROMPTER_SESSION.idFromName('global');
      const obj = env.TELEPROMPTER_SESSION.get(id);
      return obj.fetch(request);
    }

    // Mobile UA detection: redirect phones/tablets visiting root to the display view.
    // Covers Android (Mobi/Android) and iOS (iPhone/iPad/iPod).
    if (url.pathname === '/') {
      const ua = request.headers.get('User-Agent') || '';
      if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
        return Response.redirect(new URL('/display', request.url).toString(), 302);
      }
    }

    // Backward-compat: redirect the old /slave URL to /display
    if (url.pathname === '/slave') {
      return Response.redirect(new URL('/display', request.url).toString(), 302);
    }

    // Clean URL routing: /display → /display.html
    if (url.pathname === '/display') {
      const rewritten = new URL(request.url);
      rewritten.pathname = '/display.html';
      return env.ASSETS.fetch(new Request(rewritten.toString(), request));
    }

    // All other requests → serve static assets from ./public
    return env.ASSETS.fetch(request);
  },
};

// ─── Durable Object ──────────────────────────────────────────────────────────

/**
 * TeleprompterSession holds the authoritative teleprompter state and brokers
 * real-time messages between all connected controller and display clients.
 *
 * A single named instance ('global') is used, meaning all visitors share one
 * session. For multi-room support, generate unique idFromName() keys per room
 * and pass the room ID through the URL.
 */
export class TeleprompterSession {
  constructor(state, env) {
    this.state = state;
    this.env   = env;

    /** @type {Map<string, { ws: WebSocket, role: 'controller' | 'display' }>} */
    this.sessions = new Map();

    /** Authoritative state — sent to every client on connect via an 'init' message. */
    this.teleprompterState = {
      script:           '',
      playing:          false,
      speed:            60,     // px/sec scroll speed on the display
      displayConnected: false,  // true when at least one display is connected
      displayScroll: {          // last reported scroll position from the display
        scrollTop:    0,
        scrollHeight: 0,
        clientHeight: 0,
        clientWidth:  0,
        lineHeight:   56,       // computed CSS line-height in px
        fontSize:     32,       // computed CSS font-size in px
      },
    };
  }

  async fetch(request) {
    const { 0: clientWs, 1: serverWs } = new WebSocketPair();
    serverWs.accept();

    const url       = new URL(request.url);
    const role      = url.searchParams.get('role') || 'display'; // 'controller' | 'display'
    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, { ws: serverWs, role });

    // Notify existing controllers when a display connects
    if (role === 'display') {
      this.teleprompterState.displayConnected = true;
      this.broadcast({ type: 'displayConnected' }, 'controller');
    }

    serverWs.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.handleMessage(sessionId, role, msg, serverWs);
    });

    serverWs.addEventListener('close', () => {
      this.sessions.delete(sessionId);

      // Notify controllers when the last display disconnects
      if (role === 'display') {
        const stillHasDisplay = [...this.sessions.values()].some(s => s.role === 'display');
        if (!stillHasDisplay) {
          this.teleprompterState.displayConnected = false;
          this.broadcast({ type: 'displayDisconnected' }, 'controller');
        }
      }
    });

    serverWs.addEventListener('error', () => {
      this.sessions.delete(sessionId);
    });

    // Send current state to the newly connected client
    this.send(serverWs, { type: 'init', state: this.teleprompterState });

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  /** Route an incoming message from a client to the appropriate handler. */
  handleMessage(sessionId, role, msg, ws) {
    // Handle heartbeat ping from any client — reply with pong immediately
    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }

    const s = this.teleprompterState;

    if (role === 'controller') {
      switch (msg.type) {
        case 'setScript':
          s.script = msg.text ?? '';
          this.broadcast({ type: 'scriptUpdate', text: s.script }, 'display');
          break;

        case 'play':
          s.playing = true;
          this.broadcast({ type: 'command', action: 'play', speed: s.speed }, 'display');
          break;

        case 'pause':
          s.playing = false;
          this.broadcast({ type: 'command', action: 'pause' }, 'display');
          break;

        case 'setSpeed':
          s.speed = Math.max(5, Math.min(300, msg.speed ?? 60));
          // Only push speed changes to the display while it is actively scrolling
          if (s.playing) {
            this.broadcast({ type: 'command', action: 'setSpeed', speed: s.speed }, 'display');
          }
          break;

        case 'reset':
          s.playing = false;
          this.broadcast({ type: 'command', action: 'reset' }, 'display');
          break;

        case 'seek':
          // msg.ratio: 0–1 fraction of total scroll height
          this.broadcast({ type: 'command', action: 'seek', ratio: msg.ratio }, 'display');
          break;

        case 'command':
          // Pass-through for commands that have no dedicated handler above (e.g. seekDelta)
          if (msg.action === 'seekDelta') {
            this.broadcast({ type: 'command', action: 'seekDelta', lines: msg.lines ?? 1 }, 'display');
          }
          break;
      }
    }

    if (role === 'display') {
      switch (msg.type) {
        case 'scrollUpdate':
          // Persist and forward scroll state to all controllers
          s.displayScroll = {
            scrollTop:    msg.scrollTop,
            scrollHeight: msg.scrollHeight,
            clientHeight: msg.clientHeight,
            clientWidth:  msg.clientWidth,
            lineHeight:   msg.lineHeight,
            fontSize:     msg.fontSize,
          };
          this.broadcast({
            type:         'displayPosition',
            scrollTop:    msg.scrollTop,
            scrollHeight: msg.scrollHeight,
            clientHeight: msg.clientHeight,
            clientWidth:  msg.clientWidth,
            lineHeight:   msg.lineHeight,
            fontSize:     msg.fontSize,
          }, 'controller');
          break;
      }
    }
  }

  /**
   * Send a message to all sessions matching a given role.
   * Omit `role` to broadcast to every connected client.
   * @param {object} msg              — plain object (JSON-serialised before sending)
   * @param {'controller'|'display'} [role]
   */
  broadcast(msg, role) {
    const json = JSON.stringify(msg);
    for (const [, session] of this.sessions) {
      if (!role || session.role === role) {
        try { session.ws.send(json); } catch { /* session may have already closed */ }
      }
    }
  }

  /** Send a message to a single WebSocket. */
  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket may have already closed */ }
  }
}
