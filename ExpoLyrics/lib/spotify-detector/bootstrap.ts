// Inject before Spotify loads. Credentials stay in this app's memory; never log them.
export const bootstrap = String.raw`(function () {
  if (location.origin !== 'https://open.spotify.com' || window.__connectProbe) return;
  window.__connectProbe = true;
  var send = function (v) {
    // Production only needs session verification and connection discovery.
    // Browser playback never feeds the direct detector or its lyrics clock.
    if (!/^(credentials|observerEndpoint|socket|notice)$/.test(v.type)) return;
    window.ReactNativeWebView.postMessage(JSON.stringify(v));
  };
  var trusted = function (raw) { try { var u = new URL(raw, location.href); return /(^|\.)spotify\.com$/.test(u.hostname); } catch (_) { return false; } };
  var headers = function (h) { var out = {}; try { new Headers(h).forEach(function (v,k) { if (/^(authorization|client-token|x-spotify-connection-id|spotify-connection-id|accept|content-type)$/.test(k)) out[k] = v; }); } catch (_) {} return out; };
  var observer = function (raw) {
    if (!trusted(raw)) return false;
    return /^\/connect-state\/v1\/devices\/[^/]+$/.test(new URL(raw, location.href).pathname);
  };
  // Successful observer responses can omit devices, including during playback.
  var hasPlayerState = function (v) {
    var s = v && v.player_state;
    return s && typeof s === 'object' && !Array.isArray(s) &&
      (typeof s.is_playing === 'boolean' || typeof s.is_paused === 'boolean');
  };
  var inspectResponse = function (url, response, requestHeaders) {
    // Only verification needs a response body. Discarded diagnostics must not
    // clone requests/responses or parse the browser's playback traffic.
    if (response.status !== 200 || !observer(url) || !requestHeaders ||
        !/^Bearer\s+\S+$/i.test(requestHeaders.authorization || '')) return;
    var length = Number(response.headers.get('content-length') || 0);
    if (length > 262144) return;
    response.clone().text().then(function(text) {
      if (!text || text.length > 262144) return;
      try {
        var parsed = JSON.parse(text);
        // Verify the exact request's bearer, including responses without devices.
        if (hasPlayerState(parsed)) {
          send({type:'credentials',token:requestHeaders.authorization.replace(/^Bearer\s+/i,''),
            clientToken:requestHeaders['client-token'],authenticated:true,verification:'observer-response'});
        }
      } catch (_) {}
    }).catch(function(){});
  };
  var observe = function (url, method, h) {
    if (!trusted(url)) return;
    var u = new URL(url, location.href);
    if (h.authorization) send({type:'credentials', token:h.authorization.replace(/^Bearer\s+/i,''), clientToken:h['client-token']});
    // Capture the registration destination, not its body or playing device identity.
    if (method === 'PUT' && /^\/connect-state\/v1\/devices\/[^/]+$/.test(u.pathname)) send({type:'observerEndpoint',url:u.href});
  };
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url || input.href;
    var method = String(init && init.method || input.method || 'GET').toUpperCase();
    var h = headers(init && init.headers || input.headers);
    try { observe(url,method,h); } catch (_) {}
    var result = nativeFetch.apply(this, arguments);
    result.then(function(response){try{inspectResponse(url,response,h);}catch(_){}}).catch(function(){});
    return result;
  };
  var open = XMLHttpRequest.prototype.open, set = XMLHttpRequest.prototype.setRequestHeader, submit = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method,url) { this.__probe = {method:String(method).toUpperCase(),url:String(url),headers:{}}; return open.apply(this,arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k,v) { if (this.__probe && /^(authorization|client-token|x-spotify-connection-id|spotify-connection-id|accept|content-type)$/i.test(k)) this.__probe.headers[k.toLowerCase()] = v; return set.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__probe) {
        var request = this.__probe, xhr = this;
        observe(request.url,request.method,request.headers);
        if (observer(request.url) && /^Bearer\s+\S+$/i.test(request.headers.authorization || '')) this.addEventListener('loadend',function(){
          if (xhr.status !== 200) return;
          try {
            var parsed = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
            if (hasPlayerState(parsed)) {
              send({type:'credentials',token:request.headers.authorization.replace(/^Bearer\s+/i,''),
                clientToken:request.headers['client-token'],authenticated:true,verification:'observer-response'});
            }
          } catch (_) {}
        },{once:true});
      }
    } catch (_) {}
    return submit.apply(this,arguments);
  };
  var OriginalSocket = window.WebSocket;
  function ProbeSocket(url, protocols) {
    var ws = protocols === undefined ? new OriginalSocket(url) : new OriginalSocket(url, protocols);
    if (trusted(url) && /dealer/i.test(new URL(url).hostname)) {
      send({type:'socket',url:String(url)});
    }
    return ws;
  }
  ProbeSocket.prototype = OriginalSocket.prototype;
  ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k) { ProbeSocket[k] = OriginalSocket[k]; });
  window.WebSocket = ProbeSocket;
  var probeToken = function () {
    nativeFetch('/api/token?reason=init&productType=web_player',{credentials:'include'}).then(function(r){return r.json();}).then(function(p){
      if (p.accessToken && p.isAnonymous === false) send({type:'credentials',token:p.accessToken,expiresAt:p.accessTokenExpirationTimestampMs,authenticated:true});
    }).catch(function(){send({type:'notice',message:'Session token probe unavailable; waiting for browser requests.'});});
  };
  window.__probeToken = probeToken;
  probeToken();
  var timer = setInterval(probeToken,15000);
  window.addEventListener('pagehide',function(){clearInterval(timer);});
  send({type:'notice',message:'Network capture installed.'});
})(); true;`;

// Android can defer its existing Connect observer until local playback starts.
// Register that already-created controller once to discover the observer route,
// without polling player state, creating a player, or transferring playback.
export const bootstrapAndroidObserver = String.raw`(function () {
  if (location.origin !== 'https://open.spotify.com' || window.__spotifyDetectorObserverBootstrap) return;
  window.__spotifyDetectorObserverBootstrap = true;
  var attempts = 0, stopped = false, timer = 0;
  window.addEventListener('pagehide', function () { stopped = true; window.clearTimeout(timer); });
  var discover = function () {
    if (stopped) return;
    var root = document.querySelector('[data-testid="now-playing-bar"], [aria-label="Now playing bar"], footer');
    var key = root && Object.keys(root).find(function (k) { return k.indexOf('__reactFiber') === 0; });
    var fiber = key && root[key], controller = null;
    for (var depth = 0; fiber && depth < 220; depth += 1, fiber = fiber.return) {
      var container = fiber.memoizedProps && fiber.memoizedProps.value;
      if (!container || !(container._map instanceof Map)) continue;
      container._map.forEach(function (entry, name) {
        if (String(name) !== 'Symbol(PlayerSDK)') return;
        var candidate = entry && entry.instance && entry.instance.harmony && entry.instance.harmony._controller;
        if (candidate && typeof candidate.register === 'function' && typeof candidate.getCurrentState === 'function') controller = candidate;
      });
      if (controller) break;
    }
    if (controller) {
      Promise.resolve().then(function () { if (!stopped) return controller.register(); }).catch(function () {
        // Session capture remains mounted; an explicit reconnect can try again.
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'notice',message:'Android observer registration failed. Reconnect Spotify to retry.'}));
      });
      return;
    }
    if (++attempts < 40) timer = window.setTimeout(discover, 500);
  };
  discover();
})(); true;`;
