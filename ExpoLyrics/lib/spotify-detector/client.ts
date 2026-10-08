import { Buffer } from 'buffer';
import { gzip } from 'pako';
import { connectionIdFrom, decodeDealer, decodeStateBody, observerBody, observerEndpoint,
  sampleFrom, spotifyHost, stateFingerprint, trackHex, metadataFrom, type TrackMetadata, type Sample } from './protocol';

type Callbacks = {
  sample: (sample: Sample) => void;
  status: (message: string) => void;
  sessionNeeded: () => void;
  authenticated: (token: string, expiresAt: number) => void;
  ready: () => void;
};

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
  private registered = false;
  private blocked = false;
  private pendingState: { payload: unknown; receivedAt: number } | null = null;
  private requests = new Set<AbortController>();
  private metadataCache = new Map<string, TrackMetadata>();
  private metadataPending = new Map<string, Promise<TrackMetadata>>();
  private commandPending = false;
  constructor(private callbacks: Callbacks) {}

  capture(raw: string, origin: string): boolean {
    try {
      if (new URL(origin).origin !== 'https://open.spotify.com') return false;
      const e = JSON.parse(raw);
      if (e.type === 'credentials' && e.authenticated === true && typeof e.token === 'string' && e.token.length > 0 && e.token.length < 4096) {
        const changed = e.token !== this.token;
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
        if (route) { this.route = route; this.connectIfReady(); return true; }
      }
      if (e.type === 'socket' && typeof e.url === 'string' && spotifyHost(e.url, true) && /(^|\.)[^.]*dealer[^.]*\./i.test(new URL(e.url).hostname)) {
        this.dealer = e.url; this.connectIfReady(); return true;
      }
    } catch { /* Ignore untrusted/malformed bridge data. */ }
    return false;
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      // Returning from suspension reprojects the last authoritative anchor.
      if (this.lastSample) this.callbacks.sample({ ...this.lastSample, receivedAt: Date.now() });
      this.connectIfReady();
    } else this.disconnect();
  }
  refresh() {
    this.blocked = false;
    this.fingerprint = ''; this.lastSourceTimestamp = 0; this.reconnects = 0;
    this.disconnect(); this.connectIfReady();
  }
  clear() {
    this.enabled = false; this.disconnect(); this.token = ''; this.clientToken = '';
    this.route = ''; this.dealer = ''; this.expiresAt = 0; this.lastSample = null;
    this.fingerprint = ''; this.lastSourceTimestamp = 0;
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
    if (!this.enabled || !this.registered || !target) throw new Error('Spotify detector is reconnecting; try again when a device is detected.');
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
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
      'x-spotify-connection-id': this.connectionId };
    if (this.clientToken) headers['client-token'] = this.clientToken;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-encoding'] = 'gzip'; }
    try {
      const response = await fetch(new URL(path, this.route).toString(), { method, headers, signal: controller.signal,
        ...(body !== undefined ? { body: Uint8Array.from(gzip(JSON.stringify(body))).buffer } : {}) });
      if (run !== this.generation) throw new Error('Spotify session changed during request.');
      if (response.status === 401) this.needSession('Spotify session expired. Refreshing login…');
      if (response.status === 429) { this.blocked = true; this.disconnect(); }
      if (!response.ok) throw new Error(`Spotify ${method === 'GET' ? 'metadata' : 'control'} HTTP ${response.status}.`);
      // Read while the abort/timeout is still installed, including slow bodies.
      const bytes = await response.arrayBuffer();
      if (run !== this.generation) throw new Error('Spotify session changed during response.');
      return new Uint8Array(bytes);
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  private disconnect() {
    this.generation++;
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
    this.callbacks.status(message); this.callbacks.sessionNeeded();
  }
  private emit(payload: unknown, receivedAt = Date.now()) {
    const s = sampleFrom(payload);
    if (!s || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(s.uri)) return false;
    s.receivedAt = receivedAt;
    // Session renewal can return an identical authoritative anchor. It still
    // proves that the new observer is ready, without resetting the lyrics clock.
    this.callbacks.ready();
    // Old registration snapshots must never rewind a more recent Dealer event.
    if (s.positionTimestampMs && s.positionTimestampMs < this.lastSourceTimestamp) return true;
    const key = stateFingerprint(s);
    if (key === this.fingerprint) return true;
    this.fingerprint = key;
    if (s.positionTimestampMs) this.lastSourceTimestamp = s.positionTimestampMs;
    this.lastSample = s; this.reconnects = 0;
    this.callbacks.sample(s);
    return true;
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
      try {
        const payload = JSON.parse(String(e.data)); lastReceived = performance.now();
        if (payload.type === 'pong') return;
        const id = connectionIdFrom(payload);
        if (id && id !== this.connectionId) { this.connectionId = id; void this.register(run, ws); }
        const decoded = decodeDealer(payload);
        if (this.registered) this.emit(decoded, receivedAt);
        else if (sampleFrom(decoded)) this.pendingState = { payload: decoded, receivedAt };
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
    const controller = new AbortController(); this.controller?.abort(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const alive = () => this.enabled && run === this.generation && this.socket === ws;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
        'content-type': 'application/json', 'x-spotify-connection-id': this.connectionId };
      if (this.clientToken) headers['client-token'] = this.clientToken;
      const response = await fetch(this.route, { method: 'PUT', headers, body: JSON.stringify(observerBody()), signal: controller.signal });
      const bytes = new Uint8Array(await response.arrayBuffer());
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
      if (pending) this.emit(pending.payload, pending.receivedAt);
      if (bytes.length) this.emit(decodeStateBody(bytes));
    } catch { if (alive()) ws.close(); }
    finally { clearTimeout(timeout); if (this.controller === controller) this.controller = null; }
  }
}
