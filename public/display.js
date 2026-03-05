// ─── Display Page Logic ───────────────────────────────────────────────────────
//
// This script runs on the teleprompter display device (phone or tablet).
// It connects to the server as the 'display' role, receives the script and
// playback commands from the controller, and drives the scroll animation.
//
// Key responsibilities:
//   - Establish and maintain a WebSocket connection (auto-reconnects on drop)
//   - Render incoming Markdown script and scroll it at the commanded speed
//   - Report scroll position and font metrics back to the controller in real time
//   - Acquire a screen wake lock so the display stays on during a session
//   - Handle fullscreen mode across iOS and Android

(function () {
  'use strict';

  // ── Session hash ──────────────────────────────────────────────────────────
  //
  // Read the session hash from the URL path: domain.com/{hash}/display
  // This ensures the display connects to its own isolated Durable Object
  // rather than a shared global session.
  const SESSION = location.pathname.split('/').filter(Boolean)[0] || 'global';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const startOverlay  = document.getElementById('start-overlay');
  const startBtn      = document.getElementById('start-btn');
  const waitingMsg    = document.getElementById('waiting-msg');
  const scrollEl      = document.getElementById('scroll-container');
  const scriptText    = document.getElementById('script-text');
  const wakeDot       = document.getElementById('wake-dot');
  const wakeLabel     = document.getElementById('wake-label');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const fullscreenTip = document.getElementById('fullscreen-tip');

  // ── Wake Lock ─────────────────────────────────────────────────────────────
  let wakeLock = null;
  const noSleep = new NoSleep(); // fallback for browsers without native Wake Lock API

  async function acquireWakeLock() {
    // Prefer the native Screen Wake Lock API (Chrome 84+, Safari 16.4+, Firefox 126+)
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        setWakeStatus(true, 'Screen awake');

        // The lock is released automatically when the page is hidden (e.g. app switch).
        // We clear our reference here and re-acquire when the page becomes visible again.
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
          setWakeStatus(false, 'Lock released');
        });

        return;
      } catch (err) {
        console.warn('[WakeLock] Native request failed, falling back to NoSleep.js:', err.message);
      }
    }

    // Fallback: NoSleep.js uses a silent looping video to prevent the screen sleeping.
    // Works on older iOS Safari and Android browsers that lack the Wake Lock API.
    noSleep.enable();
    setWakeStatus(true, 'Screen awake (fallback)');
  }

  async function reacquireWakeLock() {
    if (wakeLock !== null) return; // still active
    await acquireWakeLock();
  }

  function setWakeStatus(active, label) {
    wakeDot.className   = active ? 'active' : '';
    wakeLabel.textContent = label;
  }

  // Re-acquire the wake lock when the user returns to this tab/app
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && started) {
      await reacquireWakeLock();
    }
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────
  let ws             = null;
  let reconnectTimer = null;
  let started        = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/${SESSION}/ws?role=display`);

    ws.addEventListener('open', () => {
      clearTimeout(reconnectTimer);
      waitingMsg.style.display = 'block';
    });

    ws.addEventListener('close', () => scheduleReconnect());

    ws.addEventListener('error', () => {
      // A 'close' event always follows an 'error', so reconnection is handled there
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
  let playing  = false;
  let speed    = 60;    // px/sec — updated by 'setSpeed' and 'play' commands
  let rafId    = null;
  let lastTime = null;

  // Float scroll accumulator — avoids sub-pixel precision loss when reading
  // scrollEl.scrollTop back from the DOM. Some browsers (notably mobile Safari
  // and some Android WebViews) return integer-rounded values, causing slow
  // speeds (< ~60 px/s) to stall because each frame rounds back to the same
  // integer. Writing a float directly bypasses this read-back issue.
  let scrollPos = 0;

  function startScroll() {
    scrollPos = scrollEl.scrollTop; // sync accumulator from current DOM position
    playing   = true;
    lastTime  = performance.now();
    if (!rafId) rafId = requestAnimationFrame(scrollStep);
  }

  function stopScroll() {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function scrollStep(now) {
    if (!playing) { rafId = null; return; }

    const dt = (now - lastTime) / 1000; // elapsed seconds since last frame
    lastTime = now;

    scrollPos         += speed * dt;
    scrollEl.scrollTop = scrollPos; // assign float directly — avoids integer read-back

    emitScrollUpdate();

    // Stop automatically when the script reaches the bottom
    if (scrollPos >= scrollEl.scrollHeight - scrollEl.clientHeight) {
      stopScroll();
      emitScrollUpdate();
    } else {
      rafId = requestAnimationFrame(scrollStep);
    }
  }

  // ── Scroll reporting ──────────────────────────────────────────────────────
  // Throttle position reports — send at most one update every 100 ms
  let lastEmit = 0;

  function emitScrollUpdate() {
    const now = Date.now();
    if (now - lastEmit < 100) return;
    lastEmit = now;

    // Include computed font metrics so the controller can accurately size the
    // keyline overlay without hard-coding any device-specific CSS values.
    const style      = getComputedStyle(scriptText);
    const lineHeight = parseFloat(style.lineHeight) || 56;
    const fontSize   = parseFloat(style.fontSize)   || 32;

    send({
      type:         'scrollUpdate',
      scrollTop:    scrollEl.scrollTop,
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      clientWidth:  scrollEl.clientWidth,
      lineHeight,
      fontSize,
    });
  }

  // Keep the scroll accumulator in sync on manual touch-scroll (user drags to seek)
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
        // Server sends current state on (re)connect — restore script and playback
        if (msg.state.script) {
          renderScript(msg.state.script);
          if (started) dismissOverlay();
        }
        speed = msg.state.speed ?? 60;
        if (msg.state.playing && started) startScroll();
        break;
      }

      case 'scriptUpdate': {
        renderScript(msg.text);
        if (started) dismissOverlay();
        else waitingMsg.style.display = 'block';
        break;
      }

      case 'pong':
        // Heartbeat reply from server — no action needed on the display side
        break;

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
            // ratio: 0–1 fraction of total scroll height
            if (msg.ratio !== undefined) {
              scrollPos = msg.ratio * scrollEl.scrollHeight;
              scrollEl.scrollTop = scrollPos;
              emitScrollUpdate();
            }
            break;

          case 'seekDelta': {
            // Jump ±N lines (1 line = the script element's computed line-height)
            const lh = parseFloat(getComputedStyle(scriptText).lineHeight) || 56;
            scrollPos = Math.max(0, scrollPos + (msg.lines ?? 1) * lh);
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
    if (!text?.trim()) return;
    currentScript = text;
    // parseMarkdown() is provided by md.js (loaded before this script)
    scriptText.innerHTML = parseMarkdown(text);
  }

  // ── Start overlay ─────────────────────────────────────────────────────────
  function dismissOverlay() {
    startOverlay.style.transition = 'opacity 0.4s ease';
    startOverlay.style.opacity    = '0';
    setTimeout(() => { startOverlay.style.display = 'none'; }, 400);
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────

  // Hide the fullscreen button if we're already running as a standalone PWA.
  // `display-mode: standalone` is set by both iOS "Add to Home Screen" and
  // Android Chrome when installed as a PWA — no need for the iOS-only
  // navigator.standalone check.
  if (window.matchMedia('(display-mode: standalone)').matches) {
    fullscreenBtn.style.display = 'none';
  }

  fullscreenBtn.addEventListener('click', () => {
    const el = document.documentElement;

    // Use the standard Fullscreen API with vendor-prefixed fallbacks
    const requestFn = el.requestFullscreen
      || el.webkitRequestFullscreen
      || el.mozRequestFullScreen
      || el.msRequestFullscreen;

    if (requestFn) {
      requestFn.call(el)
        .then(() => {
          fullscreenBtn.style.display = 'none';
          fullscreenTip.style.display = 'none';
        })
        .catch(() => showAddToHomeScreenTip());
    } else {
      // Fullscreen API not available (e.g. iOS Safari in-browser)
      showAddToHomeScreenTip();
    }
  });

  // Show platform-appropriate "Add to Home Screen" instructions when the
  // Fullscreen API is unavailable or denied
  function showAddToHomeScreenTip() {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

    fullscreenTip.innerHTML = isIOS
      ? '📲 For true full screen on iOS:<br>' +
        'tap <strong style="color:#a1a1aa;">Share</strong> → ' +
        '<strong style="color:#a1a1aa;">Add to Home Screen</strong>,<br>' +
        'then open from your home screen.'
      : '📲 For true full screen on Android:<br>' +
        'tap the browser menu → ' +
        '<strong style="color:#a1a1aa;">Add to Home Screen</strong>,<br>' +
        'then open from your home screen.';

    fullscreenTip.style.display = 'block';
    fullscreenBtn.style.display = 'none';
  }

  // Re-show the fullscreen button if the user exits fullscreen via the browser UI
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) fullscreenBtn.style.display = 'flex';
  });

  // ── Start button ──────────────────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    started               = true;
    startBtn.textContent  = 'Connecting…';
    startBtn.disabled     = true;

    // Both wake lock and NoSleep.js video autoplay require a user gesture —
    // this click event satisfies that requirement on all platforms.
    await acquireWakeLock();

    connect();

    // Brief delay to show "Connecting" feedback, then check if we have a script
    setTimeout(() => {
      if (currentScript.trim()) {
        dismissOverlay();
      } else {
        startBtn.textContent     = 'Waiting for script…';
        waitingMsg.style.display = 'block';
      }
    }, 600);
  });

})();
