import { initialSpotifyHealth, type SpotifyHealth, type SpotifyPhase, type Reachability, type CommandPhase, type SpotifyReason } from './health';
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
let nextSourceClockScope = 0;

type Callbacks = {
  sample: (sample: Sample) => void;
  status: (message: string) => void;
  sessionNeeded: () => void;
  authenticated: (token: string, expiresAt: number) => void;
  ready: () => void;
  health?: (health: SpotifyHealth) => void;
};

export class SpotifyPlaybackUnavailableError extends Error {
  constructor(message: string, readonly reason: string = 'unavailable') { super(message); }
}
export class SpotifyControlRejectedError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); }
}
export class SpotifyCommandOutcomeUnknownError extends Error {}
export type DetectorRuntime = {
  wall: () => number; mono: () => number; random: () => number;
  fetch: typeof fetch; socket: (url: string) => WebSocket;
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimeout: typeof clearTimeout;
  setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>; clearInterval: typeof clearInterval;
};
const defaultRuntime: DetectorRuntime = {
  wall: () => Date.now(), mono: () => performance.now(), random: () => Math.random(),
  fetch: (...args) => fetch(...args), socket: url => new WebSocket(url),
  setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms), clearTimeout: timer => clearTimeout(timer),
  setInterval: (handler: () => void, ms?: number) => setInterval(handler, ms), clearInterval: timer => clearInterval(timer),
};
// A valid empty/idle player state certifies observation without inventing a track.
function idleState(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 9) return false;
  const o = value as Record<string, unknown>;
  const state = o.player_state as Record<string, unknown> | undefined;
  if (state && !Array.isArray(state) && (typeof state.is_playing === 'boolean' || typeof state.is_paused === 'boolean')) return true;
  return Object.values(o).some(v => idleState(v, depth + 1));
}

function restrictedState(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 9) return false;
  const o = value as Record<string, unknown>;
  const restrictions = o.restrictions;
  if (restrictions && typeof restrictions === 'object' && Object.entries(restrictions).some(([key, value]) =>
    key.startsWith('disallow_') && (value === true || (Array.isArray(value) && value.length > 0)))) return true;
  return Object.values(o).some(v => restrictedState(v, depth + 1));
}

/** One non-playing Connect observer. Credentials/routes are memory-only.
 * No polling clock: the playback store owns interpolation between events. */
