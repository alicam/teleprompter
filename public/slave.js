// ─── Slave Page Logic ─────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const startOverlay   = document.getElementById('start-overlay');
  const startBtn       = document.getElementById('start-btn');
  const waitingMsg     = document.getElementById('waiting-msg');
  const scrollEl       = document.getElementById('scroll-container');
  const scriptText     = document.getElementById('script-text');
  const wakeDot        = document.getElementById('wake-dot');
  const wakeLabel      = document.getElementById('wake-label');
  const fullscreenBtn  = document.getElementById('fullscreen-btn');
  const fullscreenTip  = document.getElementById('fullscreen-tip');

  // ── Wake Lock ─────────────────────────────────────────────────────────────
  let wakeLock = null;
  const noSleep = new NoSleep();

  async function acquireWakeLock() {
    // Try native Screen Wake Lock API first (iOS 16.4+, Safari 16.4+)
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        setWakeStatus(true, 'Screen awake');

        wakeLock.addEventListener('release', () => {
          setWakeStatus(false, 'Lock released');
          // Auto re-acquire when page becomes visible again
        });

        return;
      } catch (err) {
        console.warn('[WakeLock] Native request failed, falling back to NoSleep.js:', err.message);
      }
    }

    // Fallback: NoSleep.js hidden video loop
    noSleep.enable();
    setWakeStatus(true, 'Screen awake (fallback)');
  }

  async function reacquireWakeLock() {
    if (wakeLock !== null) return; // still active
    await acquireWakeLock();
  }

  function setWakeStatus(active, label) {
    wakeDot.className = active ? 'active' : '';
    wakeLabel.textContent = label;
  }

  // Re-acquire on visibility change (e.g. user switches app and back)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && started) {
      await reacquireWakeLock();
    }
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────
  let ws = null;
  let reconnectTimer = null;
  let started = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}/ws?role=slave`;

    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      clearTimeout(reconnectTimer);
      waitingMsg.style.display = 'block';
    });

    ws.addEventListener('close', () => {
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // will trigger close
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

  // ── Scroll engine ─────────────────────────────────────────────────────────
  let playing    = false;
  let speed      = 60;     // px/sec
  let rafId      = null;
  let lastTime   = null;

  // Float accumulator — avoids sub-pixel loss when reading back scrollEl.scrollTop
  // (iOS Safari may return integer-rounded values, causing speeds < ~60px/s to stall)
  let scrollPos  = 0;

  function startScroll() {
    scrollPos = scrollEl.scrollTop; // sync accumulator from current DOM position
    playing = true;
    lastTime = performance.now();
    if (!rafId) rafId = requestAnimationFrame(scrollStep);
  }

  function stopScroll() {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function scrollStep(now) {
    if (!playing) { rafId = null; return; }

    const dt = (now - lastTime) / 1000; // seconds
    lastTime = now;

    scrollPos += speed * dt;
    scrollEl.scrollTop = scrollPos; // assign float directly — no integer read-back

    // Report position to master
    emitScrollUpdate();

    // Stop at end
    if (scrollPos >= scrollEl.scrollHeight - scrollEl.clientHeight) {
      stopScroll();
      emitScrollUpdate();
    } else {
      rafId = requestAnimationFrame(scrollStep);
    }
  }

  // Throttle scroll updates — send at most every 100ms
  let lastEmit = 0;
  function emitScrollUpdate() {
    const now = Date.now();
    if (now - lastEmit < 100) return;
    lastEmit = now;
    send({
      type:         'scrollUpdate',
      scrollTop:    scrollEl.scrollTop,
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      clientWidth:  scrollEl.clientWidth,
    });
  }

  // Also emit on manual touch-scroll (and keep accumulator in sync)
  scrollEl.addEventListener('scroll', () => {
    if (!playing) {
      scrollPos = scrollEl.scrollTop;
      emitScrollUpdate();
    }
  }, { passive: true });

  // ── Message handler ───────────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {

      case 'init': {
        // On (re)connect, server sends current state
        if (msg.state.script) {
          renderScript(msg.state.script);
          // Hide overlay if script already loaded (reconnect scenario)
          if (started) dismissOverlay();
        }
        speed = msg.state.speed ?? 60;
        if (msg.state.playing && started) {
          startScroll();
        }
        break;
      }

      case 'scriptUpdate': {
        renderScript(msg.text);
        // If we're already past the overlay, we're live — show it immediately
        if (started) dismissOverlay();
        else waitingMsg.style.display = 'block';
        break;
      }

      case 'command': {
        switch (msg.action) {
          case 'play':
            speed = msg.speed ?? speed;
            startScroll();
            break;
          case 'pause':
            stopScroll();
            emitScrollUpdate();
            break;
          case 'setSpeed':
            speed = msg.speed ?? speed;
            break;
          case 'reset':
            stopScroll();
            scrollPos = 0;
            scrollEl.scrollTop = 0;
            emitScrollUpdate();
            break;
          case 'seek':
            // ratio: 0–1
            if (msg.ratio !== undefined) {
              scrollPos = msg.ratio * scrollEl.scrollHeight;
              scrollEl.scrollTop = scrollPos;
              emitScrollUpdate();
            }
            break;

          case 'seekDelta': {
            // lines: integer, ±N lines to seek (1 line = rendered line-height of script text)
            const lineHeight = parseFloat(getComputedStyle(scriptText).lineHeight) || 56;
            scrollPos = Math.max(0, scrollPos + (msg.lines ?? 1) * lineHeight);
            scrollEl.scrollTop = scrollPos;
            emitScrollUpdate();
            break;
          }
        }
        break;
      }
    }
  }

  // ── Script rendering ──────────────────────────────────────────────────────
  let currentScript = '';

  function renderScript(text) {
    if (!text || !text.trim()) return;
    currentScript = text;
    // Render markdown (md.js handles HTML escaping before parsing)
    scriptText.innerHTML = parseMarkdown(text);
  }

  // ── Overlay ───────────────────────────────────────────────────────────────
  function dismissOverlay() {
    startOverlay.style.transition = 'opacity 0.4s ease';
    startOverlay.style.opacity = '0';
    setTimeout(() => { startOverlay.style.display = 'none'; }, 400);
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────

  // Hide the fullscreen button if already in standalone (PWA) mode
  if (navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches) {
    fullscreenBtn.style.display = 'none';
  }

  fullscreenBtn.addEventListener('click', () => {
    const el = document.documentElement;

    // Try standard Fullscreen API (works in Chrome/Android; limited on iOS Safari)
    const requestFn = el.requestFullscreen
      || el.webkitRequestFullscreen
      || el.mozRequestFullScreen
      || el.msRequestFullscreen;

    if (requestFn) {
      requestFn.call(el).then(() => {
        fullscreenBtn.style.display = 'none';
        fullscreenTip.style.display = 'none';
      }).catch(() => {
        // Fullscreen denied — show Add to Home Screen tip
        fullscreenTip.style.display = 'block';
        fullscreenBtn.style.display = 'none';
      });
    } else {
      // Not available (iOS Safari in-browser) — show Add to Home Screen instructions
      fullscreenTip.style.display = 'block';
      fullscreenBtn.style.display = 'none';
    }
  });

  // Exit fullscreen button reappears if user exits fullscreen
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      fullscreenBtn.style.display = 'flex';
    }
  });

  // ── Start button ──────────────────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    started = true;
    startBtn.textContent = 'Connecting…';
    startBtn.disabled = true;

    // Acquire wake lock (requires user gesture — this click satisfies it)
    await acquireWakeLock();

    // Connect WebSocket
    connect();

    // Small delay to show "Connecting" feedback, then check if we have script
    setTimeout(() => {
      if (currentScript.trim()) {
        dismissOverlay();
      } else {
        startBtn.textContent = 'Waiting for script…';
        waitingMsg.style.display = 'block';
      }
    }, 600);
  });

})();
