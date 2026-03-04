// ─── Controller Page Logic ────────────────────────────────────────────────────
//
// This script runs on the laptop/desktop controller UI (index.html).
// It connects to the server as the 'controller' role, manages script loading,
// playback commands, and renders a live preview of the display device's viewport.
//
// Key responsibilities:
//   - Establish and maintain a WebSocket connection with auto-reconnect and
//     a heartbeat to detect dead ("zombie") connections early
//   - Send playback commands (play, pause, reset, speed, seek) to the server
//   - Render the Markdown script in a live preview panel
//   - Draw the amber keyline overlay, sized to match the lines currently visible
//     on the display, using font metrics reported by the display itself

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const scriptInput   = document.getElementById('script-input');
  const loadBtn       = document.getElementById('load-btn');
  const playBtn       = document.getElementById('play-btn');
  const pauseBtn      = document.getElementById('pause-btn');
  const resetBtn      = document.getElementById('reset-btn');
  const speedSlider   = document.getElementById('speed-slider');
  const speedLabel    = document.getElementById('speed-label');
  const connDot       = document.getElementById('conn-dot');
  const connLabel     = document.getElementById('conn-label');
  const displayDot    = document.getElementById('display-dot');
  const displayStatus = document.getElementById('display-status');
  const displayProgress = document.getElementById('display-progress');
  const preview       = document.getElementById('script-preview');
  const keyline       = document.getElementById('keyline');
  const previewScroll = document.getElementById('preview-scroll');

  // ── State ─────────────────────────────────────────────────────────────────
  let ws             = null;
  let reconnectTimer = null;
  let isPlaying      = false;   // tracks actual playback state (not inferred from DOM)
  let currentScript  = '';

  // Last known display scroll position and font metrics
  let displayPos = { scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0, lineHeight: 56, fontSize: 32 };

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  //
  // Detects "zombie" connections — where the socket's readyState still reads
  // OPEN but the underlying TCP connection is dead (e.g. laptop sleep, network
  // timeout, Cloudflare edge recycling the Durable Object).
  //
  // Without this, send() silently discards messages, buttons appear to do
  // nothing, and the controller never recovers until the page is refreshed.
  //
  // How it works:
  //   1. Every PING_INTERVAL ms, we send a { type: 'ping' } message.
  //   2. The server replies immediately with { type: 'pong' }.
  //   3. If no pong arrives within PING_TIMEOUT ms, we force-close the socket
  //      and the normal reconnect logic takes over.
  const PING_INTERVAL = 10_000; // 10 s between pings
  const PING_TIMEOUT  =  5_000; // 5 s to wait for pong before declaring dead

  let pingTimer = null;
  let pongTimer = null;

  function startHeartbeat() {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      send({ type: 'ping' });
      pongTimer = setTimeout(() => {
        console.warn('[WS] Pong timeout — forcing reconnect');
        ws.close();
      }, PING_TIMEOUT);
    }, PING_INTERVAL);
  }

  function stopHeartbeat() {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?role=controller`);

    ws.addEventListener('open', () => {
      setConnStatus('connected');
      clearTimeout(reconnectTimer);
      setControlsDisabled(false);
      startHeartbeat();
    });

    ws.addEventListener('close', () => {
      setConnStatus('disconnected');
      setControlsDisabled(true);
      stopHeartbeat();
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // A 'close' event always follows an 'error'.
      // We handle reconnection there, but also set status here for immediacy.
      setConnStatus('disconnected');
      setControlsDisabled(true);
      stopHeartbeat();
      scheduleReconnect();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ── Message handler ───────────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {

      case 'init':
        // Server sends current state on connect (or reconnect)
        if (msg.state.script) {
          currentScript = msg.state.script;
          scriptInput.value = currentScript;
          renderPreview(currentScript);
        }
        speedSlider.value = msg.state.speed;
        speedLabel.textContent = `${msg.state.speed} px/s`;
        // Restore display indicator if a display was already connected
        if (msg.state.displayConnected) updateDisplayIndicator(true);
        break;

      case 'pong':
        // Heartbeat reply — cancel the pong timeout so we don't force-reconnect
        clearTimeout(pongTimer);
        break;

      case 'displayPosition':
        updateDisplayStatus(msg);
        updateKeyline(msg);
        break;

      case 'displayConnected':
        updateDisplayIndicator(true);
        break;

      case 'displayDisconnected':
        updateDisplayIndicator(false);
        break;
    }
  }

  // ── Display status indicator ──────────────────────────────────────────────
  function updateDisplayIndicator(connected) {
    if (connected) {
      displayDot.className    = 'w-2 h-2 rounded-full bg-emerald-400 shrink-0';
      displayStatus.textContent = 'Display connected';
    } else {
      displayDot.className    = 'w-2 h-2 rounded-full bg-zinc-600 shrink-0';
      displayStatus.textContent = 'No display connected';
      displayProgress.classList.add('hidden');
      keyline.style.display = 'none';
      // Reset preview text to its default centred layout
      preview.style.maxWidth    = '';
      preview.style.marginLeft  = '';
      preview.style.marginRight = '';
    }
  }

  function updateDisplayStatus(pos) {
    displayPos = pos;
    updateDisplayIndicator(true);

    if (pos.scrollHeight > 0) {
      const pct = Math.round(((pos.scrollTop + pos.clientHeight / 2) / pos.scrollHeight) * 100);
      displayProgress.textContent = `Position: ${pct}% through script`;
      displayProgress.classList.remove('hidden');
    }
  }

  // ── Keyline overlay ───────────────────────────────────────────────────────
  //
  // The amber keyline box represents the viewport currently visible on the
  // display device. It is sized and positioned to match the lines shown on
  // screen as accurately as possible, using font metrics reported by the display
  // (lineHeight, fontSize) rather than hard-coded device-specific values.
  function updateKeyline(pos) {
    if (!pos.scrollHeight || !currentScript) {
      keyline.style.display = 'none';
      return;
    }

    const panelHeight = previewScroll.clientHeight;
    const panelWidth  = previewScroll.clientWidth;

    // ── 1. How many text lines fit in the display's viewport? ──────────────
    // The display reports its computed CSS line-height in px, so we can
    // calculate the visible line count directly without guessing font sizes.
    const displayLineHeight  = pos.lineHeight || 56;
    const linesVisible       = pos.clientHeight / displayLineHeight;

    // ── 2. Map those lines to the controller's text scale ──────────────────
    // The controller preview uses 16px base font / 1.75 line-height = 28px per line
    const controllerLineHeight = 16 * 1.75;
    const keylineHeight        = linesVisible * controllerLineHeight;

    // ── 3. Text column width — display uses max-width:700px with 2rem padding ──
    // The display reports its font-size so we can derive the correct scale ratio
    const displayFontPx  = pos.fontSize || 32;
    const displayTextCol = pos.clientWidth ? Math.min(pos.clientWidth - 64, 700) : 260;
    const scaleRatio     = 16 / displayFontPx;
    const textWidth      = displayTextCol * scaleRatio;

    // ── 4. Keyline box = text column + scaled side padding ─────────────────
    const textPad      = Math.round(32 * scaleRatio); // 2rem = 32px, scaled to controller
    const keylineWidth = Math.min(panelWidth - 32, textWidth + 2 * textPad);
    const keylineLeft  = (panelWidth - keylineWidth) / 2;

    keyline.style.display = 'block';
    keyline.style.height  = `${keylineHeight}px`;
    keyline.style.width   = `${keylineWidth}px`;
    keyline.style.left    = `${keylineLeft}px`;
    keyline.style.right   = 'auto';

    // Constrain preview text to the same width as the display's text column
    preview.style.maxWidth    = `${textWidth}px`;
    preview.style.marginLeft  = `${keylineLeft + textPad}px`;
    preview.style.marginRight = `${keylineLeft + textPad}px`;

    // Apply 50vh-equivalent top/bottom padding so the first line sits at the
    // keyline centre — matching the display's `padding: 50vh` behaviour
    applyPreviewPadding();

    // ── 5. Scroll the preview to mirror the display's current position ──────
    const displayScrollRange    = pos.scrollHeight - pos.clientHeight;
    const controllerScrollRange = preview.scrollHeight - panelHeight;
    const textProgress = displayScrollRange > 0
      ? Math.min(1, Math.max(0, pos.scrollTop / displayScrollRange))
      : 0;
    previewScroll.scrollTop = textProgress * Math.max(0, controllerScrollRange);
  }

  // ── Script preview ────────────────────────────────────────────────────────
  function renderPreview(text) {
    if (!text.trim()) {
      preview.innerHTML = '<p class="text-zinc-600 italic">Load a script to see the preview…</p>';
      preview.style.paddingTop    = '';
      preview.style.paddingBottom = '';
      keyline.style.display = 'none';
      return;
    }

    // parseMarkdown() is provided by md.js (loaded before this script)
    preview.innerHTML = parseMarkdown(text);

    applyPreviewPadding();

    // Re-apply keyline position if a display is already connected
    if (displayPos.scrollHeight) updateKeyline(displayPos);
  }

  function applyPreviewPadding() {
    // Half-panel padding mirrors the display's `padding: 50vh` —
    // at scrollTop=0 the first line sits at the keyline centre.
    const pad = previewScroll.clientHeight / 2;
    preview.style.paddingTop    = `${pad}px`;
    preview.style.paddingBottom = `${pad}px`;
  }

  // Re-apply padding and keyline on window resize (panel dimensions may change)
  window.addEventListener('resize', () => {
    if (currentScript && displayPos.scrollHeight) updateKeyline(displayPos);
  });

  // ── Connection status UI ──────────────────────────────────────────────────
  function setConnStatus(status) {
    if (status === 'connected') {
      connDot.className     = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
      connLabel.textContent = 'Connected';
    } else if (status === 'disconnected') {
      connDot.className     = 'w-1.5 h-1.5 rounded-full bg-red-400';
      connLabel.textContent = 'Reconnecting…';
    } else {
      connDot.className     = 'w-1.5 h-1.5 rounded-full bg-zinc-500';
      connLabel.textContent = 'Connecting…';
    }
  }

  // ── Controls enabled / disabled ───────────────────────────────────────────
  // Playback controls are disabled while disconnected so that clicks don't
  // silently vanish into a dead socket. They are re-enabled on reconnect.
  function setControlsDisabled(disabled) {
    [loadBtn, playBtn, pauseBtn, resetBtn, speedSlider].forEach((el) => {
      el.disabled           = disabled;
      el.style.opacity      = disabled ? '0.4' : '';
      el.style.pointerEvents = disabled ? 'none' : '';
    });
  }

  // ── Button handlers ───────────────────────────────────────────────────────
  loadBtn.addEventListener('click', () => {
    const text = scriptInput.value.trim();
    if (!text) return;
    currentScript = text;
    renderPreview(text);
    send({ type: 'setScript', text });
  });

  playBtn.addEventListener('click', () => {
    isPlaying = true;
    send({ type: 'play' });
    playBtn.classList.add('ring-2', 'ring-emerald-400');
    pauseBtn.classList.remove('ring-2', 'ring-amber-400');
  });

  pauseBtn.addEventListener('click', () => {
    isPlaying = false;
    send({ type: 'pause' });
    pauseBtn.classList.add('ring-2', 'ring-amber-400');
    playBtn.classList.remove('ring-2', 'ring-emerald-400');
  });

  resetBtn.addEventListener('click', () => {
    isPlaying = false;
    send({ type: 'reset' });
    playBtn.classList.remove('ring-2', 'ring-emerald-400');
    pauseBtn.classList.remove('ring-2', 'ring-amber-400');
  });

  speedSlider.addEventListener('input', () => {
    const speed = parseInt(speedSlider.value, 10);
    speedLabel.textContent = `${speed} px/s`;
    send({ type: 'setSpeed', speed });
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  //
  //   Space  — push-to-pause: hold to pause, release to resume (like Zoom mute)
  //   ↑ / ↓  — seek back / forward one line on the display
  //   ← / →  — speed down / up
  //   R      — reset to start
  let spaceWasPlaying = false;

  document.addEventListener('keydown', (e) => {
    // Don't intercept keys while the user is typing in the script textarea
    if (e.target === scriptInput) return;

    switch (e.code) {
      case 'Space':
        if (e.repeat) break;
        e.preventDefault();
        // Use the isPlaying boolean — not a DOM class inspection
        spaceWasPlaying = isPlaying;
        if (spaceWasPlaying) pauseBtn.click();
        break;

      case 'ArrowUp':
        e.preventDefault();
        send({ type: 'command', action: 'seekDelta', lines: -1 });
        break;

      case 'ArrowDown':
        e.preventDefault();
        send({ type: 'command', action: 'seekDelta', lines: 1 });
        break;

      case 'ArrowLeft':
        e.preventDefault();
        speedSlider.value = Math.max(5, parseInt(speedSlider.value) - 5);
        speedSlider.dispatchEvent(new Event('input'));
        break;

      case 'ArrowRight':
        e.preventDefault();
        speedSlider.value = Math.min(300, parseInt(speedSlider.value) + 5);
        speedSlider.dispatchEvent(new Event('input'));
        break;

      case 'KeyR':
        if (!e.metaKey && !e.ctrlKey) resetBtn.click();
        break;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.target === scriptInput) return;
    if (e.code === 'Space' && spaceWasPlaying) {
      e.preventDefault();
      playBtn.click();
      spaceWasPlaying = false;
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  setControlsDisabled(true); // disabled until the WebSocket connects
  connect();

})();
