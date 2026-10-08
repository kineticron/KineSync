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
  var relevant = function (raw) {
    if (!trusted(raw)) return false;
    return /\/connect-state\/|\/track-playback\/|\/devices(?:\/|$)|\/player\//.test(new URL(raw, location.href).pathname);
  };
  // Capture shape, never raw request bodies, tokens, or identity values.
  var shape = function (v, depth) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (depth > 4) return typeof v;
    if (Array.isArray(v)) return {arrayLength:v.length, first:v.length ? shape(v[0],depth+1) : 'empty'};
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).slice(0,24).forEach(function(k) {
        if (/token|authorization|cookie|credential|secret/i.test(k)) out[k] = '[redacted]';
        else if (/^(can_play|can_be_player|is_active|is_controllable|hidden|needs_full_player_state|supports_gzip_pushes)$/.test(k) && typeof v[k] === 'boolean') out[k] = v[k];
        else if (/^(member_type|put_state_reason)$/.test(k) && typeof v[k] === 'string' && /^[A-Z_]+$/.test(v[k])) out[k] = v[k];
        else out[k] = shape(v[k],depth+1);
      });
      return out;
    }
    return typeof v;
  };
  var bodyShape = function (body) {
    if (body === undefined || body === null) return 'no body';
    if (typeof body === 'string') { try { return shape(JSON.parse(body)); } catch (_) { return 'non-JSON string'; } }
    return Object.prototype.toString.call(body);
  };
  var inspectResponse = function (url, response, requestHeaders) {
    if (!relevant(url)) return;
    var u = new URL(url, location.href);
    var report = {type:'wireResponse',host:u.hostname,path:u.pathname,status:response.status,contentType:response.headers.get('content-type') || ''};
    var length = Number(response.headers.get('content-length') || 0);
    if (length > 262144) { report.bodyShape = 'body too large for schema capture'; send(report); return; }
    response.clone().text().then(function(text) {
      if (text.length > 262144) report.bodyShape = 'body too large for schema capture';
      else if (!text) report.bodyShape = 'empty';
      else {
        try {
          var parsed = JSON.parse(text);
          report.bodyShape = shape(parsed);
          // Verify the exact request's bearer token using its successful,
          // account-scoped observer response. /api/token isn't always available.
          if (response.status === 200 && /^\/connect-state\/v1\/devices\/[^/]+$/.test(u.pathname) &&
              parsed && parsed.player_state && (parsed.devices || parsed.device) &&
              requestHeaders && /^Bearer\s+\S+$/i.test(requestHeaders.authorization || '')) {
            send({type:'credentials',token:requestHeaders.authorization.replace(/^Bearer\s+/i,''),
              clientToken:requestHeaders['client-token'],authenticated:true,verification:'observer-response'});
          }
        } catch (_) { report.bodyShape = 'non-JSON response'; }
      }
      send(report);
    }).catch(function(){report.bodyShape='unreadable';send(report);});
  };
  var observe = function (url, method, h, body) {
    if (!trusted(url)) return;
    var u = new URL(url, location.href);
    if (relevant(url)) send({type:'wireRequest',method:method,host:u.hostname,path:u.pathname,contentType:h['content-type'] || '',headerNames:Object.keys(h),bodyShape:bodyShape(body)});
    if (h.authorization) send({type:'credentials', token:h.authorization.replace(/^Bearer\s+/i,''), clientToken:h['client-token']});
    // Capture the registration destination, not its body or playing device identity.
    if (method === 'PUT' && /^\/connect-state\/v1\/devices\/[^/]+$/.test(u.pathname)) send({type:'observerEndpoint',url:u.href});
    if (method === 'GET' && /\/connect-state\/|\/player\/(?:v\d+\/)?state|\/track-playback\/v\d+\/devices/.test(u.pathname))
      send({type:'request', url:u.href, headers:h});
    if (/\/connect-state\/|\/track-playback\//.test(u.pathname)) send({type:'route', method:method, path:u.pathname});
  };
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url || input.href;
    var method = String(init && init.method || input.method || 'GET').toUpperCase();
    var h = headers(init && init.headers || input.headers);
    try {
      if (relevant(url) && init && init.body !== undefined) observe(url,method,h,init.body);
      else if (relevant(url) && input && typeof input.clone === 'function' && method !== 'GET') {
        input.clone().text().then(function(body){observe(url,method,h,body);}).catch(function(){observe(url,method,h);});
      } else observe(url,method,h);
    } catch (_) {}
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
        observe(request.url,request.method,request.headers,body);
        if (relevant(request.url)) this.addEventListener('loadend',function(){
          var u = new URL(request.url,location.href), data = 'unreadable';
          try { data = xhr.responseType === 'json' ? shape(xhr.response) : bodyShape(xhr.responseText); } catch (_) {}
          try {
            var parsed = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
            if (xhr.status === 200 && /^\/connect-state\/v1\/devices\/[^/]+$/.test(u.pathname) &&
                parsed && parsed.player_state && (parsed.devices || parsed.device) &&
                /^Bearer\s+\S+$/i.test(request.headers.authorization || '')) {
              send({type:'credentials',token:request.headers.authorization.replace(/^Bearer\s+/i,''),
                clientToken:request.headers['client-token'],authenticated:true,verification:'observer-response'});
            }
          } catch (_) {}
          send({type:'wireResponse',host:u.hostname,path:u.pathname,status:xhr.status,contentType:xhr.getResponseHeader('content-type') || '',bodyShape:data});
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
      var originalSend = ws.send;
      ws.send = function (data) {
        var summary = {type:'socketSend',bodyShape:bodyShape(data)};
        try { var parsed = JSON.parse(data); if (/^(ping|pong|reply|request|subscribe)$/.test(parsed.type)) summary.messageType = parsed.type; } catch (_) {}
        send(summary);
        return originalSend.apply(this,arguments);
      };
      ws.addEventListener('message',function (e) { if (typeof e.data === 'string') { try { send({type:'browserEvent',payload:JSON.parse(e.data)}); } catch (_) {} } });
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
