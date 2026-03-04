// ─── Cloudflare Worker Entry Point ───────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket upgrade → route to Durable Object
    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.TELEPROMPTER_SESSION.idFromName('global');
      const obj = env.TELEPROMPTER_SESSION.get(id);
      return obj.fetch(request);
    }

    // UA detection: iPhone/iPad on root → redirect to /slave
    if (url.pathname === '/') {
      const ua = request.headers.get('User-Agent') || '';
      if (/iPhone|iPad|iPod/.test(ua)) {
        return Response.redirect(new URL('/slave', request.url).toString(), 302);
      }
    }

    // Clean URL routing: /slave → /slave.html
    if (url.pathname === '/slave') {
      const rewritten = new URL(request.url);
      rewritten.pathname = '/slave.html';
      return env.ASSETS.fetch(new Request(rewritten.toString(), request));
    }

    // All other requests → serve static assets
    return env.ASSETS.fetch(request);
  },
};

// ─── Durable Object ──────────────────────────────────────────────────────────

export class TeleprompterSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // id → { ws, role }
    this.teleprompterState = {
      script: '',
      playing: false,
      speed: 60,       // px/sec on slave
      slaveScroll: {
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        clientWidth: 0,
      },
    };
  }

  async fetch(request) {
    const { 0: clientWs, 1: serverWs } = new WebSocketPair();
    serverWs.accept();

    const url = new URL(request.url);
    const role = url.searchParams.get('role') || 'slave'; // 'master' | 'slave'
    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, { ws: serverWs, role });

    serverWs.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.handleMessage(sessionId, role, msg);
    });

    serverWs.addEventListener('close', () => {
      this.sessions.delete(sessionId);
    });

    serverWs.addEventListener('error', () => {
      this.sessions.delete(sessionId);
    });

    // Send current state to newly connected client
    this.send(serverWs, { type: 'init', state: this.teleprompterState });

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  handleMessage(sessionId, role, msg) {
    const s = this.teleprompterState;

    if (role === 'master') {
      switch (msg.type) {
        case 'setScript':
          s.script = msg.text ?? '';
          this.broadcast({ type: 'scriptUpdate', text: s.script }, 'slave');
          break;

        case 'play':
          s.playing = true;
          this.broadcast({ type: 'command', action: 'play', speed: s.speed }, 'slave');
          break;

        case 'pause':
          s.playing = false;
          this.broadcast({ type: 'command', action: 'pause' }, 'slave');
          break;

        case 'setSpeed':
          s.speed = Math.max(5, Math.min(300, msg.speed ?? 60));
          if (s.playing) {
            this.broadcast({ type: 'command', action: 'setSpeed', speed: s.speed }, 'slave');
          }
          break;

        case 'reset':
          s.playing = false;
          this.broadcast({ type: 'command', action: 'reset' }, 'slave');
          break;

        case 'seek':
          // msg.ratio: 0–1 fraction of total scroll height
          this.broadcast({ type: 'command', action: 'seek', ratio: msg.ratio }, 'slave');
          break;

        case 'command':
          // Pass-through commands not individually handled above (e.g. seekDelta)
          if (msg.action === 'seekDelta') {
            this.broadcast({ type: 'command', action: 'seekDelta', lines: msg.lines ?? 1 }, 'slave');
          }
          break;
      }
    }

    if (role === 'slave') {
      switch (msg.type) {
        case 'scrollUpdate':
          s.slaveScroll = {
            scrollTop: msg.scrollTop,
            scrollHeight: msg.scrollHeight,
            clientHeight: msg.clientHeight,
            clientWidth: msg.clientWidth,
          };
          // Forward to all masters
          this.broadcast({
            type: 'slavePosition',
            scrollTop: msg.scrollTop,
            scrollHeight: msg.scrollHeight,
            clientHeight: msg.clientHeight,
            clientWidth: msg.clientWidth,
          }, 'master');
          break;
      }
    }
  }

  // Send to all sessions matching a role (or all if role is omitted)
  broadcast(msg, role) {
    const json = JSON.stringify(msg);
    for (const [, session] of this.sessions) {
      if (!role || session.role === role) {
        try { session.ws.send(json); } catch {}
      }
    }
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}
