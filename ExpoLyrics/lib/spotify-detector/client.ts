import { Buffer } from 'buffer';
import { gzip } from 'pako';
import { connectionIdFrom, decodeDealer, decodeStateBody, observerBody, observerEndpoint,
  sampleFrom, spotifyHost, stateFingerprint, trackHex, metadataFrom, type TrackMetadata, type Sample } from './protocol';
import { recordTiming, timingNow, type TimingContext } from './timing-diagnostics';
import { logDevelopmentTiming } from './development-timing-log';
import { DealerDeliveryBaseline, type DeliveryIdentity } from './dealer-delivery-baseline';
import { isDealerDeliveryExperimentEnabled, subscribeDealerDeliveryExperiment } from './dealer-delivery-experiment-toggle';
import { logDealerDeliveryDecision } from './dealer-delivery-experiment-log';
import { emitNativeClockDiagnostic, getNativeClockCapture, nativeClockCaptureActive } from '../native-clock-diagnostics';
const nativeDiagnosticsEnabled = typeof __DEV__ !== 'undefined' && __DEV__;

type Callbacks = {
  sample: (sample: Sample) => void;
  status: (message: string) => void;
  sessionNeeded: () => void;
  authenticated: (token: string, expiresAt: number) => void;
  ready: () => void;
};

export class SpotifyPlaybackUnavailableError extends Error {}

/** One non-playing Connect observer. Credentials/routes are memory-only.
 * No polling clock: the playback store owns interpolation between events. */
export class SpotifyDetector {
  private token = '';
  private clientToken = '';
  private expiresAt = 0;
  private route = '';
  private dealer = '';
  private readonly deviceId = Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  private connectionId = '';
  private socket: WebSocket | null = null;
  private enabled = false;
  private generation = 0;
  private reconnects = 0;
  private controller: AbortController | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private fingerprint = '';
  private lastSample: Sample | null = null;
  private lastSourceTimestamp = 0;
  private orderingDeviceId: string | undefined;
  private orderingSessionId: string | undefined;
  private lastDealerConnection = '';
  private registered = false;
  private blocked = false;
  private pendingState: { payload: unknown; receivedAt: number; timing: TimingContext } | null = null;
  private requests = new Set<AbortController>();
  private metadataCache = new Map<string, TrackMetadata>();
  private metadataPending = new Map<string, Promise<TrackMetadata>>();
  private commandPending = false;
  private deliveryBaseline = new DealerDeliveryBaseline();
  private deliveryRouteEpoch = 0;
  private deliveryAuthEpoch = 0;
  private lastDeliveryObservation: Sample | null = null;
  private experimentEnabled = isDealerDeliveryExperimentEnabled();
  private removeExperimentListener: (() => void) | null = null;
  constructor(private callbacks: Callbacks) {}

  private listenForExperimentToggle() {
    if (this.removeExperimentListener) return;
    this.experimentEnabled = isDealerDeliveryExperimentEnabled();
    this.removeExperimentListener = subscribeDealerDeliveryExperiment(enabled => {
      this.experimentEnabled = enabled;
      if (!this.enabled || !this.lastDeliveryObservation) return;
      this.callbacks.sample({ ...this.lastDeliveryObservation, dealerDeliveryExperimentEnabled: enabled,
        dealerDeliveryExperimentReanchor: true });
    });
  }