export class SpotifyDetector {
  private readonly sourceClockInstance = ++nextSourceClockScope;
  private get sourceClockScope() {
    return `${this.sourceClockInstance}:${this.deliveryAuthEpoch}:${this.deliveryRouteEpoch}`;
  }
  private token = '';
  private clientToken = '';
  private expiresAt = 0;
  private route = '';
  private dealer = '';
  private readonly deviceId: string;
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
  private observed = false;
  private currentTarget: string | undefined;
  private blocked = false;
  private restricted = false;
  private acceptCapture = true;
  private pendingState: { payload: unknown; receivedAt: number; timing: TimingContext; sourceClockScope: string } | null = null;
  private requests = new Set<AbortController>();
  private metadataCache = new Map<string, TrackMetadata>();
  private metadataPending = new Map<string, Promise<TrackMetadata>>();
  private commandPending: object | null = null;
  private phaseDeadline: ReturnType<typeof setTimeout> | null = null;
  private cooldownWall = 0;
  private cooldownMono = 0;
  private rateLimits = 0;
  private deliveryBaseline = new DealerDeliveryBaseline();
  private deliveryRouteEpoch = 0;
  private deliveryAuthEpoch = 0;
  private lastDeliveryObservation: Sample | null = null;
  private experimentEnabled = isDealerDeliveryExperimentEnabled();
  private removeExperimentListener: (() => void) | null = null;
  private phase: SpotifyPhase = 'idle';
  private reason: SpotifyReason = 'disconnected';
  private phaseStarted = 0;
  private nextRetry = 0;
  private reachability: Reachability = 'unknown';
  private activity: 'active' | 'inactive' | 'background' = 'active';
  private commandPhase: CommandPhase = 'idle';
  private confirmation: ReturnType<typeof setTimeout> | null = null;
  private confirmationBinding = '';
  private healthySince: number | null = null;
  private lastContact = 0;
  private lastState = 0;
  private targetVersion = 0;
  private manualAt = -Infinity;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectedFreshToken = false;
  private lastError: SpotifyHealth['lastError'];
  constructor(private callbacks: Callbacks, private runtime: DetectorRuntime = defaultRuntime) {
    this.deviceId = Array.from({ length: 40 }, () => Math.floor(this.runtime.random() * 16).toString(16)).join('');
  }
  get health(): SpotifyHealth {
    const target = this.observed ? this.restricted ? 'restricted' : this.currentTarget ? 'available' : 'absent' : 'unknown';
    const controlsEnabled = this.enabled && this.activity === 'active' && this.phase === 'ready' && this.registered && this.observed && !!this.currentTarget && !this.restricted && this.commandPhase === 'idle' && !this.commandPending && this.runtime.wall() < this.expiresAt - 30000 && this.cooldownRemaining() <= 0;
    return { ...initialSpotifyHealth, phase: this.phase, reason: this.reason, generation: this.generation, attempt: this.reconnects,
      phaseStartedMono: this.phaseStarted, nextRetryAtWall: this.nextRetry, retryNotBeforeWall: this.cooldownWall,
      reachability: this.reachability, appActivity: this.activity, session: this.phase === 'denied' ? 'denied' : this.phase === 'signInRequired' ? 'signInRequired' : this.phase === 'renewingSession' ? 'renewing' : this.token ? 'valid' : 'unknown',
      transportConfirmed: !!this.socket && this.socket.readyState === 1, observerConfirmed: this.registered && this.observed,
      lastContactMono: this.lastContact, lastStateReceiptMono: this.lastState, lastStateGeneration: this.observed ? this.generation : -1,
      target, targetVersion: this.targetVersion, command: this.commandPhase, controlsEnabled,
      disabledReason: controlsEnabled ? '' : this.activity !== 'active' ? 'inactive' : this.restricted ? 'restricted' : this.commandPhase !== 'idle' ? this.commandPhase : target === 'absent' ? 'noActiveDevice' : this.reason, lastError: this.lastError };
  }
  private publishHealth() { this.callbacks.health?.(this.health); }
  private transition(phase: SpotifyPhase, reason: SpotifyReason = phase) {
    if (this.phase !== phase) this.phaseStarted = this.runtime.mono();
    this.phase = phase; this.reason = reason;
    if (phase !== 'retryWait' && phase !== 'rateLimited') this.nextRetry = 0;
    this.publishHealth();
  }
  private cooldownRemaining() { return Math.max(0, this.cooldownWall - this.runtime.wall(), this.cooldownMono - this.runtime.mono()); }
  setActivity(activity: 'active' | 'inactive' | 'background') {
    this.activity = activity;
    if (activity === 'background') this.setEnabled(false);
    else if (activity === 'active' && this.enabled && this.token && this.runtime.wall() >= this.expiresAt - 30000 && this.cooldownRemaining() <= 0) this.needSession('Refreshing Spotify session…');
    else this.publishHealth();
  }
  setReachability(hint: Reachability) {
    if (hint === this.reachability) return;
    const previous = this.reachability; this.reachability = hint;
    if (this.onlineTimer) this.runtime.clearTimeout(this.onlineTimer); this.onlineTimer = null;
    if (hint === 'offline') { this.disconnect(); if (this.enabled) this.transition('offline'); return; }
    this.publishHealth();
    if (this.enabled && previous === 'offline') this.onlineTimer = this.runtime.setTimeout(() => {
      this.onlineTimer = null; this.connectIfReady();
    }, 500);
  }
  private binding() { return JSON.stringify([this.generation, this.connectionId, this.currentTarget, this.lastSample?.uri, this.lastSample?.playbackSessionId]); }
  private stateConfirmed(target: string | undefined, restricted = false) {
    this.restricted = restricted; this.observed = true; this.currentTarget = target; this.lastState = this.runtime.mono();
    this.rejectedFreshToken = false;
    if (this.phaseDeadline) this.runtime.clearTimeout(this.phaseDeadline); this.phaseDeadline = null;
    if (this.healthySince === null) this.healthySince = this.runtime.mono();
    if (this.commandPhase !== 'sending') {
      if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
      this.commandPhase = 'idle';
    }
    this.transition('ready'); this.callbacks.ready();
  }

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
      if (!this.acceptCapture) return false;
      if (new URL(origin).origin !== 'https://open.spotify.com') return false;
      const e = JSON.parse(raw);
      if (e.type === 'notice' && e.message === 'Android observer registration failed. Reconnect Spotify to retry.' && !this.registered) {
        this.callbacks.status(e.message); return true;
      }
      if (e.type === 'session' && ['anonymous', 'denied', 'unavailable'].includes(e.state)) {
        if (this.phase !== 'renewingSession') return true;
        if (e.state === 'anonymous' || e.state === 'denied') {
          this.disconnect(); this.token = ''; this.transition('signInRequired', 'sessionChallenge');
        } else { this.retryObservation(); }
        return true;
      }
      if (e.type === 'credentials' && e.authenticated === true && typeof e.token === 'string' && e.token.length > 0 && e.token.length < 4096) {
        if (this.phase === 'signInRequired') return true;
        const changed = e.token !== this.token;
        if (changed) { this.deliveryAuthEpoch++; this.deliveryBaseline.clear(); this.lastDeliveryObservation = null; }
        this.token = e.token;
        if (typeof e.clientToken === 'string' && e.clientToken.length < 4096) this.clientToken = e.clientToken;
        let expiresAt = Number(e.expiresAt) || 0;
        if (!expiresAt) { try { expiresAt = Number(JSON.parse(Buffer.from(e.token.split('.')[1], 'base64').toString()).exp) * 1000 || 0; } catch {} }
        // Opaque tokens cannot live forever just because the capture omitted expiry.
        this.expiresAt = expiresAt || (changed || !this.expiresAt ? this.runtime.wall() + 45 * 60_000 : this.expiresAt);
        if (this.expiresAt <= this.runtime.wall() + 30000) { this.token = ''; this.retryObservation(); return true; }
        if (this.renewalTimer) this.runtime.clearTimeout(this.renewalTimer); this.renewalTimer = null;
        this.callbacks.authenticated(this.token, this.expiresAt);
        if (changed && this.socket) this.disconnect();
        if (this.phase === 'renewingSession') this.transition('connecting');
        this.connectIfReady();
        return true;
      }
      if (e.type === 'observerEndpoint' && typeof e.url === 'string') {
        const route = observerEndpoint(e.url, this.deviceId);
        if (route) {
          if (this.route !== route) { this.deliveryRouteEpoch++; this.deliveryBaseline.clear(); this.lastDeliveryObservation = null; }
          this.route = route; this.discoveryReady(); this.connectIfReady(); return true;
        }
      }
      if (e.type === 'socket' && typeof e.url === 'string' && spotifyHost(e.url, true) && /(^|\.)[^.]*dealer[^.]*\./i.test(new URL(e.url).hostname)) {
        if (this.dealer !== e.url) { this.deliveryRouteEpoch++; this.deliveryBaseline.clear(); this.lastDeliveryObservation = null; }
        this.dealer = e.url; this.discoveryReady(); this.connectIfReady(); return true;
      }
    } catch { /* Ignore untrusted/malformed bridge data. */ }
    return false;
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) { if (enabled) this.connectIfReady(); return; }
    this.enabled = enabled;
    if (enabled) this.acceptCapture = true;
    if (enabled && this.phase === 'renewingSession' && !this.renewalTimer) this.transition('connecting');
    if (enabled) {
      this.listenForExperimentToggle();
      // Returning from suspension reprojects the last authoritative anchor.
      if (this.lastSample) {
        recordTiming('foreground-replay', this.lastSample.timingProvenance);
        logDevelopmentTiming('foreground-replay', this.lastSample);
        // Keep legacy fallback behavior; immutable provenance retains original receipt.
        this.callbacks.sample({ ...this.lastSample, receivedAt: this.runtime.wall(),
          // A cached replay cannot certify a newly authenticated/routed source.
          sourceClockScope: this.lastSample.sourceClockScope === this.sourceClockScope ? this.sourceClockScope : undefined,
          dealerDeliveryExperimentEnabled: this.experimentEnabled });
      }
      this.connectIfReady();
    } else { this.disconnect(); this.transition('suspended'); }
  }
  refresh(explicit = false) {
    if (!this.enabled || this.reachability === 'offline' || (explicit && this.activity !== 'active')) return;
    if (this.onlineTimer || (this.socket && !this.observed)) return;
    if (explicit && this.runtime.mono() - this.manualAt < 2000) return;
    if (explicit) { this.manualAt = this.runtime.mono(); this.rejectedFreshToken = false; }
    if (this.cooldownRemaining() > 0) { this.connectIfReady(); return; }
    if (!explicit && (this.blocked || this.phase === 'retryWait' || this.phase === 'renewingSession')) return;
    if (!explicit && this.socket && !this.observed) return;
    if (nativeDiagnosticsEnabled && nativeClockCaptureActive()) emitNativeClockDiagnostic('detector-refresh-before', {
      generation: this.generation, reason: 'explicit-refresh', registered: this.registered, experiment: this.experimentEnabled,
      ...this.deliveryBaseline.diagnosticSummary() });
    this.deliveryBaseline.preserveForExplicitRefresh(this.runtime.mono(), this.currentDeliveryIdentity());
    if (nativeDiagnosticsEnabled && nativeClockCaptureActive()) emitNativeClockDiagnostic('detector-refresh-preserved', {
      generation: this.generation, ...this.deliveryBaseline.diagnosticSummary() });
    this.blocked = false;
    if (explicit && (this.phase === 'signInRequired' || this.phase === 'denied')) this.transition('connecting');
    this.resetOrdering();
    this.disconnect(true); this.connectIfReady();
  }
  clear() {
    this.acceptCapture = false; this.enabled = false; this.disconnect(); this.token = ''; this.clientToken = '';
    this.route = ''; this.dealer = ''; this.expiresAt = 0; this.lastSample = null;
    this.deliveryBaseline.clear(); this.lastDeliveryObservation = null;
    this.deliveryAuthEpoch++;
    this.removeExperimentListener?.(); this.removeExperimentListener = null;
    this.resetOrdering();
    this.blocked = false; this.cooldownWall = 0; this.cooldownMono = 0; this.rateLimits = 0;
    this.metadataCache.clear(); this.metadataPending.clear();
    this.reconnects = 0; this.rejectedFreshToken = false; this.commandPhase = 'idle';
    this.transition('idle');
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
    if (this.commandPending) throw new SpotifyPlaybackUnavailableError('Waiting for the previous Spotify command.', 'sending');
    const target = this.currentTarget;
    if (!this.health.controlsEnabled || !target) throw new SpotifyPlaybackUnavailableError('Spotify controls are unavailable until current playback is confirmed.', this.health.disabledReason);
    if (command.type === 'seek' && !Number.isFinite(command.positionMs)) throw new Error('Invalid seek position.');
    const endpoint = { toggle: this.lastSample?.playing ? 'pause' : 'resume', previous: 'skip_prev', next: 'skip_next', seek: 'seek_to' }[command.type];
    // Route to the device observed by Dealer, not a newly mounted web player.
    const from = new URL(this.route).pathname.split('/').pop()!;
    const path = `/connect-state/v1/player/command/from/${encodeURIComponent(from)}/to/${encodeURIComponent(target)}`;
    const value = command.type === 'seek' ? Math.round(Math.max(0, Math.min(this.lastSample!.durationMs || Infinity, command.positionMs!))) : undefined;
    const body = { command: { endpoint, ...(value !== undefined ? { value } : {}),
      options: { only_for_local_device: false, system_initiated: false, override_restrictions: false } },
      connection_type: 'wlan', intent_id: Array.from({ length: 32 }, () => Math.floor(this.runtime.random() * 16).toString(16)).join('') };
    const commandId = {}; this.commandPending = commandId;
    const binding = this.binding(); const run = this.generation;
    this.commandPhase = 'sending'; this.publishHealth();
    try {
      await this.request(path, 'POST', body);
      if (this.commandPending !== commandId || binding !== this.binding()) throw new SpotifyCommandOutcomeUnknownError('Spotify target changed; playback outcome unknown.');
      this.commandPhase = 'awaitingConfirmation'; this.confirmationBinding = binding;
      this.publishHealth();
      this.confirmation = this.runtime.setTimeout(() => {
        this.confirmation = null;
        if (run === this.generation && this.confirmationBinding === binding) {
          this.commandPhase = 'outcomeUnknown'; this.retryObservation();
        }
      }, 5000);
      this.callbacks.status(`Spotify ${endpoint} accepted; awaiting the device update.`);
    } catch (error) {
      if (error instanceof SpotifyControlRejectedError || error instanceof SpotifyPlaybackUnavailableError) {
        if (this.commandPending === commandId) this.commandPhase = 'idle';
        throw error;
      }
      if (this.commandPending === commandId) {
        this.commandPhase = 'outcomeUnknown'; this.retryObservation();
      }
      throw new SpotifyCommandOutcomeUnknownError('Playback outcome unknown. Checking Spotify; command will not be replayed.');
    } finally { if (this.commandPending === commandId) this.commandPending = null; this.publishHealth(); }
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Uint8Array> {
    if (!this.enabled || this.blocked || !this.token || !this.route || !this.connectionId) throw new Error('Spotify session is not ready.');
    const run = this.generation; const requestConnection = this.connectionId;
    const started = nativeDiagnosticsEnabled ? this.runtime.mono() : 0;
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = this.runtime.setTimeout(() => controller.abort(), 10000);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
      'x-spotify-connection-id': this.connectionId };
    if (this.clientToken) headers['client-token'] = this.clientToken;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-encoding'] = 'gzip'; }
    try {
      const response = await this.bounded(this.runtime.fetch(new URL(path, this.route).toString(), { method, headers, signal: controller.signal,
        ...(body !== undefined ? { body: Uint8Array.from(gzip(JSON.stringify(body))).buffer } : {}) }), controller);
      if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('spotify-http-response', { endpoint: method === 'GET' ? 'metadata' : 'player-control',
        method, status: response.status, requestGeneration: run, currentGeneration: this.generation,
        elapsedMs: this.runtime.mono() - started, staleGeneration: run !== this.generation, cacheProvenance: 'network-response' });
      if (run !== this.generation || requestConnection !== this.connectionId) throw new Error('Spotify session changed during request.');
      if (method === 'POST' && !response.ok) { this.commandPending = null; this.commandPhase = 'idle'; }
      if (response.status === 401) this.needSession('Spotify session expired. Refreshing login…', true);
      if (response.status === 429) this.rateLimited(response);
      if (method === 'POST' && response.status === 403) { this.restricted = true; this.publishHealth(); }
      if (method === 'POST' && response.status === 404) { this.retryObservation(); throw new SpotifyPlaybackUnavailableError('Spotify playback target changed. Restoring observation; command was not retried.'); }
      if (!response.ok) throw new SpotifyControlRejectedError(`Spotify ${method === 'GET' ? 'metadata' : 'control'} HTTP ${response.status}.`, response.status);
      // Read while the abort/timeout is still installed, including slow bodies.
      const bytes = await this.bounded(response.arrayBuffer(), controller);
      if (run !== this.generation || requestConnection !== this.connectionId) throw new Error('Spotify session changed during response.');
      return new Uint8Array(bytes);
    } finally { this.runtime.clearTimeout(timeout); this.requests.delete(controller); }
  }
  private disconnect(preserveDeliveryBaseline = false) {
    this.generation++;
    if (this.commandPending || this.commandPhase === 'awaitingConfirmation') this.commandPhase = 'outcomeUnknown';
    this.commandPending = null;
    this.healthySince = null;
    if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
    if (this.onlineTimer) this.runtime.clearTimeout(this.onlineTimer); this.onlineTimer = null;
    if (this.renewalTimer) this.runtime.clearTimeout(this.renewalTimer); this.renewalTimer = null;
    if (this.phaseDeadline) this.runtime.clearTimeout(this.phaseDeadline); this.phaseDeadline = null;
    if (!preserveDeliveryBaseline) this.deliveryBaseline.clear();
    this.controller?.abort(); this.controller = null;
    for (const controller of this.requests) controller.abort();
    this.requests.clear(); this.metadataPending.clear();
    if (this.heartbeat) this.runtime.clearInterval(this.heartbeat);
    if (this.reconnect) this.runtime.clearTimeout(this.reconnect);
    if (this.expiry) this.runtime.clearTimeout(this.expiry);
    this.heartbeat = null; this.reconnect = null; this.expiry = null;
    const ws = this.socket; this.socket = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; try { ws.close(); } catch {} }
    this.connectionId = ''; this.registered = false; this.observed = false; this.currentTarget = undefined; this.pendingState = null;
    this.publishHealth();
  }
  private needSession(message: string, unauthorized = false) {
    if (unauthorized && this.rejectedFreshToken) {
      this.disconnect(); this.token = ''; this.transition('signInRequired', 'freshTokenRejected'); return;
    }
    if (unauthorized) this.rejectedFreshToken = true;
    this.disconnect(); this.token = ''; this.expiresAt = 0;
    this.deliveryAuthEpoch++; this.lastDeliveryObservation = null;
    if (!this.enabled || this.reachability === 'offline') return;
    this.transition('renewingSession');
    this.callbacks.status(message); this.callbacks.sessionNeeded();
    this.renewalTimer = this.runtime.setTimeout(() => {
      this.renewalTimer = null;
      if (this.phase !== 'renewingSession') return;
      this.retryObservation();
    }, 45000);
  }
  private resetOrdering() {
    this.fingerprint = ''; this.lastSourceTimestamp = 0;
    this.orderingDeviceId = undefined; this.orderingSessionId = undefined; this.lastDealerConnection = '';
  }
  private emit(payload: unknown, receivedAt = this.runtime.wall(), timing: TimingContext = {}, authorityScope = this.sourceClockScope) {
    const s = sampleFrom(payload, 0, timing);
    if (!s || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(s.uri)) { if (idleState(payload)) { this.stateConfirmed(undefined); return true; } return false; }
    if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('source-candidate', { origin: timing.origin ?? 'unknown', generation: timing.generation,
      rawPosition: s.positionMs, playerTimestamp: s.positionTimestampMs, serverTimestamp: s.sourceServerTimestampMs,
      receiptWall: timing.receipt?.wallMs, receiptMono: timing.receipt?.monotonicMs, receivedAt,
      playing: s.playing, experiment: this.experimentEnabled,
      ...this.deliveryBaseline.diagnosticSummary() });
    s.receivedAt = receivedAt;
    // Reconnect generations do not change source authority. Positive auth/route
    // changes and a new detector instance do; never compare their raw anchors.
    s.sourceClockScope = authorityScope === this.sourceClockScope ? authorityScope : undefined;
    if (s.sourceServerTimestampMs !== undefined) s.positionObservedAt = timing.receipt ?? timingNow(receivedAt);
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
      this.stateConfirmed(s.activeDeviceId, restrictedState(payload));
      this.logDeliveryRejection(s, timing.origin, 'source-timestamp-older-than-watermark');
      logDevelopmentTiming('stale', s);
      recordTiming('stale', s.timingProvenance); return true;
    }
    if (this.currentTarget !== s.activeDeviceId || this.lastSample?.uri !== s.uri || this.lastSample?.playbackSessionId !== s.playbackSessionId) this.targetVersion++;
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
          receipt: s.positionObservedAt, nowMono: this.runtime.mono(), identity: deliveryIdentity }
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
    if (key === this.fingerprint) { this.stateConfirmed(s.activeDeviceId, restrictedState(payload)); logDevelopmentTiming('duplicate', s); recordTiming('duplicate', s.timingProvenance); return true; }
    this.fingerprint = key;
    if (s.positionTimestampMs) this.lastSourceTimestamp = s.positionTimestampMs;
    this.lastSample = s;
    this.stateConfirmed(s.activeDeviceId, restrictedState(payload));
    recordTiming('accepted', s.timingProvenance, { positionMs: s.positionMs, playing: s.playing });
    logDevelopmentTiming('accepted', s);
    this.lastDeliveryObservation = s;
    this.callbacks.sample({ ...s, dealerDeliveryExperimentEnabled: this.experimentEnabled });
    return true;
  }
  private logDeliveryRejection(sample: Sample, origin: TimingContext['origin'], reason: string) {
    if (!this.experimentEnabled || (origin !== 'dealer' && origin !== 'registration')) return;
    const receipt = sample.positionObservedAt;
    const nowMono = this.runtime.mono();
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
  private discoveryReady() {
    if (this.phase === 'renewingSession' && this.token && this.route && this.dealer) {
      if (this.renewalTimer) this.runtime.clearTimeout(this.renewalTimer); this.renewalTimer = null; this.transition('connecting');
    }
  }
  private connectIfReady() {
    if (!this.enabled || this.blocked || this.socket || this.reconnect || this.phase === 'signInRequired' || this.phase === 'renewingSession' || this.onlineTimer) return;
    if (this.reachability === 'offline') { this.transition('offline'); return; }
    const wait = this.cooldownRemaining();
    if (wait > 0) { this.transition('rateLimited'); this.reconnect = this.runtime.setTimeout(() => { this.reconnect = null; this.connectIfReady(); }, Math.min(wait, 2147483647)); return; }
    if (!this.token) { this.needSession('Refreshing Spotify session…'); return; }
    if (!this.route || !this.dealer) { this.transition('renewingSession', 'discoveringRoutes'); this.callbacks.sessionNeeded(); this.renewalTimer = this.runtime.setTimeout(() => this.retryObservation(), 45000); return; }
    if (this.runtime.wall() >= this.expiresAt - 30_000) { this.needSession('Refreshing Spotify session…'); return; }
    const run = ++this.generation;
    this.transition('connecting');
    const sourceClockScope = this.sourceClockScope;
    const url = new URL(this.dealer);
    url.searchParams.set('access_token', this.token);
    let ws: WebSocket;
    try { ws = this.runtime.socket(url.toString()); } catch { this.retryObservation(); return; }
    this.socket = ws;
    this.armPhaseDeadline();
    const alive = () => this.enabled && run === this.generation && this.socket === ws;
    let lastReceived = this.runtime.mono();
    this.callbacks.status('Connecting to Spotify playback…');
    this.expiry = this.runtime.setTimeout(() => { if (alive()) this.needSession('Refreshing Spotify session…'); }, Math.max(1, this.expiresAt - this.runtime.wall() - 30_000));
    this.heartbeat = this.runtime.setInterval(() => {
      if (!alive()) return;
      if (this.runtime.mono() - lastReceived >= 45000) { this.retryObservation(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
    ws.onopen = () => { if (alive()) { lastReceived = this.runtime.mono(); this.armPhaseDeadline(); ws.send(JSON.stringify({ type: 'ping' })); } };
    ws.onmessage = e => {
      if (!alive()) return;
      const receivedAt = this.runtime.wall();
      const receipt = timingNow(receivedAt);
      try {
        const payload = JSON.parse(String(e.data));
        const id = connectionIdFrom(payload);
        const decoded = decodeDealer(payload);
        if (payload.type !== 'pong' && !id && !sampleFrom(decoded) && !idleState(decoded)) return;
        lastReceived = this.runtime.mono(); this.lastContact = lastReceived;
        if (this.healthySince !== null && lastReceived - this.healthySince >= 60000) { this.reconnects = 0; this.rateLimits = 0; }
        if (payload.type === 'pong') return;
        if (id && id !== this.connectionId) { this.registered = false; this.observed = false; this.currentTarget = undefined; this.pendingState = null;
          if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
          if (this.commandPending || this.commandPhase === 'awaitingConfirmation') this.commandPhase = 'outcomeUnknown';
          this.commandPending = null; for (const request of this.requests) request.abort();
          this.connectionId = id; this.transition('registering'); this.armPhaseDeadline(); void this.register(run, ws, sourceClockScope); }
        const timing: TimingContext = { receipt, origin: 'dealer', connectionId: this.connectionId, generation: run };
        if (this.registered) this.emit(decoded, receivedAt, timing, sourceClockScope);
        else if (sampleFrom(decoded) || idleState(decoded)) this.pendingState = { payload: decoded, receivedAt, timing, sourceClockScope };
      } catch { this.callbacks.status('A Spotify update could not be decoded; awaiting the next update.'); }
    };
    ws.onerror = () => { if (alive()) this.retryObservation(); };
    ws.onclose = () => { if (alive()) this.retryObservation(); };
  }
  private armPhaseDeadline() {
    if (this.phaseDeadline) this.runtime.clearTimeout(this.phaseDeadline);
    this.phaseDeadline = this.runtime.setTimeout(() => { this.retryObservation(); this.lastError = { category: 'timeout', occurredAtWall: this.runtime.wall() }; this.publishHealth(); }, 10000);
  }
  private retryObservation() {
    this.lastError = { category: 'transport', occurredAtWall: this.runtime.wall() };
    this.disconnect();
    if (!this.enabled || this.blocked) return;
    if (this.reachability === 'offline') { this.transition('offline'); return; }
    const attempt = this.reconnects++;
    const delay = attempt < 5 ? Math.min(30000, 2000 * 2 ** attempt * (0.8 + this.runtime.random() * 0.4)) : 60000;
    this.nextRetry = this.runtime.wall() + delay; this.transition('retryWait');
    this.callbacks.status('Spotify connection lost; retrying automatically.');
    this.reconnect = this.runtime.setTimeout(() => { this.reconnect = null; this.transition('connecting'); this.connectIfReady(); }, delay);
  }
  private rateLimited(response: Response) {
    const value = response.headers?.get('retry-after');
    const seconds = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : NaN;
    const serverDate = Date.parse(response.headers?.get('date') || '');
    const parsed = value ? Date.parse(value) - (Number.isFinite(serverDate) ? serverDate : this.runtime.wall()) : NaN;
    const duration = Math.max(1000, Number.isFinite(seconds) ? seconds : Number.isFinite(parsed) ? parsed : Math.min(300000, 30000 * 2 ** Math.min(this.rateLimits++, 4) * (1 + this.runtime.random() * 0.2)));
    this.cooldownWall = Math.max(this.cooldownWall, this.runtime.wall() + duration);
    this.cooldownMono = Math.max(this.cooldownMono, this.runtime.mono() + duration);
    this.nextRetry = this.cooldownWall;
    this.disconnect(); this.lastError = { category: 'rateLimit', httpStatus: 429, occurredAtWall: this.runtime.wall() }; this.transition('rateLimited');
    this.callbacks.status('Spotify HTTP 429: limiting requests; waiting before reconnecting.');
    this.connectIfReady();
  }
  private bounded<T>(work: Promise<T>, controller: AbortController): Promise<T> {
    let cleanup = () => {};
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('Spotify request interrupted; playback outcome may be unknown.'));
      const timer = this.runtime.setTimeout(() => { controller.abort(); abort(); }, 10000);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      cleanup = () => { this.runtime.clearTimeout(timer); controller.signal.removeEventListener('abort', abort); };
      work.then(resolve, reject);
    }).finally(() => cleanup());
  }

  private async register(run: number, ws: WebSocket, sourceClockScope = this.sourceClockScope) {
    const connectionId = this.connectionId;
    const requestCapture = nativeDiagnosticsEnabled ? getNativeClockCapture() : null;
    const requestStarted = nativeDiagnosticsEnabled ? this.runtime.mono() : 0;
    if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-request', { endpoint: 'connect-state-registration', method: 'PUT',
      requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null,
      registered: this.registered, cacheProvenance: 'network-request' });
    const controller = new AbortController(); this.controller?.abort(); this.controller = controller;
    const timeout = this.runtime.setTimeout(() => controller.abort(), 10000);
    const alive = () => this.enabled && run === this.generation && this.socket === ws && this.connectionId === connectionId;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
        'content-type': 'application/json', 'x-spotify-connection-id': this.connectionId };
      if (this.clientToken) headers['client-token'] = this.clientToken;
      const response = await this.bounded(this.runtime.fetch(this.route, { method: 'PUT', headers, body: JSON.stringify(observerBody()), signal: controller.signal }), controller);
      if (!alive()) return;
      if (response.status === 401) { this.needSession('Spotify session expired. Refreshing login…', true); return; }
      if (response.status === 429) { this.rateLimited(response); return; }
      if (response.status === 403) { this.blocked = true; this.disconnect(); this.lastError = { category: 'denied', httpStatus: 403, occurredAtWall: this.runtime.wall() }; this.transition('denied'); return; }
      const headersAt = nativeDiagnosticsEnabled ? this.runtime.mono() : 0;
      if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-headers', { endpoint: 'connect-state-registration', status: response.status,
        requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null,
        currentGeneration: this.generation, alive: alive(), elapsedMs: headersAt - requestStarted });
      const bytes = new Uint8Array(await this.bounded(response.arrayBuffer(), controller));
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
      if (!response.ok) { this.retryObservation(); return; }
      this.registered = true; this.armPhaseDeadline();
      this.callbacks.status('Spotify detector connected. Play music in the Spotify app.');
      // Apply any newer Dealer anchor first, so an HTTP response that was
      // generated earlier cannot undo a pause/seek received during registration.
      const pending = this.pendingState; this.pendingState = null;
      if (pending) this.emit(pending.payload, pending.receivedAt, pending.timing, pending.sourceClockScope);
      if (bytes.length) this.emit(decodeStateBody(bytes), undefined,
        { receipt, origin: 'registration', connectionId: this.connectionId, generation: run }, sourceClockScope);
    } catch { if (nativeDiagnosticsEnabled) emitNativeClockDiagnostic('registration-error', { endpoint: 'connect-state-registration',
      requestGeneration: run, currentGeneration: this.generation, alive: alive(), elapsedMs: this.runtime.mono() - requestStarted,
      cacheProvenance: 'no-state-emitted' }); if (alive()) this.retryObservation(); }
    finally { this.runtime.clearTimeout(timeout); if (this.controller === controller) this.controller = null; }
  }
}
