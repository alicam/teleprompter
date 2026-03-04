/*!
 * NoSleep.js — Keep the screen awake using a hidden video loop.
 *
 * This is a minimal self-hosted build with no CDN dependency.
 * Based on NoSleep.js by Rich Tibbett (MIT License).
 *
 * How it works:
 *   Browsers require a user gesture before allowing video autoplay. Once that
 *   gesture has been received (e.g. the "Begin Prompting" button tap), we create
 *   a tiny hidden <video> element that loops silently. This prevents the OS from
 *   dimming or locking the screen during a prompting session.
 *
 * When to use this vs the native Wake Lock API:
 *   The Screen Wake Lock API (navigator.wakeLock) is now supported in Chrome 84+,
 *   Safari 16.4+, and Firefox 126+ on both iOS and Android. display.js tries the
 *   native API first and only falls back to this class when it is unavailable or
 *   when the request is denied (e.g. low-power mode on some devices).
 */
(function (global) {
  'use strict';

  // Tiny 1-second silent MP4 video as a base64 data URI.
  // The looping video keeps the media session active, which prevents sleep
  // on browsers that don't yet support the native Wake Lock API.
  const SILENT_VIDEO_SRC =
    'data:video/mp4;base64,' +
    'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAs1tZGF0AAAC' +
    'rgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0MiByMjQ3OSBkZDc5YTYx' +
    'IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxNCAtIGh0' +
    'dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEg' +
    'cmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9' +
    'NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNo' +
    'cm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBm' +
    'YXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTYgbG9va2FoZWFk' +
    'X3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxh' +
    'Y2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0z' +
    'IHBiX3N0cmF0ZWd5PTEgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVj' +
    'dD1zcGF0aWFsIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBreWludD0yNTAg' +
    'a2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2Fo' +
    'ZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAg' +
    'cXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAFZliIQL' +
    '/DqeAfHvDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' +
    'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDiA8AAAADAWAAAACJZ2VpbA==';

  class NoSleep {
    constructor() {
      this._enabled = false;
      this._video   = null;
    }

    get enabled() {
      return this._enabled;
    }

    enable() {
      if (this._enabled) return;

      // Create a 1×1 invisible video element and append it to the document.
      // The `playsinline` attribute is required on iOS to prevent the video
      // from opening in fullscreen. `muted` is required for autoplay to work
      // without a sound permission prompt on all platforms.
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('loop', '');
      video.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;opacity:0;pointer-events:none;';

      const source = document.createElement('source');
      source.src  = SILENT_VIDEO_SRC;
      source.type = 'video/mp4';
      video.appendChild(source);

      document.body.appendChild(video);
      this._video = video;

      video.play().then(() => {
        this._enabled = true;
      }).catch((err) => {
        console.warn('[NoSleep] Video play failed:', err);
        this._cleanup();
      });
    }

    disable() {
      this._cleanup();
    }

    _cleanup() {
      if (this._video) {
        this._video.pause();
        this._video.remove();
        this._video = null;
      }
      this._enabled = false;
    }
  }

  // Export for CommonJS (Node/bundlers) or as a global browser variable
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NoSleep;
  } else {
    global.NoSleep = NoSleep;
  }

})(typeof window !== 'undefined' ? window : this);