  capture(raw: string, origin: string): boolean {
    try {
      if (new URL(origin).origin !== 'https://open.spotify.com') return false;
      const e = JSON.parse(raw);
      if (e.type === 'notice' && e.message === 'Android observer registration failed. Reconnect Spotify to retry.' && !this.registered) {
        this.callbacks.status(e.message); return true;
      }
      if (e.type === 'credentials' && e.authenticated === true && typeof e.token === 'string' && e.token.length > 0 && e.token.length < 4096) {
        const changed = e.token !== this.token;
        if (changed) { this.deliveryAuthEpoch++; this.deliveryBaseline.clear(); this.lastDeliveryObservation = null; }
        this.token = e.token;
        if (typeof e.clientToken === 'string' && e.clientToken.length < 4096) this.clientToken = e.clientToken;
        let expiresAt = Number(e.expiresAt) || 0;
        if (!expiresAt) { try { expiresAt = Number(JSON.parse(Buffer.from(e.token.split('.')[1], 'base64').toString()).exp) * 1000 || 0; } catch {} }
        // Opaque tokens cannot live forever just because the capture omitted expiry.
        this.expiresAt = expiresAt || (changed || !this.expiresAt ? Date.now() + 45 * 60_000 : this.expiresAt);
        this.callbacks.authenticated(this.token, this.expiresAt);
        if (changed && this.socket) this.disconnect();
        this.connectIfReady();
        return true;
      }
      if (e.type === 'observerEndpoint' && typeof e.url === 'string') {
        const route = observerEndpoint(e.url, this.deviceId);
        if (route) {
          if (this.route !== route) { this.deliveryRouteEpoch++; this.deliveryBaseline.clear(); this.lastDeliveryObservation = null; }
          this.route = route; this.connectIfReady(); return true;
        }
      }
      if (e.type === 'socket' && typeof e.url === 'string' && spotifyHost(e.url, true) && /(^|\.)[^.]*dealer[^.]*\./i.test(new URL(e.url).hostname)) {
        if (this.dealer !== e.url) { this.deliveryRouteEpoch++; this.deliveryBaseline.clear(); this.lastDeliveryObservation = null; }
        this.dealer = e.url; this.connectIfReady(); return true;
      }
    } catch { /* Ignore untrusted/malformed bridge data. */ }
    return false;
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.listenForExperimentToggle();
      // Returning from suspension reprojects the last authoritative anchor.
      if (this.lastSample) {
        recordTiming('foreground-replay', this.lastSample.timingProvenance);
        logDevelopmentTiming('foreground-replay', this.lastSample);
        // Keep legacy fallback behavior; immutable provenance retains original receipt.
        this.callbacks.sample({ ...this.lastSample, receivedAt: Date.now(),
          dealerDeliveryExperimentEnabled: this.experimentEnabled });
      }
      this.connectIfReady();
    } else this.disconnect();
  }
  refresh() {
    if (nativeDiagnosticsEnabled && nativeClockCaptureActive()) emitNativeClockDiagnostic('detector-refresh-before', {
      generation: this.generation, reason: 'explicit-refresh', registered: this.registered, experiment: this.experimentEnabled,
      ...this.deliveryBaseline.diagnosticSummary() });
    this.deliveryBaseline.preserveForExplicitRefresh(performance.now(), this.currentDeliveryIdentity());
    if (nativeDiagnosticsEnabled && nativeClockCaptureActive()) emitNativeClockDiagnostic('detector-refresh-preserved', {
      generation: this.generation, ...this.deliveryBaseline.diagnosticSummary() });
    this.blocked = false;
    this.resetOrdering(); this.reconnects = 0;
    this.disconnect(true); this.connectIfReady();
  }
  clear() {
    this.enabled = false; this.disconnect(); this.token = ''; this.clientToken = '';
    this.route = ''; this.dealer = ''; this.expiresAt = 0; this.lastSample = null;
    this.deliveryBaseline.clear(); this.lastDeliveryObservation = null;
    this.removeExperimentListener?.(); this.removeExperimentListener = null;
    this.resetOrdering();
    this.blocked = false;
    this.metadataCache.clear(); this.metadataPending.clear();
  }
  async metadata(uri: string): Promise<TrackMetadata> {
    const cached = this.metadataCache.get(uri);
    if (cached) return cached;
    const pending = this.metadataPending.get(uri);
    if (pending) return pending;
    const run = this.generation;
    const lookup = (async () => {
      const path = `/metadata/4/track/${trackHex(uri)}?market=from_token`;
      const response = await this.request(path, 'GET');
      const data = metadataFrom(uri, JSON.parse(new TextDecoder().decode(response)));
      if (run !== this.generation) throw new Error('Spotify session changed during metadata lookup.');
      if (this.metadataCache.size >= 32) this.metadataCache.clear();
      this.metadataCache.set(uri, data);
      return data;
    })();
    this.metadataPending.set(uri, lookup);
    try { return await lookup; }
    finally { if (this.metadataPending.get(uri) === lookup) this.metadataPending.delete(uri); }
  }
  async control(command: { type: 'toggle' | 'previous' | 'next' | 'seek'; positionMs?: number }): Promise<void> {
    if (this.commandPending) throw new Error('Waiting for the previous Spotify command.');
    const target = this.lastSample?.activeDeviceId;
    if (!this.enabled || !this.registered || !target) throw new SpotifyPlaybackUnavailableError('Spotify detector is reconnecting; try again when a device is detected.');
    if (command.type === 'seek' && !Number.isFinite(command.positionMs)) throw new Error('Invalid seek position.');
    const endpoint = { toggle: this.lastSample?.playing ? 'pause' : 'resume', previous: 'skip_prev', next: 'skip_next', seek: 'seek_to' }[command.type];
    // Route to the device observed by Dealer, not a newly mounted web player.
    const from = new URL(this.route).pathname.split('/').pop()!;
    const path = `/connect-state/v1/player/command/from/${encodeURIComponent(from)}/to/${encodeURIComponent(target)}`;
    const value = command.type === 'seek' ? Math.round(Math.max(0, Math.min(this.lastSample!.durationMs || Infinity, command.positionMs!))) : undefined;
    const body = { command: { endpoint, ...(value !== undefined ? { value } : {}),
      options: { only_for_local_device: false, system_initiated: false, override_restrictions: false } },
      connection_type: 'wlan', intent_id: Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('') };
    this.commandPending = true;
    try {
      await this.request(path, 'POST', body);
      this.callbacks.status(`Spotify ${endpoint} accepted; awaiting the device update.`);
    } finally { this.commandPending = false; }
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Uint8Array> {
    if (!this.enabled || this.blocked || !this.token || !this.route || !this.connectionId) throw new Error('Spotify session is not ready.');
    const run = this.generation;
    const started = nativeDiagnosticsEnabled ? performance.now() : 0;
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
      'x-spotify-connection-id': this.connectionId };
    if (this.clientToken) headers['client-token'] = this.clientToken;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-encoding'] = 'gzip'; }
    try {
      const response = await fetch(new URL(path, this.route).toString(), { method, headers, signal: controller.signal,
        ...(body !== undefined ? { body: Uint8Array.from(gzip(JSON.stringify(body))).buffer } : {}) });
      if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('spotify-http-response', { endpoint: method === 'GET' ? 'metadata' : 'player-control',
        method, status: response.status, requestGeneration: run, currentGeneration: this.generation,
        elapsedMs: performance.now() - started, staleGeneration: run !== this.generation, cacheProvenance: 'network-response' });
      if (run !== this.generation) throw new Error('Spotify session changed during request.');
      if (response.status === 401) this.needSession('Spotify session expired. Refreshing login…');
      if (response.status === 429) { this.blocked = true; this.disconnect(); }
      if (method === 'POST' && response.status === 404) throw new SpotifyPlaybackUnavailableError('Spotify playback device is unavailable.');
      if (!response.ok) throw new Error(`Spotify ${method === 'GET' ? 'metadata' : 'control'} HTTP ${response.status}.`);
      // Read while the abort/timeout is still installed, including slow bodies.
      const bytes = await response.arrayBuffer();
      if (run !== this.generation) throw new Error('Spotify session changed during response.');
      return new Uint8Array(bytes);
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  private disconnect(preserveDeliveryBaseline = false) {
    this.generation++;
    if (!preserveDeliveryBaseline) this.deliveryBaseline.clear();
    this.controller?.abort(); this.controller = null;
    for (const controller of this.requests) controller.abort();
    this.requests.clear(); this.metadataPending.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.expiry) clearTimeout(this.expiry);
    this.heartbeat = null; this.reconnect = null; this.expiry = null;
    const ws = this.socket; this.socket = null; ws?.close();
    this.connectionId = ''; this.registered = false; this.pendingState = null;
  }
  private needSession(message: string) {
    this.disconnect(); this.token = ''; this.expiresAt = 0;
    this.deliveryAuthEpoch++; this.lastDeliveryObservation = null;
    this.callbacks.status(message); this.callbacks.sessionNeeded();
  }
  private resetOrdering() {
    this.fingerprint = ''; this.lastSourceTimestamp = 0;
    this.orderingDeviceId = undefined; this.orderingSessionId = undefined; this.lastDealerConnection = '';
  }
  private emit(payload: unknown, receivedAt = Date.now(), timing: TimingContext = {}) {
    const s = sampleFrom(payload, 0, timing);
    if (!s || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(s.uri)) return false;
    if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('source-candidate', { origin: timing.origin ?? 'unknown', generation: timing.generation,
      rawPosition: s.positionMs, playerTimestamp: s.positionTimestampMs, serverTimestamp: s.sourceServerTimestampMs,
      receiptWall: timing.receipt?.wallMs, receiptMono: timing.receipt?.monotonicMs, receivedAt,
      playing: s.playing, experiment: this.experimentEnabled,
      ...this.deliveryBaseline.diagnosticSummary() });
    s.receivedAt = receivedAt;
    if (s.sourceServerTimestampMs !== undefined) s.positionObservedAt = timing.receipt ?? timingNow(receivedAt);
    // Recognizable state proves observer readiness even when duplicate/stale.
    this.callbacks.ready();
    const device = typeof s.activeDeviceId === 'string' && s.activeDeviceId ? s.activeDeviceId : undefined;
    const session = s.playbackSessionId;
    const deviceChanged = !!device && !!this.orderingDeviceId && device !== this.orderingDeviceId;
    const sessionChanged = !!session && !!this.orderingSessionId && session !== this.orderingSessionId;
    const identityChanged = deviceChanged || sessionChanged;
    const connection = `${this.generation}:${this.connectionId}`;
    // A registration snapshot can predate a Dealer handoff on a different clock.
    // Comparing timestamps across those identities cannot order that race.
    if (timing.origin === 'registration' && this.lastDealerConnection === connection && identityChanged) {
      this.logDeliveryRejection(s, timing.origin, 'registration-conflicts-with-dealer-identity');
      logDevelopmentTiming('registration-conflict', s);
      recordTiming('stale', s.timingProvenance); return true;
    }
    // Unknown identity is not evidence of a handoff. Keep the known scope and
    // its watermark; only a positive identity change can reset source ordering.
    if (!identityChanged && s.positionTimestampMs && s.positionTimestampMs < this.lastSourceTimestamp) {
      this.logDeliveryRejection(s, timing.origin, 'source-timestamp-older-than-watermark');
      logDevelopmentTiming('stale', s);
      recordTiming('stale', s.timingProvenance); return true;
    }
    if (identityChanged) {
      this.lastSourceTimestamp = 0; this.fingerprint = '';
      this.deliveryBaseline.clear();
    }
    if (deviceChanged) this.orderingSessionId = undefined;
    if (device) this.orderingDeviceId = device;
    if (session) this.orderingSessionId = session;
    if (timing.origin === 'dealer') this.lastDealerConnection = connection;
    const deliveryIdentity: DeliveryIdentity = { device: device ?? '', session: session ?? '',
      routeEpoch: this.deliveryRouteEpoch, authEpoch: this.deliveryAuthEpoch };
    const observation = s.sourceServerTimestampMs !== undefined && s.positionTimestampMs !== undefined && s.positionObservedAt
      ? { serverMs: s.sourceServerTimestampMs, playerTimestampMs: s.positionTimestampMs,
          receipt: s.positionObservedAt, nowMono: performance.now(), identity: deliveryIdentity }
      : null;
    // The baseline is trained only by a fresh Dealer sample after source ordering
    // and handoff guards. A newer Dealer envelope with duplicate player state is
    // useful; duplicate envelope stamps cannot renew freshness in the model.
    if (timing.origin === 'dealer') {
      if (observation) {
        const diagnosticBaseline = this.experimentEnabled ? this.deliveryBaseline.fork() : null;
        const accepted = this.deliveryBaseline.observeDealer(observation);
        if (diagnosticBaseline) {
          const decision = diagnosticBaseline.observeDealerDecision(observation);
          logDealerDeliveryDecision('dealer-envelope', { ...decision, accepted });
        }
      } else if (this.experimentEnabled) {
        logDealerDeliveryDecision('dealer-envelope', { accepted: false, reason: 'dealer-missing-valid-timestamp-pair', sampleCount: 0 });
      }
    } else if (timing.origin === 'registration') {
      if (observation) {
        const diagnosticBaseline = this.experimentEnabled ? this.deliveryBaseline.fork() : null;
        s.dealerDeliveryExcessMs = this.deliveryBaseline.registrationExcess(observation, s.playing);
        if (this.experimentEnabled) {
          const decision = diagnosticBaseline!.registrationDecision(observation, s.playing);
          logDealerDeliveryDecision('registration-correction', { ...decision, excessMs: s.dealerDeliveryExcessMs });
        }
      } else {
        s.dealerDeliveryExcessMs = undefined;
        if (this.experimentEnabled) logDealerDeliveryDecision('registration-correction', {
          accepted: false, reason: 'registration-missing-valid-timestamp-pair', sampleCount: 0,
        });
      }
    }
    // A new connection may confirm identical state once. Within the connection,
    // session-only handoffs must not disappear behind an equal state fingerprint.
    const key = JSON.stringify([connection, this.orderingDeviceId, this.orderingSessionId,
      stateFingerprint({ ...s, activeDeviceId: this.orderingDeviceId })]);
    if (key === this.fingerprint) { logDevelopmentTiming('duplicate', s); recordTiming('duplicate', s.timingProvenance); return true; }
    this.fingerprint = key;
    if (s.positionTimestampMs) this.lastSourceTimestamp = s.positionTimestampMs;
    this.lastSample = s; this.reconnects = 0;
    recordTiming('accepted', s.timingProvenance, { positionMs: s.positionMs, playing: s.playing });
    logDevelopmentTiming('accepted', s);
    this.lastDeliveryObservation = s;
    this.callbacks.sample({ ...s, dealerDeliveryExperimentEnabled: this.experimentEnabled });
    return true;
  }
  private logDeliveryRejection(sample: Sample, origin: TimingContext['origin'], reason: string) {
    if (!this.experimentEnabled || (origin !== 'dealer' && origin !== 'registration')) return;
    const receipt = sample.positionObservedAt;
    const nowMono = performance.now();
    logDealerDeliveryDecision(origin === 'dealer' ? 'dealer-envelope' : 'registration-correction', {
      accepted: false, reason, playerTimestampMs: sample.positionTimestampMs,
      serverMs: sample.sourceServerTimestampMs, receiptWallMs: receipt?.wallMs,
      receiptMonotonicMs: receipt?.monotonicMs, nowMono,
      receiptAgeMs: receipt ? nowMono - receipt.monotonicMs : undefined, sampleCount: 0,
    });
  }
  private currentDeliveryIdentity(): DeliveryIdentity {
    return { device: this.orderingDeviceId ?? '', session: this.orderingSessionId ?? '',
      routeEpoch: this.deliveryRouteEpoch, authEpoch: this.deliveryAuthEpoch };
  }
  private connectIfReady() {
    if (!this.enabled || this.blocked || this.socket || this.reconnect) return;
    if (!this.token || !this.route || !this.dealer) { this.callbacks.sessionNeeded(); return; }
    if (Date.now() >= this.expiresAt - 30_000) { this.needSession('Refreshing Spotify session…'); return; }
    const run = ++this.generation;
    const url = new URL(this.dealer);
    url.searchParams.set('access_token', this.token);
    const ws = new WebSocket(url.toString());
    this.socket = ws;
    const alive = () => this.enabled && run === this.generation && this.socket === ws;
    let lastReceived = performance.now();
    this.callbacks.status('Connecting to Spotify playback…');
    this.expiry = setTimeout(() => { if (alive()) this.needSession('Refreshing Spotify session…'); }, Math.max(1, this.expiresAt - Date.now() - 30_000));
    this.heartbeat = setInterval(() => {
      if (!alive()) return;
      if (performance.now() - lastReceived > 45000) { ws.close(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
    ws.onopen = () => { if (alive()) { lastReceived = performance.now(); ws.send(JSON.stringify({ type: 'ping' })); } };
    ws.onmessage = e => {
      if (!alive()) return;
      const receivedAt = Date.now();
      const receipt = timingNow(receivedAt);
      try {
        const payload = JSON.parse(String(e.data)); lastReceived = performance.now();
        if (payload.type === 'pong') return;
        const id = connectionIdFrom(payload);
        if (id && id !== this.connectionId) { this.connectionId = id; void this.register(run, ws); }
        const decoded = decodeDealer(payload);
        const timing: TimingContext = { receipt, origin: 'dealer', connectionId: this.connectionId, generation: run };
        if (this.registered) this.emit(decoded, receivedAt, timing);
        else if (sampleFrom(decoded)) this.pendingState = { payload: decoded, receivedAt, timing };
      } catch { this.callbacks.status('A Spotify update could not be decoded; awaiting the next update.'); }
    };
    ws.onerror = () => { if (alive()) this.callbacks.status('Spotify connection interrupted; reconnecting…'); };
    ws.onclose = () => {
      if (!alive()) return;
      this.disconnect();
      if (++this.reconnects <= 3) this.reconnect = setTimeout(() => { this.reconnect = null; this.connectIfReady(); }, this.reconnects * 2000);
      else this.needSession('Reconnecting Spotify session…');
    };
  }
  private async register(run: number, ws: WebSocket) {
    const connectionId = this.connectionId;
    const requestCapture = nativeDiagnosticsEnabled ? getNativeClockCapture() : null;
    const requestStarted = nativeDiagnosticsEnabled ? performance.now() : 0;
    if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-request', { endpoint: 'connect-state-registration', method: 'PUT',
      requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null,
      registered: this.registered, cacheProvenance: 'network-request' });
    const controller = new AbortController(); this.controller?.abort(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const alive = () => this.enabled && run === this.generation && this.socket === ws && this.connectionId === connectionId;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
        'content-type': 'application/json', 'x-spotify-connection-id': this.connectionId };
      if (this.clientToken) headers['client-token'] = this.clientToken;
      const response = await fetch(this.route, { method: 'PUT', headers, body: JSON.stringify(observerBody()), signal: controller.signal });
      const headersAt = nativeDiagnosticsEnabled ? performance.now() : 0;
      if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-headers', { endpoint: 'connect-state-registration', status: response.status,
        requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null,
        currentGeneration: this.generation, alive: alive(), elapsedMs: headersAt - requestStarted });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const receipt = timingNow();
      let errorTag: string | null = null;
      if (nativeDiagnosticsEnabled && !response.ok && nativeClockCaptureActive()) {
        // Classify existing response bytes without logging the body or changing error handling.
        const text = new TextDecoder().decode(bytes.subarray(0, 8192));
        errorTag = /expired.?id/i.test(text) ? 'expired-id' : /connection.{0,8}not.{0,8}found/i.test(text) ? 'connection-not-found'
          : /device.{0,8}not.{0,8}found/i.test(text) ? 'device-not-found' : /gone/i.test(text) ? 'gone' : 'unclassified';
      }
      if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-body', { endpoint: 'connect-state-registration', status: response.status,
        requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null, currentGeneration: this.generation, alive: alive(), errorTag,
        requestMs: receipt.monotonicMs - requestStarted, bodyMs: receipt.monotonicMs - headersAt,
        bytes: bytes.length, pendingDealer: !!this.pendingState, cacheProvenance: 'network-response',
        receiptWall: receipt.wallMs, receiptMono: receipt.monotonicMs,
        responseAction: !response.ok ? 'no-state-emitted-existing-error-path' : 'pending-dealer-then-response-state' });
      if (!alive()) return;
      if (response.status === 401) { this.needSession('Spotify session expired. Refreshing login…'); return; }
      if (response.status === 403 || response.status === 429) {
        this.blocked = true; this.disconnect();
        this.callbacks.status(`Spotify observer unavailable (HTTP ${response.status}). Reconnect manually later.`); return;
      }
      if (!response.ok) { ws.close(); return; }
      this.registered = true;
      this.callbacks.status('Spotify detector connected. Play music in the Spotify app.');
      // Apply any newer Dealer anchor first, so an HTTP response that was
      // generated earlier cannot undo a pause/seek received during registration.
      const pending = this.pendingState; this.pendingState = null;
      if (pending) this.emit(pending.payload, pending.receivedAt, pending.timing);
      if (bytes.length) this.emit(decodeStateBody(bytes), undefined,
        { receipt, origin: 'registration', connectionId: this.connectionId, generation: run });
    } catch { if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-error', { endpoint: 'connect-state-registration',
      requestGeneration: run, currentGeneration: this.generation, alive: alive(), elapsedMs: performance.now() - requestStarted,
      cacheProvenance: 'no-state-emitted' }); if (alive()) ws.close(); }
    finally { clearTimeout(timeout); if (this.controller === controller) this.controller = null; }
  }
}
