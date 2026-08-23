export type BrowserCommand =
  | { type: "toggle" }
  | { type: "previous" }
  | { type: "next" }
  | { type: "seek"; positionMs: number }
  | { type: "readMetadata" }
  | { type: "diagnostics" }
  | { type: "setMonitoring"; enabled: boolean };

type PlaybackSource =
  | "media-element"
  | "media-session"
  | "playback-duration-position"
  | "html-clock"
  | "player-ui";

export type BrowserEvent =
  | { type: "ready" }
  | {
      type: "metadata";
      title?: string;
      artist?: string;
      album?: string;
      artworkUrl?: string;
      spotifyTrackId?: string;
    }
  | { type: "spotifyToken"; token?: string; expiresAt?: number }
  | { type: "signedIn"; signedIn: boolean }
  | {
      type: "playback";
      positionMs: number;
      durationMs: number;
      isPlaying: boolean;
      sampledAtMs: number;
      playbackRate: number;
      precisionMs: number;
      source: PlaybackSource;
    }
  | {
      type: "diagnostics";
      mediaSession: {
        available: boolean;
        playbackState: string;
        setPositionStateCalls: number;
        lastSetPositionStateAgeMs: number | null;
      };
      mediaElements: Array<{
        tag: string;
        currentTimeMs: number | null;
        durationMs: number | null;
        paused: boolean;
        playbackRate: number;
        readyState: number;
        hasSource: boolean;
      }>;
      slider: {
        found: boolean;
        tag?: string;
        role?: string | null;
        ariaValueNow?: string | null;
        ariaValueMax?: string | null;
        ariaValueText?: string | null;
        text?: string;
      };
      playback: {
        positionMs: number;
        durationMs: number;
        isPlaying: boolean;
        playbackRate: number;
        precisionMs: number;
        source: PlaybackSource;
      } | null;
      internalCandidate: {
        found: boolean;
        path?: string;
        ageMs?: number | null;
        precisionMs?: number | null;
      };
      clockCandidates: Array<{
        path: string;
        positionMs: number;
        durationMs: number;
        isPlaying: boolean;
        precisionMs: number;
        source: PlaybackSource;
      }>;
      safeWindowGlobals: string[];
    }
  | { type: "error"; message: string };

const SPOTIFY_NATIVE_SCHEMES = /^(?:spotify|spotify-action):/i;
const SPOTIFY_ANDROID_INTENT = /^intent:.*(?:scheme=spotify|package=com\.spotify\.music)/i;
const SPOTIFY_STORE_LINK = /^(?:market|itms-apps):.*spotify/i;
const SPOTIFY_APP_LINK_HOSTS = new Set([
  "spotify.link",
  "spotify.app.link",
  "spotify-alternate.app.link",
]);
const SPOTIFY_WEB_ORIGINS = new Set([
  "https://accounts.spotify.com",
  "https://open.spotify.com",
]);

// react-native-webview opens non-whitelisted schemes through Linking before it
// calls onShouldStartLoadWithRequest. Admit these schemes to the WebView's
// policy layer so KineSync gets the chance to reject them synchronously.
export const SPOTIFY_WEBVIEW_ORIGIN_WHITELIST: string[] = [
  "https://accounts.spotify.com",
  "https://open.spotify.com",
  "https://spotify.link",
  "https://spotify.app.link",
  "https://spotify-alternate.app.link",
  "spotify:*",
  "spotify-action:*",
  "intent:*",
  "market:*",
  "itms-apps:*",
];

/**
 * Returns true only for links whose purpose is to hand the current flow to the
 * native Spotify app (or its store listing). Normal open.spotify.com web-player
 * navigation must remain in the WebView.
 */
