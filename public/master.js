// ─── Master Page Logic ────────────────────────────────────────────────────────

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
  const slaveDot      = document.getElementById('slave-dot');
  const slaveStatus   = document.getElementById('slave-status');
  const slaveProgress = document.getElementById('slave-progress');
  const preview       = document.getElementById('script-preview');
  const keyline       = document.getElementById('keyline');
  const previewScroll = document.getElementById('preview-scroll');

  // ── State ─────────────────────────────────────────────────────────────────
  let ws = null;
  let reconnectTimer = null;
  let slaveConnected = false;
  let currentScript = '';

  // Last known slave position
  let slavePos = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}/ws?role=master`;

    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      setConnStatus('connected');
      clearTimeout(reconnectTimer);
    });

    ws.addEventListener('close', () => {
      setConnStatus('disconnected');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      setConnStatus('disconnected');
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
        // Server sends current state on connect
        if (msg.state.script) {
          currentScript = msg.state.script;
          scriptInput.value = currentScript;
          renderPreview(currentScript);
        }
        speedSlider.value = msg.state.speed;
        speedLabel.textContent = `${msg.state.speed} px/s`;
        break;

      case 'slavePosition':
        slaveConnected = true;
        updateSlaveStatus(msg);
        updateKeyline(msg);
        break;

      case 'slaveConnected':
        slaveConnected = true;
        updateSlaveIndicator(true);
        break;

      case 'slaveDisconnected':
        slaveConnected = false;
        updateSlaveIndicator(false);
        break;
    }
  }

  // ── Slave indicator ───────────────────────────────────────────────────────
  function updateSlaveIndicator(connected) {
    if (connected) {
      slaveDot.className = 'w-2 h-2 rounded-full bg-emerald-400 shrink-0';
      slaveStatus.textContent = 'Slave connected';
    } else {
      slaveDot.className = 'w-2 h-2 rounded-full bg-zinc-600 shrink-0';
      slaveStatus.textContent = 'No slave connected';
      slaveProgress.classList.add('hidden');
      keyline.style.display = 'none';
      // Reset text to default centred layout
      preview.style.maxWidth   = '';
      preview.style.marginLeft  = '';
      preview.style.marginRight = '';
    }
  }

  function updateSlaveStatus(pos) {
    slavePos = pos;
    updateSlaveIndicator(true);

    if (pos.scrollHeight > 0) {
      const pct = Math.round(((pos.scrollTop + pos.clientHeight / 2) / pos.scrollHeight) * 100);
      slaveProgress.textContent = `Position: ${pct}% through script`;
      slaveProgress.classList.remove('hidden');
    }
  }

  // ── Keyline overlay ───────────────────────────────────────────────────────
  function updateKeyline(pos) {
    if (!pos.scrollHeight || !currentScript) {
      keyline.style.display = 'none';
      return;
    }

    const panelHeight = previewScroll.clientHeight;
    const panelWidth  = previewScroll.clientWidth;

    // ── Size the keyline to match exactly the lines visible on the iPhone ──
    //
    // 1. Compute iPhone's rendered font (slave CSS: clamp(24px, 5vw, 36px))
    const slaveFontPx       = (pos.clientWidth)
      ? Math.max(24, Math.min(36, 0.05 * pos.clientWidth))
      : 24;
    // 2. Lines the iPhone viewport can show
    const linesVisible      = pos.clientHeight
      ? pos.clientHeight / (slaveFontPx * 1.8)
      : 10;
    // 3. Keyline height = those same lines at master scale (16px / line-height 1.75)
    const keylineHeight     = linesVisible * (16 * 1.75);
    // 4. Text column width — slave uses max-width:700px with padding:2rem each side
    const slaveTextCol = pos.clientWidth
      ? Math.min(pos.clientWidth - 64, 700)
      : 260;
    const textWidth = slaveTextCol * (16 / slaveFontPx);

    // 5. Keyline box = text column + slave's side padding (2rem = 32px) scaled to master
    const textPad      = Math.round(32 * (16 / slaveFontPx));
    const keylineWidth = Math.min(panelWidth - 32, textWidth + 2 * textPad);

    const keylineLeft = (panelWidth - keylineWidth) / 2;

    keyline.style.display = 'block';
    keyline.style.height  = `${keylineHeight}px`;
    keyline.style.width   = `${keylineWidth}px`;
    keyline.style.left    = `${keylineLeft}px`;
    keyline.style.right   = 'auto';

    // Text sits inside the keyline, inset by textPad on each side
    preview.style.maxWidth    = `${textWidth}px`;
    preview.style.marginLeft  = `${keylineLeft + textPad}px`;
    preview.style.marginRight = `${keylineLeft + textPad}px`;

    // Padding = half panel height so first/last line sits at keyline CENTRE,
    // exactly matching iPhone's `padding: 50vh` behaviour
    applyPreviewPadding();

    // Scroll to follow slave
    const slaveScrollableRange  = pos.scrollHeight - pos.clientHeight;
    const masterScrollableRange = preview.scrollHeight - panelHeight;
    const textProgress = slaveScrollableRange > 0
      ? Math.min(1, Math.max(0, pos.scrollTop / slaveScrollableRange))
      : 0;
    previewScroll.scrollTop = textProgress * Math.max(0, masterScrollableRange);
  }

  // ── Script preview ────────────────────────────────────────────────────────
  function renderPreview(text) {
    if (!text.trim()) {
      preview.innerHTML = '<p class="text-zinc-600 italic">Load a script to see the preview…</p>';
      preview.style.paddingTop = '';
      preview.style.paddingBottom = '';
      keyline.style.display = 'none';
      return;
    }

    // Render markdown (md.js handles HTML escaping before parsing)
    preview.innerHTML = parseMarkdown(text);

    // Centre text in panel
    applyPreviewPadding();

    // Re-apply keyline / auto-scroll if slave is already connected
    if (slavePos.scrollHeight) {
      updateKeyline(slavePos);
    }
  }

  function applyPreviewPadding() {
    // Half-panel padding mirrors slave's `padding: 50vh` —
    // at scrollTop=0 the first line sits at the keyline centre.
    const pad = previewScroll.clientHeight / 2;
    preview.style.paddingTop    = `${pad}px`;
    preview.style.paddingBottom = `${pad}px`;
  }

  // Re-apply padding on window resize (panel height may change)
  window.addEventListener('resize', () => {
    if (currentScript && slavePos.scrollHeight) updateKeyline(slavePos);
  });

  // ── Connection status UI ──────────────────────────────────────────────────
  function setConnStatus(status) {
    if (status === 'connected') {
      connDot.className   = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
      connLabel.textContent = 'Connected';
    } else if (status === 'disconnected') {
      connDot.className   = 'w-1.5 h-1.5 rounded-full bg-red-400';
      connLabel.textContent = 'Reconnecting…';
    } else {
      connDot.className   = 'w-1.5 h-1.5 rounded-full bg-zinc-500';
      connLabel.textContent = 'Connecting…';
    }
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
    send({ type: 'play' });
    playBtn.classList.add('ring-2', 'ring-emerald-400');
    pauseBtn.classList.remove('ring-2', 'ring-amber-400');
  });

  pauseBtn.addEventListener('click', () => {
    send({ type: 'pause' });
    pauseBtn.classList.add('ring-2', 'ring-amber-400');
    playBtn.classList.remove('ring-2', 'ring-emerald-400');
  });

  resetBtn.addEventListener('click', () => {
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
  // Space  : push-to-pause — hold to pause, release to resume (like Zoom mute)
  // ↑ / ↓  : seek back / forward one line on the slave
  // ← / →  : speed down / up
  // R      : reset
  let spaceWasPlaying = false;

  document.addEventListener('keydown', (e) => {
    if (e.target === scriptInput) return;

    switch (e.code) {
      case 'Space':
        if (e.repeat) break;
        e.preventDefault();
        spaceWasPlaying = playBtn.classList.contains('ring-2');
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
  connect();

})();