export function isSpotifyNativeAppRedirect(rawUrl: string): boolean {
  const url = String(rawUrl || "").trim();
  if (!url) return false;

  const comparable = (() => {
    try {
      return decodeURIComponent(url);
    } catch {
      return url;
    }
  })();

  if (
    SPOTIFY_NATIVE_SCHEMES.test(comparable) ||
    SPOTIFY_ANDROID_INTENT.test(comparable) ||
    SPOTIFY_STORE_LINK.test(comparable)
  ) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return SPOTIFY_APP_LINK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedSpotifyWebViewNavigation(rawUrl: string): boolean {
  if (isSpotifyNativeAppRedirect(rawUrl)) return false;
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return SPOTIFY_WEB_ORIGINS.has(parsed.origin) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * react-native-webview may omit nativeEvent.url for messages from the current
 * document on iOS. An omitted URL is safe here because every containing
 * WebView independently restricts navigation to the exact Spotify origins.
 */
export function isTrustedSpotifyWebViewMessageUrl(rawUrl: string): boolean {
  const url = String(rawUrl || '').trim();
  return !url || isAllowedSpotifyWebViewNavigation(url);
}

// Runs on any open.spotify.com / accounts.spotify.com page. The web player's own
// token endpoint is the only place that reports both the expiry and whether the
// session is anonymous, so it doubles as the sign-in probe for onboarding.
export const spotifyAuthProbeScript = String.raw`
  (function () {
    if (window.__kineSyncAuthProbeInstalled) return true;
    window.__kineSyncAuthProbeInstalled = true;

    var post = function (payload) {
      try {
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      } catch (error) {}
    };
    var lastToken = '';
    var lastSignedIn = null;
    var reportSignedIn = function (signedIn) {
      if (signedIn === null || signedIn === lastSignedIn) return;
      lastSignedIn = signedIn;
      post({ type: 'signedIn', signedIn: signedIn });
    };
    var pollToken = function () {
      try {
        fetch('/api/token?reason=init&productType=web_player', {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (payload) {
            if (!payload) return;
            if (typeof payload.isAnonymous === 'boolean') reportSignedIn(!payload.isAnonymous);
            var token = String(payload.accessToken || '').trim();
            if (!token || token === lastToken) return;
            lastToken = token;
            post({
              type: 'spotifyToken',
              token: token,
              expiresAt: Number(payload.accessTokenExpirationTimestampMs || 0)
            });
          })
          .catch(function () {});
      } catch (error) {}
    };
    var pollDom = function () {
      try {
        if (document.querySelector('[data-testid="user-widget-link"], [data-testid="user-widget-avatar"], button[data-testid="user-widget-link"]')) {
          reportSignedIn(true);
          return;
        }
        if (document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')) reportSignedIn(false);
      } catch (error) {}
    };
    pollToken();
    pollDom();
    window.setInterval(pollDom, 1500);
    window.setInterval(pollToken, 300000);
    return true;
  })();
  true;
`;

export const installBrowserControlPreludeScript = String.raw`
  (function () {
    if (window.__spotifyBrowserLabPreludeInstalled) return true;
    window.__spotifyBrowserLabPreludeInstalled = true;

    var finite = function (value) { return typeof value === 'number' && Number.isFinite(value); };
    var now = function () { return Date.now(); };
    var perfNow = function () { return performance && typeof performance.now === 'function' ? performance.now() : now(); };
    var epochFromPerf = function (perfMs) { return now() - perfNow() + perfMs; };

    window.__spotifyBrowserLabMediaSessionProbe = window.__spotifyBrowserLabMediaSessionProbe || { setPositionStateCalls: 0, lastSetPositionStateAtMs: 0 };
    window.__spotifyBrowserLabPositionState = window.__spotifyBrowserLabPositionState || null;
    window.__spotifyBrowserLabKnownMedia = window.__spotifyBrowserLabKnownMedia || [];
    window.__spotifyBrowserLabLastBearerToken = window.__spotifyBrowserLabLastBearerToken || '';

    var postBridgeEvent = function (payload) {
      try {
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      } catch (error) {}
    };
    var rememberBearerToken = function (value) {
      var raw = String(value || '').trim();
      var match = raw.match(/^Bearer\s+(.+)$/i);
      var token = match && match[1] ? match[1].trim() : '';
      if (!token || token.length < 20 || token === window.__spotifyBrowserLabLastBearerToken) return;
      window.__spotifyBrowserLabLastBearerToken = token;
      postBridgeEvent({ type: 'spotifyToken', token: token });
    };

    var readHeaderValue = function (headers, targetName) {
      if (!headers) return '';
      var lowerTarget = String(targetName || '').toLowerCase();
      try {
        if (typeof headers.get === 'function') return headers.get(targetName) || headers.get(lowerTarget) || '';
      } catch (error) {}
      if (Array.isArray(headers)) {
        for (var index = 0; index < headers.length; index += 1) {
          var row = headers[index] || [];
          if (String(row[0] || '').toLowerCase() === lowerTarget) return String(row[1] || '');
        }
      }
      if (typeof headers === 'object') {
        for (var key in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, key) && String(key).toLowerCase() === lowerTarget) return String(headers[key] || '');
        }
      }
      return '';
    };
    var installBearerProbe = function () {
      if (window.__spotifyBrowserLabAuthProbeInstalled) return;
      window.__spotifyBrowserLabAuthProbeInstalled = true;
      try {
        if (typeof window.fetch === 'function') {
          var nativeFetch = window.fetch.bind(window);
          window.fetch = function (input, init) {
            try {
              rememberBearerToken(readHeaderValue(init && init.headers, 'Authorization'));
              rememberBearerToken(readHeaderValue(input && input.headers, 'Authorization'));
            } catch (error) {}
            return nativeFetch.apply(window, arguments);
          };
        }
      } catch (error) {}
      try {
        if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
          var nativeOpen = window.XMLHttpRequest.prototype.open;
          var nativeSend = window.XMLHttpRequest.prototype.send;
          if (typeof nativeOpen === 'function') {
            window.XMLHttpRequest.prototype.open = function () {
              return nativeOpen.apply(this, arguments);
            };
          }
          if (typeof nativeSend === 'function') {
            window.XMLHttpRequest.prototype.send = function () {
              return nativeSend.apply(this, arguments);
            };
          }
          var nativeSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;
          if (typeof nativeSetRequestHeader === 'function') {
            window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
              try {
                if (String(name || '').toLowerCase() === 'authorization') rememberBearerToken(value);
              } catch (error) {}
              return nativeSetRequestHeader.apply(this, arguments);
            };
          }
        }
      } catch (error) {}
    };
    installBearerProbe();

    var capturePositionState = function (state) {
      try {
        window.__spotifyBrowserLabMediaSessionProbe.setPositionStateCalls += 1;
        window.__spotifyBrowserLabMediaSessionProbe.lastSetPositionStateAtMs = now();
        if (!state) {
          window.__spotifyBrowserLabPositionState = null;
          return;
        }
        var position = Number(state.position);
        var duration = Number(state.duration);
        var playbackRate = Number(state.playbackRate || 1);
        if (!finite(position)) return;
        var sampledAtPerfMs = perfNow();
        window.__spotifyBrowserLabPositionState = {
          positionMs: Math.max(0, position * 1000),
          durationMs: finite(duration) ? Math.max(0, duration * 1000) : 0,
          playbackRate: finite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
          sampledAtPerfMs: sampledAtPerfMs,
          sampledAtMs: epochFromPerf(sampledAtPerfMs),
          precisionMs: 8
        };
      } catch (error) {}
    };

    var rememberMedia = function (media) {
      try {
        if (!media || window.__spotifyBrowserLabKnownMedia.indexOf(media) >= 0) return;
        window.__spotifyBrowserLabKnownMedia.push(media);
        if (window.__spotifyBrowserLabKnownMedia.length > 40) window.__spotifyBrowserLabKnownMedia.shift();
      } catch (error) {}
    };

    var installMediaElementProbe = function (media) {
      try {
        if (!media || media.__spotifyBrowserLabMediaWrapped) return;
        media.__spotifyBrowserLabMediaWrapped = true;
        rememberMedia(media);
        ['playing', 'play', 'pause', 'seeked', 'seeking', 'ratechange', 'durationchange', 'loadedmetadata', 'canplay'].forEach(function (eventName) {
          media.addEventListener(eventName, function () { rememberMedia(media); }, true);
        });
      } catch (error) {}
    };

    var collectMediaElements = function (root, results) {
      try {
        if (!root || results.length > 80) return results;
        if (root.tagName && /^(audio|video)$/i.test(root.tagName)) results.push(root);
        if (root.querySelectorAll) Array.prototype.slice.call(root.querySelectorAll('audio, video')).forEach(function (media) { results.push(media); });
        var nodes = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll('*')).slice(0, 1200) : [];
        nodes.forEach(function (node) { if (node.shadowRoot) collectMediaElements(node.shadowRoot, results); });
        Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('iframe') : []).forEach(function (frame) {
          try { if (frame.contentDocument) collectMediaElements(frame.contentDocument, results); } catch (error) {}
        });
      } catch (error) {}
      return results;
    };

    var allMediaElements = function () {
      var media = collectMediaElements(document, []).concat(window.__spotifyBrowserLabKnownMedia || []);
      return media.filter(function (item, index) { return item && media.indexOf(item) === index; });
    };

    var installAllMediaProbes = function () {
      try { allMediaElements().forEach(installMediaElementProbe); } catch (error) {}
    };

    var installMediaSessionProbe = function () {
      try {
        var mediaSession = window.navigator && window.navigator.mediaSession;
        if (!mediaSession || typeof mediaSession.setPositionState !== 'function') return;
        if (mediaSession.__spotifyBrowserLabWrapped) return;
        var nativeSetPositionState = mediaSession.setPositionState.bind(mediaSession);
        mediaSession.setPositionState = function (state) {
          capturePositionState(state);
          return nativeSetPositionState(state);
        };
        mediaSession.__spotifyBrowserLabWrapped = true;
      } catch (error) {}
    };

    var nativeCreateElement = Document.prototype.createElement;
    var NativeAudio = window.Audio;
    if (typeof NativeAudio === 'function' && !window.__spotifyBrowserLabAudioWrapped) {
      window.Audio = function () {
        var audio = new (Function.prototype.bind.apply(NativeAudio, [null].concat(Array.prototype.slice.call(arguments))))();
        installMediaElementProbe(audio);
        return audio;
      };
      window.Audio.prototype = NativeAudio.prototype;
      window.__spotifyBrowserLabAudioWrapped = true;
    }
    if (!Document.prototype.__spotifyBrowserLabCreateElementWrapped) {
      Document.prototype.createElement = function (tagName, options) {
        var element = nativeCreateElement.call(this, tagName, options);
        if (/^(audio|video)$/i.test(String(tagName || ''))) installMediaElementProbe(element);
        return element;
      };
      Document.prototype.__spotifyBrowserLabCreateElementWrapped = true;
    }

    installMediaSessionProbe();
    installAllMediaProbes();
    var mediaObserver = new MutationObserver(function (mutations) {
      if (document.visibilityState === 'hidden') return;
      mutations.forEach(function (mutation) {
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          if (node.matches && node.matches('audio, video')) installMediaElementProbe(node);
          if (node.querySelectorAll) {
            Array.prototype.slice.call(node.querySelectorAll('audio, video')).forEach(installMediaElementProbe);
          }
        });
      });
    });
    if (document.documentElement) {
      mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.setInterval(function () {
      if (document.visibilityState !== 'hidden') installMediaSessionProbe();
    }, 5000);
    window.setInterval(function () {
      if (
        document.visibilityState !== 'hidden' &&
        (window.__spotifyBrowserLabKnownMedia || []).length === 0
      ) installAllMediaProbes();
    }, 10000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') return;
      installMediaSessionProbe();
      if ((window.__spotifyBrowserLabKnownMedia || []).length === 0) installAllMediaProbes();
    });
    return true;
  })();
  true;
`;

export const installBrowserControlScript = String.raw`
  (function () {
    if (window.__spotifyBrowserLabInstalled) return true;
    window.__spotifyBrowserLabInstalled = true;

    var send = function (payload) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    };
    var finite = function (value) { return typeof value === 'number' && Number.isFinite(value); };
    var clamp = function (value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); };
    var now = function () { return Date.now(); };
    var perfNow = function () { return performance && typeof performance.now === 'function' ? performance.now() : now(); };
    var epochFromPerf = function (perfMs) { return now() - perfNow() + perfMs; };
    var labelOf = function (element) {
      return String(element && (element.getAttribute('aria-label') || element.textContent) || '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
    };
    var isEnabled = function (element) {
      return Boolean(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    };
    var playerRoot = function () {
      return document.querySelector('[aria-label="Player controls"], [data-testid="player-controls"]');
    };
    var nowPlayingRoot = function () {
      return document.querySelector('[data-testid="now-playing-bar"], [aria-label="Now playing bar"], footer');
    };
    var progressRoot = function () {
      var base = document.querySelector('[data-testid="playback-progressbar"]') || document.querySelector('[aria-label="Change progress"]');
      var root = base && base.parentElement;
      for (var depth = 0; root && depth < 8; depth += 1) {
        var text = String(root.textContent || '');
        if ((text.match(/(?:\d+:)?\d{1,2}:\d{2}/g) || []).length >= 2) return root;
        root = root.parentElement;
      }
      return nowPlayingRoot() || (base && base.parentElement) || base;
    };
    var progressSlider = function () {
      var root = progressRoot();
      return (root && root.querySelector('input[type="range"], [role="slider"]')) || document.querySelector('[aria-label="Change progress"], [data-testid="playback-progressbar"]');
    };
    var playerButtons = function () {
      var root = playerRoot();
      return Array.prototype.slice.call((root || document).querySelectorAll('button, [role="button"]'));
    };
    var findPlayerButton = function (action) {
      var testIds = { toggle: ['control-button-playpause'], previous: ['control-button-skip-back'], next: ['control-button-skip-forward'] };
      var byTestId = (testIds[action] || []).map(function (id) { return document.querySelector('[data-testid="' + id + '"]'); }).find(Boolean);
      if (byTestId) return byTestId;
      var labels = { toggle: ['pause', 'play'], previous: ['previous'], next: ['next'] };
      return playerButtons().find(function (button) { return labels[action].indexOf(labelOf(button)) >= 0; });
    };
    var clickPlayerButton = function (action, description) {
      var button = findPlayerButton(action);
      if (!isEnabled(button)) throw new Error(description + ' is unavailable in the persistent Spotify player. Start a playable track in the browser first.');
      button.click();
    };
    var parseClockValueMs = function (value) {
      var text = String(value || '').trim();
      if (!text) return null;
      var iso = text.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
      if (iso) {
        var hoursIso = Number(iso[1] || 0);
        var minutesIso = Number(iso[2] || 0);
        var secondsIso = Number(iso[3] || 0);
        return Math.max(0, Math.round((hoursIso * 3600 + minutesIso * 60 + secondsIso) * 1000));
      }
      var match = text.match(/(?:\d+:)?\d{1,2}:\d{2}(?:\.\d{1,3})?/);
      if (!match) return null;
      var parts = match[0].split(':');
      var seconds = Number(parts.pop() || 0);
      var minutes = Number(parts.pop() || 0);
      var hours = Number(parts.pop() || 0);
      if (!finite(seconds) || !finite(minutes) || !finite(hours)) return null;
      return Math.max(0, Math.round((hours * 3600 + minutes * 60 + seconds) * 1000));
    };
    var parseAllClockValuesMs = function (value) {
      var text = String(value || '');
      var results = [];
      var iso = text.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/ig) || [];
      iso.forEach(function (part) {
        var parsed = parseClockValueMs(part);
        if (parsed !== null) results.push(parsed);
      });
      var matches = text.match(/(?:\d+:)?\d{1,2}:\d{2}(?:\.\d{1,3})?/g) || [];
      matches.forEach(function (part) {
        var parsed = parseClockValueMs(part);
        if (parsed !== null) results.push(parsed);
      });
      return results;
    };
    var clockElementValue = function (element) {
      if (!element) return '';
      var values = [];
      if (element.tagName && element.tagName.toLowerCase() === 'time') {
        values.push(element.getAttribute('datetime') || element.dateTime || '');
      }
      values.push(element.getAttribute('aria-valuetext') || '');
      values.push(element.getAttribute('aria-label') || '');
      values.push(element.textContent || '');
      return values.join(' ');
    };
    var visibleClockCandidates = function () {
      var roots = [progressRoot(), nowPlayingRoot()].filter(Boolean);
      var seenRoots = [];
      var candidates = [];
      var slider = progressSlider();
      parseAllClockValuesMs(slider && slider.getAttribute('aria-valuetext')).forEach(function (value) {
        candidates.push({ value: value, left: -1, top: -1, width: 0, source: 'slider-aria' });
      });
      roots.forEach(function (root) {
        if (seenRoots.indexOf(root) >= 0) return;
        seenRoots.push(root);
        Array.prototype.slice.call(root.querySelectorAll('time, span, div, p')).forEach(function (element) {
          try {
            var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
            if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0)) return;
            var rect = element.getBoundingClientRect();
            if ((!rect.width && !rect.height) || rect.top < 0 || rect.left < 0) return;
            parseAllClockValuesMs(clockElementValue(element)).forEach(function (value) {
              candidates.push({ value: value, left: rect.left, top: rect.top, width: rect.width, source: element.tagName.toLowerCase() });
            });
          } catch (error) {}
        });
      });
      return candidates.filter(function (candidate, index) {
        return finite(candidate.value) && candidates.findIndex(function (other) {
          return other.value === candidate.value && Math.abs(other.left - candidate.left) < 2 && Math.abs(other.top - candidate.top) < 2;
        }) === index;
      });
    };
    var sliderDurationMs = function () {
      var slider = progressSlider();
      if (!slider) return 0;
      var rawMaximum = Number(slider.getAttribute('aria-valuemax') || slider.max || 0);
      if (!finite(rawMaximum) || rawMaximum <= 0) return 0;
      return rawMaximum > 10000 ? Math.round(rawMaximum) : Math.round(rawMaximum * 1000);
    };
    var playbackDurationPosition = function () {
      var element = document.querySelector('[data-testid="playback-duration"][data-test-position]');
      if (!element) return null;
      var positionMs = Number(element.getAttribute('data-test-position'));
      if (!finite(positionMs) || positionMs < 0) return null;
      return { positionMs: Math.round(positionMs) };
    };
    var readNativeUiClock = function () {
      var candidates = visibleClockCandidates();
      var slider = progressSlider();
      var exactPosition = playbackDurationPosition();
      var ordered = candidates.slice().sort(function (left, right) {
        if (Math.abs(left.top - right.top) > 6) return left.top - right.top;
        return left.left - right.left;
      });
      var durationFromSlider = sliderDurationMs();
      var durationMs = durationFromSlider;
      if (!durationMs && ordered.length > 1) durationMs = ordered.reduce(function (max, candidate) { return Math.max(max, candidate.value); }, 0);
      var positionCandidate = null;
      if (!exactPosition) {
        var viable = ordered.filter(function (candidate) { return !durationMs || candidate.value <= durationMs; });
        if (viable.length) {
          var nonDuration = viable.filter(function (candidate) { return !durationMs || candidate.value < durationMs; });
          positionCandidate = (nonDuration.length ? nonDuration : viable)[0];
        }
      }
      var positionMs = exactPosition ? exactPosition.positionMs : (positionCandidate ? positionCandidate.value : null);
      if ((positionMs === null || positionMs === 0) && slider) {
        var value = Number(slider.getAttribute('aria-valuenow') || slider.value || 0);
        var max = Number(slider.getAttribute('aria-valuemax') || slider.max || 0);
        if (finite(value) && value > 0 && finite(max) && max > 10000) positionMs = value;
      }
      if (positionMs === null) return null;
      if (!durationMs || durationMs < positionMs) durationMs = durationFromSlider;
      return {
        positionMs: Math.max(0, Math.round(positionMs)),
        durationMs: Math.max(0, Math.round(durationMs || 0)),
        slider: slider,
        source: exactPosition ? 'playback-duration-position' : (ordered.length ? 'html-clock' : 'player-ui')
      };
    };
    var collectMediaElements = function (root, results) {
      try {
        if (!root || results.length > 80) return results;
        if (root.tagName && /^(audio|video)$/i.test(root.tagName)) results.push(root);
        if (root.querySelectorAll) Array.prototype.slice.call(root.querySelectorAll('audio, video')).forEach(function (media) { results.push(media); });
        var nodes = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll('*')).slice(0, 1200) : [];
        nodes.forEach(function (node) { if (node.shadowRoot) collectMediaElements(node.shadowRoot, results); });
        Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('iframe') : []).forEach(function (frame) {
          try { if (frame.contentDocument) collectMediaElements(frame.contentDocument, results); } catch (error) {}
        });
      } catch (error) {}
      return results;
    };
    var scannedMedia = [];
    var lastMediaScanAt = 0;
    var allKnownMedia = function () {
      var known = (window.__spotifyBrowserLabKnownMedia || []).filter(Boolean);
      if (known.length) {
        return known.filter(function (item, index) { return known.indexOf(item) === index; });
      }
      var currentTime = perfNow();
      if (!scannedMedia.length || currentTime - lastMediaScanAt >= 5000) {
        scannedMedia = collectMediaElements(document, []);
        lastMediaScanAt = currentTime;
      }
      var media = scannedMedia;
      return media.filter(function (item, index) { return item && media.indexOf(item) === index; });
    };
    var isPlaying = function () {
      var mediaPlaying = allKnownMedia().some(function (media) {
        try { return finite(media.currentTime) && !media.paused && !media.ended; } catch (error) { return false; }
      });
      if (mediaPlaying) return true;
      var toggle = findPlayerButton('toggle');
      var label = labelOf(toggle);
      if (/\bpause\b|pause playback|stop playback/i.test(label)) return true;
      if (/\bplay\b|resume playback/i.test(label)) return false;
      var pressed = toggle && toggle.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'false') return false;
      if ('mediaSession' in navigator && navigator.mediaSession.playbackState !== 'none') {
        return navigator.mediaSession.playbackState === 'playing';
      }
      return false;
    };
    var estimateSample = function (sample, source, fallbackDurationMs) {
      if (!sample || !finite(sample.positionMs)) return null;
      var playing = typeof sample.isPlaying === 'boolean' ? sample.isPlaying : isPlaying();
      var rate = finite(sample.playbackRate) && sample.playbackRate > 0 ? sample.playbackRate : 1;
      var sampledAtPerfMs = finite(sample.sampledAtPerfMs) ? sample.sampledAtPerfMs : perfNow();
      var elapsedMs = playing ? Math.max(0, perfNow() - sampledAtPerfMs) * rate : 0;
      var durationMs = finite(sample.durationMs) && sample.durationMs > 0 ? Math.round(sample.durationMs) : Math.round(fallbackDurationMs || 0);
      var positionMs = Math.max(0, sample.positionMs + elapsedMs);
      if (durationMs) positionMs = clamp(positionMs, 0, durationMs);
      return {
        positionMs: Math.round(positionMs),
        durationMs: durationMs,
        isPlaying: playing,
        playbackRate: rate,
        precisionMs: Math.max(1, Math.round(sample.precisionMs || 25)),
        sampledAtMs: epochFromPerf(perfNow()),
        source: source,
        staleMs: Math.max(0, perfNow() - sampledAtPerfMs)
      };
    };
    var mediaClock = function (fallbackDurationMs) {
      var samples = allKnownMedia().map(function (media) {
        try {
          if (!finite(media.currentTime)) return null;
          return estimateSample({
            positionMs: Math.max(0, media.currentTime * 1000),
            durationMs: finite(media.duration) ? Math.max(0, media.duration * 1000) : 0,
            isPlaying: !media.paused && !media.ended,
            playbackRate: finite(media.playbackRate) && media.playbackRate > 0 ? media.playbackRate : 1,
            sampledAtPerfMs: perfNow(),
            precisionMs: media.readyState >= 2 ? 2 : 12
          }, 'media-element', fallbackDurationMs);
        } catch (error) {
          return null;
        }
      }).filter(Boolean).filter(function (sample) {
        return sample.durationMs > 0 || sample.positionMs > 250 || sample.isPlaying;
      });
      samples.sort(function (left, right) {
        return Number(right.isPlaying) - Number(left.isPlaying) || left.precisionMs - right.precisionMs;
      });
      return samples[0] || null;
    };
    var mediaSessionClock = function (fallbackDurationMs) {
      var sample = estimateSample(window.__spotifyBrowserLabPositionState, 'media-session', fallbackDurationMs);
      if (!sample || sample.staleMs > 15000) return null;
      return sample;
    };

    var uiClock = null;
    var updateUiInterpolationClock = function () {
      var raw = readNativeUiClock();
      if (!raw) return null;
      var currentPerfMs = perfNow();
      var playing = isPlaying();
      var sameSecond = uiClock && raw.positionMs === uiClock.visiblePositionMs && Math.abs((raw.durationMs || 0) - (uiClock.durationMs || 0)) < 1000;
      if (!sameSecond) {
        uiClock = {
          visiblePositionMs: raw.positionMs,
          durationMs: raw.durationMs,
          cycleStartPerfMs: currentPerfMs,
          frozenOffsetMs: 0,
          isPlaying: playing,
          slider: raw.slider,
          source: raw.source
        };
      } else {
        uiClock.durationMs = raw.durationMs || uiClock.durationMs;
        uiClock.slider = raw.slider || uiClock.slider;
        uiClock.source = raw.source || uiClock.source;
        if (uiClock.isPlaying && !playing) {
          uiClock.frozenOffsetMs = clamp(currentPerfMs - uiClock.cycleStartPerfMs, 0, 999);
        } else if (!uiClock.isPlaying && playing) {
          uiClock.cycleStartPerfMs = currentPerfMs - uiClock.frozenOffsetMs;
        }
        uiClock.isPlaying = playing;
      }
      var offsetMs = playing ? clamp(currentPerfMs - uiClock.cycleStartPerfMs, 0, 999) : uiClock.frozenOffsetMs;
      var positionMs = uiClock.visiblePositionMs + offsetMs;
      if (uiClock.durationMs) positionMs = clamp(positionMs, 0, uiClock.durationMs);
      return {
        slider: uiClock.slider,
        positionMs: Math.round(positionMs),
        durationMs: Math.round(uiClock.durationMs || 0),
        isPlaying: playing,
        playbackRate: 1,
        precisionMs: (uiClock.source === 'playback-duration-position' || uiClock.source === 'html-clock') ? 20 : 1000,
        sampledAtMs: epochFromPerf(currentPerfMs),
        source: uiClock.source,
        staleMs: 0
      };
    };
    var progressData = function () {
      var ui = updateUiInterpolationClock();
      var fallbackDurationMs = ui ? ui.durationMs : sliderDurationMs();
      var exactMedia = mediaClock(fallbackDurationMs);
      var mediaSession = mediaSessionClock(fallbackDurationMs);
      var data = ui;
      if (exactMedia && (!ui || exactMedia.positionMs > 250 || ui.positionMs <= 250)) data = exactMedia;
      else if (mediaSession && (!ui || mediaSession.positionMs > 250 || ui.positionMs <= 250)) data = mediaSession;
      if (!data) return null;
      // WebKit can keep Media Session's state as "playing" briefly after a
      // pause. The visible Spotify control is the authoritative fallback.
      data.isPlaying = isPlaying();
      if (!data.slider) {
        var slider = progressSlider();
        if (slider) data.slider = slider;
      }
      return data;
    };
    var lastMetadata = '';
    var cleanMetadataText = function (value) {
      var text = String(value || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return '';
      if (text.length % 2 === 0) {
        var half = text.length / 2;
        var left = text.slice(0, half).trim();
        var right = text.slice(half).trim();
        if (left && left.toLowerCase() === right.toLowerCase()) return left;
      }
      var words = text.split(' ').filter(Boolean);
      if (words.length > 1 && words.length % 2 === 0) {
        var wordHalf = words.length / 2;
        var leftWords = words.slice(0, wordHalf).join(' ');
        var rightWords = words.slice(wordHalf).join(' ');
        if (leftWords && leftWords.toLowerCase() === rightWords.toLowerCase()) return leftWords;
      }
      var byMatch = text.match(/^(.+?)\s+by\s+.+$/i);
      if (byMatch && byMatch[1]) return byMatch[1].trim();
      var parts = text.split(/\s*[\r\n]+\s*/).map(function (part) { return part.trim(); }).filter(Boolean);
      if (parts.length > 1 && parts.every(function (part) { return part.toLowerCase() === parts[0].toLowerCase(); })) return parts[0];
      return text;
    };
    // Media Session is Spotify's own "what is playing right now" declaration —
    // the browser equivalent of the GSMTC feed the desktop bridge trusts.
    var readMediaSessionMetadata = function () {
      try {
        var metadata = window.navigator && window.navigator.mediaSession && window.navigator.mediaSession.metadata;
        if (!metadata) return null;
        var title = cleanMetadataText(metadata.title);
        var artist = cleanMetadataText(metadata.artist);
        if (!title || !artist) return null;
        var artwork = Array.isArray(metadata.artwork) ? metadata.artwork : [];
        var best = null;
        artwork.forEach(function (image) {
          var src = String((image && image.src) || '');
          if (!src) return;
          var size = Number(String((image && image.sizes) || '').split('x')[0] || 0);
          if (!best || size > best.size) best = { size: size, src: src };
        });
        return {
          title: title,
          artist: artist,
          album: cleanMetadataText(metadata.album),
          artworkUrl: best ? best.src : ''
        };
      } catch (error) {}
      return null;
    };
    var normalizeTitleKey = function (value) {
      return String(value || '').toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    };
    var titlesAgree = function (left, right) {
      var a = normalizeTitleKey(left);
      var b = normalizeTitleKey(right);
      if (!a || !b) return false;
      return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
    };
    var resolveTrackLink = function (element) {
      if (!element) return null;
      var link = element;
      try {
        if (!link.matches || !link.matches('a[href*="/track/"]')) {
          var child = link.querySelector && link.querySelector('a[href*="/track/"]');
          link = child || (link.closest && link.closest('a[href*="/track/"]'));
        }
      } catch (error) { return null; }
      return link || null;
    };
    var trackIdFromLink = function (element) {
      var link = resolveTrackLink(element);
      var href = String(link && (link.href || link.getAttribute('href')) || '');
      var match = href.match(/\/track\/([A-Za-z0-9]{22})(?:\b|[/?#])/);
      return match ? match[1] : '';
    };
    var titleFromTrackLink = function (element) {
      var link = resolveTrackLink(element);
      if (!link) return '';
      return cleanMetadataText(
        (link.getAttribute && link.getAttribute('aria-label')) ||
        link.textContent ||
        ''
      );
    };
    var readSpotifyTrackId = function (widget, titleElement, expectedTitle) {
      // Spotify preloads recommendations and search results, so only accept a
      // link inside the persistent now-playing widget whose own label agrees
      // with Media Session's currently playing title.
      var acceptLink = function (link) {
        var trackId = trackIdFromLink(link);
        if (!trackId) return '';
        var linkTitle = titleFromTrackLink(link);
        if (expectedTitle && linkTitle && !titlesAgree(linkTitle, expectedTitle)) return '';
        return trackId;
      };
      var titleId = acceptLink(titleElement);
      if (titleId) return titleId;
      var roots = [widget, nowPlayingRoot()].filter(Boolean);
      for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        var root = roots[rootIndex];
        var links = [];
        try {
          if (root && root.matches && root.matches('a[href*="/track/"]')) links.push(root);
          if (root && root.querySelectorAll) links = links.concat(Array.prototype.slice.call(root.querySelectorAll('a[href*="/track/"]')).slice(0, 12));
        } catch (error) {}
        for (var linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
          var trackId = acceptLink(links[linkIndex]);
          if (trackId) return trackId;
        }
      }
      return '';
    };
    var readMetadata = function () {
      var widget = nowPlayingRoot();
      var titleElement = widget && widget.querySelector('[data-testid="context-item-info-title"], [data-testid="context-item-link"], a[href*="/track/"]');
      var artistElement = widget && widget.querySelector('[data-testid="context-item-info-artist"], a[href*="/artist/"]');
      var domTitle = titleElement ? cleanMetadataText(titleElement.getAttribute('aria-label') || titleElement.textContent || '') : '';
      var domArtist = artistElement ? cleanMetadataText(artistElement.getAttribute('aria-label') || artistElement.textContent || '') : '';
      var mediaMetadata = readMediaSessionMetadata();
      var title = mediaMetadata ? mediaMetadata.title : domTitle;
      var artist = mediaMetadata ? mediaMetadata.artist : domArtist;
      var album = mediaMetadata ? mediaMetadata.album : '';
      var artworkUrl = mediaMetadata ? mediaMetadata.artworkUrl : '';
      var spotifyTrackId = readSpotifyTrackId(widget, titleElement, title);
      // The id comes from the now-playing bar's DOM, which can lag or point at a
      // hovered row. Only trust it when its own title matches what is playing.
      if (spotifyTrackId && mediaMetadata && !titlesAgree(domTitle, mediaMetadata.title)) spotifyTrackId = '';
      var key = title + '\\u0000' + artist + '\\u0000' + album + '\\u0000' + artworkUrl + '\\u0000' + spotifyTrackId;
      if (title && artist && key !== lastMetadata) {
        lastMetadata = key;
        send({
          type: 'metadata',
          title: title,
          artist: artist,
          album: album,
          artworkUrl: artworkUrl,
          spotifyTrackId: spotifyTrackId
        });
      }
    };
    var lastPlaybackKey = '';
    var readPlayback = function (force) {
      var data = progressData();
      if (!data) return null;
      var key = data.positionMs + ':' + data.durationMs + ':' + data.isPlaying + ':' + data.playbackRate + ':' + data.source;
      if (force || key !== lastPlaybackKey) {
        lastPlaybackKey = key;
        send({
          type: 'playback',
          positionMs: Math.round(data.positionMs),
          durationMs: Math.round(data.durationMs),
          isPlaying: Boolean(data.isPlaying),
          playbackRate: data.playbackRate || 1,
          precisionMs: data.precisionMs || 1000,
          sampledAtMs: data.sampledAtMs || now(),
          source: data.source
        });
      }
      return data;
    };
    var setNativeRangeValue = function (input, value) {
      var step = Number(input.step || 0);
      var rounded = step > 0 ? Math.round(value / step) * step : value;
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(rounded));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    var seek = function (targetMs) {
      var data = progressData();
      if (!data || !isEnabled(data.slider)) throw new Error('Seek is unavailable in the persistent Spotify player.');
      if (!data.durationMs) throw new Error('Spotify has not exposed a duration yet; wait for the track to begin.');
      var fraction = Math.max(0, Math.min(1, Number(targetMs) / data.durationMs));
      var slider = data.slider;
      uiClock = null;
      if (slider instanceof HTMLInputElement && slider.type === 'range') {
        var minimum = Number(slider.min || 0);
        var maximum = Number(slider.max || 100);
        setNativeRangeValue(slider, minimum + (maximum - minimum) * fraction);
        readPlayback(true);
        return;
      }
      var box = slider.getBoundingClientRect();
      if (!box.width) throw new Error('Spotify progress control is not visible.');
      var x = box.left + fraction * box.width;
      var y = box.top + box.height / 2;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (eventName) {
        var EventType = eventName.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : MouseEvent;
        slider.dispatchEvent(new EventType(eventName, { bubbles: true, clientX: x, clientY: y }));
      });
      readPlayback(true);
    };
    var readDiagnostics = function () {
      var mediaSession = window.navigator && window.navigator.mediaSession;
      var mediaProbe = window.__spotifyBrowserLabMediaSessionProbe || { setPositionStateCalls: 0, lastSetPositionStateAtMs: 0 };
      var slider = progressSlider();
      var data = progressData();
      var ui = updateUiInterpolationClock();
      var fallbackDurationMs = ui ? ui.durationMs : sliderDurationMs();
      var media = mediaClock(fallbackDurationMs);
      var session = mediaSessionClock(fallbackDurationMs);
      var candidates = [];
      [media, session, ui].forEach(function (candidate) {
        if (!candidate) return;
        candidates.push({ path: candidate.source, positionMs: candidate.positionMs, durationMs: candidate.durationMs, isPlaying: candidate.isPlaying, precisionMs: candidate.precisionMs, source: candidate.source });
      });
      send({
        type: 'diagnostics',
        mediaSession: {
          available: Boolean(mediaSession),
          playbackState: mediaSession ? String(mediaSession.playbackState || 'none') : 'unavailable',
          setPositionStateCalls: Number(mediaProbe.setPositionStateCalls || 0),
          lastSetPositionStateAgeMs: mediaProbe.lastSetPositionStateAtMs ? now() - mediaProbe.lastSetPositionStateAtMs : null
        },
        mediaElements: allKnownMedia().map(function (mediaElement) {
          return {
            tag: mediaElement.tagName.toLowerCase(),
            currentTimeMs: Number.isFinite(mediaElement.currentTime) ? Math.round(mediaElement.currentTime * 1000) : null,
            durationMs: Number.isFinite(mediaElement.duration) ? Math.round(mediaElement.duration * 1000) : null,
            paused: Boolean(mediaElement.paused),
            playbackRate: Number(mediaElement.playbackRate || 1),
            readyState: Number(mediaElement.readyState || 0),
            hasSource: Boolean(mediaElement.currentSrc)
          };
        }),
        slider: slider ? {
          found: true,
          tag: slider.tagName.toLowerCase(),
          role: slider.getAttribute('role'),
          ariaValueNow: slider.getAttribute('aria-valuenow'),
          ariaValueMax: slider.getAttribute('aria-valuemax'),
          ariaValueText: slider.getAttribute('aria-valuetext'),
          text: String(slider.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        } : { found: false },
        playback: data ? { positionMs: data.positionMs, durationMs: data.durationMs, isPlaying: data.isPlaying, playbackRate: data.playbackRate || 1, precisionMs: data.precisionMs || 1000, source: data.source } : null,
        internalCandidate: { found: false },
        clockCandidates: candidates,
        safeWindowGlobals: []
      });
    };

    var monitoringEnabled = true;
    var metadataPollTimer = 0;
    var playbackPollTimer = 0;
    var mutationReadTimer = 0;

    var stopMonitoringTimers = function () {
      window.clearTimeout(metadataPollTimer);
      window.clearTimeout(playbackPollTimer);
      window.clearTimeout(mutationReadTimer);
      metadataPollTimer = 0;
      playbackPollTimer = 0;
      mutationReadTimer = 0;
    };
    var pollMetadata = function () {
      if (!monitoringEnabled || document.visibilityState === 'hidden') return;
      readMetadata();
      metadataPollTimer = window.setTimeout(pollMetadata, 5000);
    };
    var pollPlayback = function () {
      if (!monitoringEnabled || document.visibilityState === 'hidden') return;
      var sample = readPlayback(false);
      playbackPollTimer = window.setTimeout(pollPlayback, sample && sample.isPlaying ? 250 : 1000);
    };
    var startMonitoringTimers = function () {
      stopMonitoringTimers();
      if (!monitoringEnabled || document.visibilityState === 'hidden') return;
      readMetadata();
      readPlayback(true);
      metadataPollTimer = window.setTimeout(pollMetadata, 5000);
      playbackPollTimer = window.setTimeout(pollPlayback, 250);
    };

    window.__spotifyBrowserControl = function (command) {
      try {
        if (command.type === 'setMonitoring') {
          monitoringEnabled = Boolean(command.enabled);
          startMonitoringTimers();
        }
        if (command.type === 'toggle') clickPlayerButton('toggle', 'Play/pause');
        if (command.type === 'previous') clickPlayerButton('previous', 'Previous');
        if (command.type === 'next') clickPlayerButton('next', 'Next');
        if (command.type === 'seek') seek(command.positionMs);
        if (command.type === 'diagnostics') readDiagnostics();
        if (command.type !== 'setMonitoring' || monitoringEnabled) {
          readMetadata();
          readPlayback(true);
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    };
    var observer = new MutationObserver(function () {
      if (
        !monitoringEnabled ||
        document.visibilityState === 'hidden' ||
        mutationReadTimer
      ) return;
      mutationReadTimer = window.setTimeout(function () {
        mutationReadTimer = 0;
        if (!monitoringEnabled || document.visibilityState === 'hidden') return;
        readMetadata();
        readPlayback(true);
      }, 200);
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    document.addEventListener('visibilitychange', startMonitoringTimers);
    startMonitoringTimers();
    send({ type: 'ready' });
    return true;
  })();
  true;
`;

export function makeBrowserCommandScript(command: BrowserCommand): string {
  return `window.__spotifyBrowserControl && window.__spotifyBrowserControl(${JSON.stringify(command)}); true;`;
}

export function parseBrowserEvent(payload: string): BrowserEvent | null {
  try {
    if (typeof payload !== 'string' || payload.length > 64 * 1024) return null;
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (!event || typeof event.type !== "string") return null;
    if (event.type === 'spotifyToken') {
      if (event.token !== undefined && (typeof event.token !== 'string' || event.token.length > 4096)) return null;
      if (event.expiresAt !== undefined && (!Number.isFinite(Number(event.expiresAt)) || Number(event.expiresAt) < 0)) return null;
    } else if (event.type === 'signedIn') {
      if (typeof event.signedIn !== 'boolean') return null;
    } else if (event.type === 'metadata') {
      for (const key of ['title', 'artist', 'album', 'artworkUrl', 'spotifyTrackId']) {
        if (event[key] !== undefined && (typeof event[key] !== 'string' || String(event[key]).length > 4096)) return null;
      }
    } else if (event.type === 'playback') {
      for (const key of ['positionMs', 'durationMs', 'sampledAtMs', 'playbackRate', 'precisionMs']) {
        if (!Number.isFinite(Number(event[key]))) return null;
      }
      if (typeof event.isPlaying !== 'boolean' || typeof event.source !== 'string') return null;
    } else if (!['ready', 'diagnostics', 'error'].includes(event.type)) {
      return null;
    }
    return event as BrowserEvent;
  } catch {
    return null;
  }
}

