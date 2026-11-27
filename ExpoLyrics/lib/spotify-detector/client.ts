import type { PlaybackCommandState } from '../playback-command-queue';
import { initialSpotifyHealth, type SpotifyHealth, type SpotifyPhase, type Reachability, type CommandPhase, type SpotifyReason, type SpotifyDisabledReason, type SpotifyAllowedControls } from './health';
import { Buffer } from 'buffer';
import { gzip } from 'pako';
import { connectionIdFrom, decodeDealer, decodeStateBody, observerBody, observerEndpoint,
  sampleFrom, sampleWithContext, projectedPosition, type SelectedPlayerContext, spotifyHost, stateFingerprint, trackHex, metadataFrom, type TrackMetadata, type Sample } from './protocol';
import { timingNow, type TimingContext } from './timing-clock';
import { DealerDeliveryBaseline, type DeliveryIdentity } from './dealer-delivery-baseline';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativeClockDiagnostics = typeof __DEV__ !== 'undefined' && __DEV__ ? require('../native-clock-diagnostics') as typeof import('../native-clock-diagnostics') : null;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const deliveryDiagnostics = typeof __DEV__ !== 'undefined' && __DEV__ ? require('./dealer-delivery-experiment-log') as typeof import('./dealer-delivery-experiment-log') : null;
const nativeDiagnosticsEnabled = typeof __DEV__ !== 'undefined' && __DEV__;
let nextSourceClockScope = 0;
const TRANSPORT_DEADLINE_MS = 5000;
const CACHED_CONNECT_DEADLINE_MS = 1500;
const SESSION_DEADLINE_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 10000;
const PONG_DEADLINE_MS = 5000;
const PONG_TIMER_GRACE_MS = 1000;
const CONTROL_EXPIRY_MARGIN_MS = 30000;
const SESSION_RENEWAL_MARGIN_MS = 60000;
const SNAPSHOT_PLAYING_MS = 15000;
const RECONCILE_RETRY_MS = 500;
const SNAPSHOT_PAUSED_MS = 30000;
const SNAPSHOT_IDLE_MS = 60000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const timingDiagnostics = typeof __DEV__ !== 'undefined' && __DEV__ ? require('./timing-diagnostics') as typeof import('./timing-diagnostics') : null;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const developmentTimingLog = typeof __DEV__ !== 'undefined' && __DEV__ ? require('./development-timing-log') as typeof import('./development-timing-log') : null;

type Callbacks = {
  sample: (sample: Sample) => void;
  status: (message: string) => void;
  sessionNeeded: (captureId: number) => void;
  sessionFinished?: (captureId: number) => void;
  authenticated: (token: string, expiresAt: number) => void;
  ready: () => void;
  health?: (health: SpotifyHealth) => void;
};

type Credentials = { token: string; clientToken: string; expiresAt: number };

function credentialSubject(token: string): string | undefined {
  try {
    const subject: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
    return typeof subject === 'string' && subject ? subject : undefined;
  } catch {
    return undefined;
  }
}
type ReconnectSession = Credentials & { route: string; dealer: string };
type SignInReason = Extract<SpotifyReason, 'freshTokenRejected' | 'sessionChallenge'>;
type PendingSession = {
  id: number;
  soft: boolean;
  resetOrdering: boolean;
  credentials?: Credentials;
  route?: string;
  dealer?: string;
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
  if (Array.isArray(value)) return value.some(v => idleState(v, depth + 1));
  const o = value as Record<string, unknown>;
  if ('player_state' in o) {
    const state = o.player_state as Record<string, unknown> | null;
    // A narrow recognizable idle envelope, not an empty-200 heuristic. Real
    // no-device response variants still require capture/validation on a phone.
    return !!state && typeof state === 'object' && !Array.isArray(state) &&
      !o.active_device_id && !o.activeDeviceId && !state.track && !state.item && !state.track_window &&
      (state.is_paused === true || state.is_playing === false);
  }
  return ['cluster', 'payloads', 'state', 'data'].some(key => idleState(o[key], depth + 1));
}

type Operation = keyof SpotifyAllowedControls;
export type SpotifyRestrictions = Partial<Record<Operation, boolean>>;
const reasonOperations: Record<string, Operation[]> = {
  disallow_pausing_reasons: ['pause'], disallow_resuming_reasons: ['resume'],
  disallow_skipping_next_reasons: ['next'], disallow_skipping_prev_reasons: ['previous'],
  disallow_seeking_reasons: ['seek'], disallow_playing_reasons: ['resume'],
  disallow_remote_control_reasons: ['resume', 'pause', 'next', 'previous', 'seek'],
};
function selectedRestrictions(selected: SelectedPlayerContext) {
  const blocked: SpotifyRestrictions = {};
  const reasons: Record<string, string[]> = {};
  for (const source of [selected.playerState?.restrictions, selected.cluster?.restrictions]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, operations] of Object.entries(reasonOperations)) {
      const value = source[key];
      const entries = Array.isArray(value) ? value.filter((v: unknown): v is string => typeof v === 'string' && !!v) :
        typeof value === 'string' && value ? [value] : value === true ? ['true'] : [];
      if (!entries.length) continue;
      reasons[key] = [...new Set([...(reasons[key] ?? []), ...entries])].sort();
      for (const operation of operations) blocked[operation] = true;
    }
  }
  const owner = selected.cluster;
  const id = selected.sample.activeDeviceId;
  let deviceRestricted = false;
  if (owner && typeof id === 'string' && id) {
    for (const devices of [owner.devices, owner.device]) {
      if (!devices || typeof devices !== 'object') continue;
      const device = Array.isArray(devices) ? devices.find(d => (d?.id ?? d?.device_id ?? d?.device_info?.device_id) === id) : devices[id];
      if (device?.is_restricted === true || device?.device_info?.is_restricted === true) deviceRestricted = true;
    }
  }
  const signature = JSON.stringify([deviceRestricted, Object.keys(reasonOperations).map(k => reasons[k] ?? [])]);
  return {blocked, deviceRestricted, signature};
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
  private reconnectSession: ReconnectSession | null = null;
  private connectingWithCachedSession = false;
  private cachedFallbackPending = false;
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
  private dealerStateRevision = 0;
  private registered = false;
  private observed = false;
  private currentTarget: string | undefined;
  private blocked = false;
  private signInReason: SignInReason | null = null;
  private deviceRestricted = false;
  private payloadRestrictions: SpotifyRestrictions = {};
  private blockedOperations = new Set<Operation>();
  private restrictionSignature = '';
  private acceptedAuthority = '';
  private captureId = 0;
  private pendingSession: PendingSession | null = null;
  private pendingState: { payload: unknown; receivedAt: number; timing: TimingContext; sourceClockScope: string } | null = null;
  private requests = new Set<AbortController>();
  private metadataCache = new Map<string, TrackMetadata>();
  private metadataPending = new Map<string, Promise<TrackMetadata>>();
  private commandPending: object | null = null;
  private stateRevision = 0;
  private commandObservationRevision = 0;
  private commandObserved = false;
  private commandAccountKnown = false;
  private commandAccountSubject?: string;
  private commandAccountVersion = 0;
  private commandConfirmed: (() => boolean) | null = null;
  private reconciling = false;
  private startingConnection = false;
  private connectionRequested = false;
  private phaseDeadline: ReturnType<typeof setTimeout> | null = null;
  private cooldownWall = 0;
  private cooldownMono = 0;
  private rateLimits = 0;
  private deliveryBaseline = new DealerDeliveryBaseline();
  private deliveryRouteEpoch = 0;
  private deliveryAuthEpoch = 0;
  private phase: SpotifyPhase = 'idle';
  private reason: SpotifyReason = 'disconnected';
  private phaseStarted = 0;
  private nextRetry = 0;
  private observationRetryAt = 0;
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
  private networkPath = '';
  private pathRestartAt = -Infinity;
  private snapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectedFreshToken = false;
  private lastError: SpotifyHealth['lastError'];
  constructor(private callbacks: Callbacks, private runtime: DetectorRuntime = defaultRuntime) {
    this.deviceId = Array.from({ length: 40 }, () => Math.floor(this.runtime.random() * 16).toString(16)).join('');
  }
  get health(): SpotifyHealth {
    const baseReady = this.enabled && this.activity === 'active' && this.phase === 'ready' && this.socket?.readyState === 1 &&
      this.registered && this.observed && !!this.currentTarget &&
      this.commandPhase === 'idle' && !this.commandPending &&
      this.runtime.wall() < this.expiresAt - CONTROL_EXPIRY_MARGIN_MS && this.cooldownRemaining() <= 0;

    const allowed: SpotifyAllowedControls = Object.freeze({
      resume: baseReady && !this.operationBlocked('resume'),
      pause: baseReady && !this.operationBlocked('pause'),
      next: baseReady && !this.operationBlocked('next'),
      previous: baseReady && !this.operationBlocked('previous'),
      seek: baseReady && !this.operationBlocked('seek'),
    });

    const hasAnyAllowed = allowed.resume || allowed.pause || allowed.next || allowed.previous || allowed.seek;
    const controlsEnabled = baseReady && !this.deviceRestricted && hasAnyAllowed;
    const isFullyRestricted = this.deviceRestricted || (baseReady && !hasAnyAllowed);
    const target = this.observed ? isFullyRestricted ? 'restricted' : this.currentTarget ? 'available' : 'absent' : 'unknown';
    const disabledReason: SpotifyDisabledReason = controlsEnabled ? '' :
      this.activity !== 'active' ? 'inactive' :
      isFullyRestricted ? 'restricted' :
      this.commandPhase !== 'idle' ? this.commandPhase :
      target === 'absent' ? 'noActiveDevice' : this.reason;

    return { ...initialSpotifyHealth, phase: this.phase, reason: this.reason, generation: this.generation, attempt: this.reconnects,
      phaseStartedMono: this.phaseStarted, nextRetryAtWall: this.nextRetry, retryNotBeforeWall: this.cooldownWall,
      reachability: this.reachability, appActivity: this.activity, session: this.blocked ? 'denied' : this.signInReason ? 'signInRequired' : this.phase === 'renewingSession' ? 'renewing' : this.token ? 'valid' : 'unknown',
      transportConfirmed: !!this.socket && this.socket.readyState === 1, observerConfirmed: this.registered && this.observed,
      lastContactMono: this.lastContact, lastStateReceiptMono: this.lastState, lastStateGeneration: this.observed ? this.generation : -1,
      target, targetVersion: this.targetVersion, command: this.commandPhase, controlsEnabled,
      disabledReason,
      allowed,
      lastError: this.lastError };
  }
  private operationBlocked(operation: Operation) {
    return this.deviceRestricted || !!this.payloadRestrictions[operation] || this.blockedOperations.has(operation);
  }
  get playbackAccountVersion() { return this.commandAccountVersion; }
  get playbackCommandState(): PlaybackCommandState {
    if (!this.observed || !this.commandObserved) return { ready: false, fresh: false };
    const sample = this.lastSample;
    const targetId = this.currentTarget;
    if (!targetId || !sample) return { ready: false, observation: null };
    const now = this.runtime.mono();
    return {
      ready: this.health.controlsEnabled,
      targetId,
      blocked: {
        pause: this.operationBlocked('pause'), resume: this.operationBlocked('resume'),
        next: this.operationBlocked('next'), previous: this.operationBlocked('previous'),
        seek: this.operationBlocked('seek'),
      },
      observation: { revision: this.commandObservationRevision, trackId: sample.uri, sessionId: this.orderingSessionId,
        playing: sample.playing, positionMs: projectedPosition(sample, this.runtime.wall(), now),
        durationMs: sample.durationMs, observedAt: now },
    };
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
    const previous = this.activity;
    this.activity = activity;
    if (activity === 'background') { this.setEnabled(false); return; }
    if (activity === 'inactive') {
      this.commandObserved = false;
      this.clearPongDeadline();
      this.missedPongs = 0;
      this.healthySince = null;
      this.cancelCapture();
      this.publishHealth();
      return;
    }
    if (previous !== 'active' && this.enabled) {
      const ws = this.socket;
      if (ws) {
        if (ws.readyState > 1) { this.retryObservation(undefined, true); return; }
        if (this.runtime.wall() >= this.expiresAt - CONTROL_EXPIRY_MARGIN_MS) {
          this.needSession('Refreshing Spotify session…'); return;
        }
        // A pong can survive suspension even when playback observation cannot.
        // Gate commands until this socket proves current state again.
        if (ws.readyState === 1 && this.connectionId) this.reconcileObservation();
        else this.armPhaseDeadline();
        if (this.socket === ws && !this.expiry) this.scheduleRenewal();
        return;
      }
      this.connectIfReady();
    }
    this.publishHealth();
  }
  setReachability(hint: Reachability, path?: string) {
    const pathChanged = !!path && !!this.networkPath && path !== this.networkPath;
    if (path) this.networkPath = path;
    if (hint === this.reachability && !pathChanged) return;
    const previous = this.reachability; this.reachability = hint;
    if (hint === 'offline') { this.disconnect(); if (this.enabled) this.transition('offline'); return; }
    this.publishHealth();
    if (!this.enabled) return;
    if (previous === 'offline') {
      this.onlineTimer = this.runtime.setTimeout(() => { this.onlineTimer = null; this.connectIfReady(); }, 500);
      return;
    }
    if (pathChanged) {
      if (this.reconnect || this.onlineTimer) return;
      // Retire old interface work immediately. Coalesce flapping notifications
      // without allowing them to bypass auth, cooldown or request ownership.
      this.disconnect();
      const delay = Math.max(0, this.pathRestartAt + 1000 - this.runtime.mono());
      if (!delay) { this.pathRestartAt = this.runtime.mono(); this.connectIfReady(); }
      else {
        this.onlineTimer = this.runtime.setTimeout(() => {
          this.onlineTimer = null; this.pathRestartAt = this.runtime.mono(); this.connectIfReady();
        }, delay);
        this.publishHealth();
      }
    } else this.connectIfReady();
  }
  private binding() { return JSON.stringify([this.generation, this.connectionId, this.currentTarget, this.lastSample?.uri, this.lastSample?.playbackSessionId]); }
  private stateConfirmed(target: string | undefined, positive = true) {
    if (positive) this.stateRevision++;
    this.observed = true; this.currentTarget = target; this.lastState = this.runtime.mono();
    // Only a capture with validated routes and a confirmed observation can
    // seed reconnect. Each replacement still has to prove its own authority.
    this.reconnectSession ??= { token: this.token, clientToken: this.clientToken, expiresAt: this.expiresAt,
      route: this.route, dealer: this.dealer };
    this.connectingWithCachedSession = false;
    this.cachedFallbackPending = false;
    if (this.phaseDeadline) this.runtime.clearTimeout(this.phaseDeadline); this.phaseDeadline = null;
    if (this.healthySince === null) this.healthySince = this.runtime.mono();
    if ((positive || this.reconciling) && this.commandPhase !== 'sending' &&
      (this.commandPhase !== 'awaitingConfirmation' || this.reconciling || this.commandConfirmed?.())) {
      if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
      this.commandPhase = 'idle'; this.commandConfirmed = null;
    }
    this.reconciling = false;
    this.transition('ready'); this.callbacks.ready(); this.scheduleSnapshot();
  }

  private authorityToken() {
    return JSON.stringify([this.generation, this.connectionId, this.acceptedAuthority, this.stateRevision]);
  }
  private applyAuthoritativeState(restrictions: ReturnType<typeof selectedRestrictions>, key: string) {
    this.blockedOperations.clear();
    this.deviceRestricted = restrictions.deviceRestricted;
    this.payloadRestrictions = restrictions.blocked;
    this.restrictionSignature = restrictions.signature;
    this.acceptedAuthority = key;
  }

  capture(raw: string, origin: string, captureId: number): boolean {
    try {
      const pending = this.pendingSession;
      if (!pending || pending.id !== captureId || !this.enabled) return false;
      if (new URL(origin).origin !== 'https://open.spotify.com') return false;
      const e = JSON.parse(raw);
      if (e.type === 'notice' && e.message === 'Android observer registration failed. Reconnect Spotify to retry.' && !this.registered) {
        this.callbacks.status(e.message); return true;
      }
      if (e.type === 'session' && ['anonymous', 'denied', 'unavailable'].includes(e.state)) {
        if (e.state === 'unavailable') this.captureFailed(pending);
        else this.requireSignIn('sessionChallenge');
        return true;
      }
      if (e.type === 'credentials' && e.authenticated === true && typeof e.token === 'string' && e.token.length > 0 && e.token.length < 4096) {
        let expiresAt = Number(e.expiresAt) || 0;
        if (!expiresAt) { try { expiresAt = Number(JSON.parse(Buffer.from(e.token.split('.')[1], 'base64').toString()).exp) * 1000 || 0; } catch {} }
        // A fresh probe can return the same opaque bearer. Keep its original
        // expiry estimate while the live connection still owns it.
        expiresAt ||= (e.token === this.token && this.expiresAt) || this.runtime.wall() + 45 * 60_000;
        if (expiresAt <= this.runtime.wall() + CONTROL_EXPIRY_MARGIN_MS) {
          this.captureFailed(pending); return true;
        }
        const clientToken = typeof e.clientToken === 'string' && e.clientToken.length < 4096 ? e.clientToken : '';
        pending.credentials = { token: e.token, clientToken, expiresAt };
      } else if (e.type === 'observerEndpoint' && typeof e.url === 'string') {
        const route = observerEndpoint(e.url, this.deviceId);
        if (!route) return false;
        pending.route = route;
      } else if (e.type === 'socket' && typeof e.url === 'string' && spotifyHost(e.url, true) && /(^|\.)[^.]*dealer[^.]*\./i.test(new URL(e.url).hostname)) {
        const dealer = new URL(e.url); dealer.searchParams.delete('access_token'); dealer.searchParams.sort(); dealer.hash = '';
        pending.dealer = dealer.toString();
      } else return false;
      this.finishCapture(pending);
      return true;
    } catch { /* Ignore untrusted/malformed bridge data. */ }
    return false;
  }
  private finishCapture(pending: PendingSession) {
    const { credentials, route, dealer } = pending;
    if (!credentials || !route || !dealer || this.activity !== 'active') return;
    if (credentials.expiresAt <= this.runtime.wall() + CONTROL_EXPIRY_MARGIN_MS) {
      this.captureFailed(pending); return;
    }
    // Keep a verified observer through acquisition, then retire its authority
    // before opening the replacement. Registration must prove state again.
    const run = this.generation + 1;
    const routeChanged = route !== this.route || dealer !== this.dealer;
    const previousBearer = this.token || this.reconnectSession?.token;
    this.reconnectSession = null;
    this.disconnect();
    // sessionFinished can synchronously start a replacement capture.
    if (run !== this.generation || !this.enabled || this.activity !== 'active' ||
        this.reachability === 'offline' || this.pendingSession) return;
    if (routeChanged) this.deliveryRouteEpoch++;
    // An opaque replacement cannot prove it belongs to the previous account.
    // The cached bearer path bypasses capture and preserves queued intentions.
    const subject = credentialSubject(credentials.token);
    const sameAccount = credentials.token === previousBearer ||
      (subject !== undefined && subject === this.commandAccountSubject);
    const commandScopeChanged = this.commandAccountKnown && !sameAccount;
    if (commandScopeChanged) {
      this.commandAccountVersion++;
      this.lastSample = null;
      this.metadataCache.clear();
    }
    this.commandAccountKnown = true;
    this.commandAccountSubject = subject;
    // Canceling old command intents does not make the replacement's playback
    // newer. Cache fallback still needs a sample that passes source ordering.
    if (pending.resetOrdering) this.resetOrdering();
    // Credential renewal has to replace the command observation before
    // ordinary snapshot polling can resume.
    this.reconciling = this.lastSourceTimestamp > 0;
    this.installSession({ ...credentials, route, dealer });
    this.callbacks.authenticated(this.token, this.expiresAt);
    if (run === this.generation) this.connectIfReady();
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) { if (enabled) this.connectIfReady(); return; }
    this.enabled = enabled;
    if (enabled) {
      // Returning from suspension reprojects the last authoritative anchor.
      if (this.lastSample) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) timingDiagnostics?.recordTiming('foreground-replay', this.lastSample.timingProvenance);
        if (typeof __DEV__ !== 'undefined' && __DEV__) developmentTimingLog?.logDevelopmentTiming('foreground-replay', this.lastSample);
        // Keep legacy fallback behavior; immutable provenance retains original receipt.
        this.callbacks.sample({ ...this.lastSample, receivedAt: this.runtime.wall(),
          // A cached replay cannot certify a newly authenticated/routed source.
          sourceClockScope: this.lastSample.sourceClockScope === this.sourceClockScope ? this.sourceClockScope : undefined });
      }
      this.connectIfReady();
    } else {
      const run = this.generation + 1;
      this.disconnect();
      if (run === this.generation && !this.enabled) this.transition('suspended');
    }
  }
  refresh(explicit = false) {
    if (this.startingConnection || !this.enabled || this.activity !== 'active' || this.reachability === 'offline') return;
    if (this.cooldownRemaining() > 0 || this.reconnect || this.onlineTimer) { this.connectIfReady(); return; }
    if (!explicit && (!this.socket || !this.observed)) { this.connectIfReady(); return; }
    if (this.pendingSession || this.runtime.mono() < this.observationRetryAt) return;
    if (explicit) {
      if (this.runtime.mono() - this.manualAt < 2000) return;
      this.manualAt = this.runtime.mono(); this.rejectedFreshToken = false; this.signInReason = null;
      this.cachedFallbackPending = false;
      this.blocked = false;
    }
    if (nativeDiagnosticsEnabled && nativeClockDiagnostics?.nativeClockCaptureActive()) nativeClockDiagnostics?.emitNativeClockDiagnostic('detector-refresh-before', {
      generation: this.generation, reason: 'explicit-refresh', registered: this.registered,
      ...this.deliveryBaseline.diagnosticSummary() });
    if (this.canRenewLive()) this.startCapture(true, true);
    else {
      this.reconnectSession = null;
      this.resetOrdering(); this.disconnect(); this.connectIfReady();
    }
  }
  beginSignIn() {
    if (this.pendingSession || this.runtime.mono() - this.manualAt < 2000 || this.runtime.mono() < this.observationRetryAt) return;
    if (!this.enabled || this.activity !== 'active' || this.reachability === 'offline' || this.cooldownRemaining() > 0) return;
    this.manualAt = this.runtime.mono();
    this.blocked = false; this.rejectedFreshToken = false; this.signInReason = null;
    this.cachedFallbackPending = false;
    this.needSession('Refreshing Spotify session…');
  }
  clear() {
    const retiredCaptureId = this.detachCapture();
    this.reconnectSession = null;
    this.cachedFallbackPending = false;
    this.commandAccountKnown = false; this.commandAccountSubject = undefined; this.commandAccountVersion++;
    this.enabled = false; this.lastSample = null; this.disconnect();
    this.resetOrdering();
    this.blocked = false; this.signInReason = null; this.cooldownWall = 0; this.cooldownMono = 0; this.rateLimits = 0;
    this.metadataCache.clear(); this.metadataPending.clear();
    this.reconnects = 0; this.observationRetryAt = 0; this.rejectedFreshToken = false; this.commandPhase = 'idle';
    this.deviceRestricted = false;
    this.payloadRestrictions = {};
    this.blockedOperations.clear();
    // A sessionFinished callback can enable the detector and supply credentials.
    // Deliver it after the clear has finished changing detector state.
    try { this.transition('idle'); }
    finally { if (retiredCaptureId !== undefined) this.callbacks.sessionFinished?.(retiredCaptureId); }
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
  async control(command: { type: 'toggle' | 'previous' | 'next' | 'seek'; positionMs?: number } |
      { type: 'play'; playing: boolean }, confirmationOwner: 'detector' | 'queue' = 'detector'): Promise<void> {
    if (this.commandPending) throw new SpotifyPlaybackUnavailableError('Waiting for the previous Spotify command.', 'sending');
    const target = this.currentTarget;
    if (!this.health.controlsEnabled || !target || (confirmationOwner === 'queue' && !this.commandObserved)) throw new SpotifyPlaybackUnavailableError('Spotify controls are unavailable until current playback is confirmed.', this.health.disabledReason);
    if (command.type === 'seek' && !Number.isFinite(command.positionMs)) throw new Error('Invalid seek position.');
    const isPlaying = this.lastSample?.playing ?? false;
    const desiredPlaying = command.type === 'play' ? command.playing : !isPlaying;
    const changesPlayState = command.type === 'play' || command.type === 'toggle';
    const op: Operation =
      changesPlayState ? (desiredPlaying ? 'resume' : 'pause') :
      command.type === 'previous' ? 'previous' :
      command.type === 'next' ? 'next' : 'seek';
    if (!this.health.allowed[op]) {
      throw new SpotifyPlaybackUnavailableError(`Spotify ${command.type} is restricted.`, 'restricted');
    }
    if (command.type === 'play' && desiredPlaying === isPlaying) return;
    const endpoint = { pause: 'pause', resume: 'resume', previous: 'skip_prev', next: 'skip_next', seek: 'seek_to' }[op];
    // Route to the device observed by Dealer, not a newly mounted web player.
    const from = new URL(this.route).pathname.split('/').pop()!;
    const path = `/connect-state/v1/player/command/from/${encodeURIComponent(from)}/to/${encodeURIComponent(target)}`;
    const value = command.type === 'seek' ? Math.round(Math.max(0, Math.min(this.lastSample!.durationMs || Infinity, command.positionMs!))) : undefined;
    const body = { command: { endpoint, ...(value !== undefined ? { value } : {}),
      options: { only_for_local_device: false, system_initiated: false, override_restrictions: false } },
      connection_type: 'wlan', intent_id: Array.from({ length: 32 }, () => Math.floor(this.runtime.random() * 16).toString(16)).join('') };
    const commandId = {}; this.commandPending = commandId;
    const binding = this.binding(); const run = this.generation; const connection = this.connectionId;
    let revision = this.stateRevision;
    let authority = this.authorityToken();
    const superseded = () => run === this.generation && connection === this.connectionId &&
      this.phase === 'ready' && this.registered && this.observed && this.stateRevision > revision &&
      (binding !== this.binding() ||
       (changesPlayState && this.lastSample?.playing === desiredPlaying) ||
       (command.type === 'seek' && value !== undefined && Math.abs((this.lastSample?.positionMs ?? Infinity) - value) <= 1000));
    this.commandConfirmed = superseded;
    this.commandPhase = 'sending'; this.publishHealth();
    try {
      if (this.activity !== 'active' || this.commandPending !== commandId || binding !== this.binding()) throw new SpotifyPlaybackUnavailableError('Spotify authority changed before command dispatch.', 'unavailable');
      revision = this.stateRevision;
      authority = this.authorityToken();
      await this.request(path, 'POST', body);
      if (this.commandPending === commandId && superseded()) {
        // Dealer can report the resulting track/pause/seek before HTTP settles.
        // Current authority supersedes the old intent; it is not transport loss
        // or proof that this particular command caused the observed change.
        this.commandPhase = 'idle'; return;
      }
      if (this.commandPending !== commandId || binding !== this.binding()) throw new SpotifyCommandOutcomeUnknownError('Spotify target changed; playback outcome unknown.');
      // The queue stays serialized on its authoritative observation. This
      // lower-level client still owns the verified dispatch and HTTP gates.
      if (confirmationOwner === 'queue') { this.commandPhase = 'idle'; return; }
      this.commandPhase = 'awaitingConfirmation'; this.confirmationBinding = binding;
      const confirmation = this.runtime.setTimeout(() => {
        if (this.confirmation !== confirmation || this.commandConfirmed !== superseded ||
          this.commandPhase !== 'awaitingConfirmation' || run !== this.generation || this.confirmationBinding !== binding) return;
        this.confirmation = null; this.commandPhase = 'outcomeUnknown'; this.reconcileObservation();
      }, 5000);
      this.confirmation = confirmation; this.publishHealth();
      this.callbacks.status(`Spotify ${endpoint} accepted; awaiting the device update.`);
    } catch (error) {
      if (error instanceof SpotifyControlRejectedError && error.httpStatus === 403 &&
          this.commandPending === commandId && run === this.generation && connection === this.connectionId &&
          authority === this.authorityToken()) this.blockedOperations.add(op);
      if (error instanceof SpotifyControlRejectedError || error instanceof SpotifyPlaybackUnavailableError) {
        if (this.commandPending === commandId) this.commandPhase = 'idle';
        throw error;
      }
      if (this.commandPending === commandId) {
        this.commandPhase = superseded() ? 'idle' : 'outcomeUnknown';
        if (!superseded()) this.retryObservation();
      }
      throw new SpotifyCommandOutcomeUnknownError('Playback outcome unknown. Checking Spotify; command will not be replayed.');
    } finally {
      if (this.commandPending === commandId) this.commandPending = null;
      if (this.commandConfirmed === superseded && this.commandPhase !== 'awaitingConfirmation') this.commandConfirmed = null;
      this.publishHealth();
    }
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Uint8Array> {
    if (!this.enabled || this.blocked || !this.token || !this.route || !this.connectionId) throw new Error('Spotify session is not ready.');
    const run = this.generation; const requestConnection = this.connectionId;
    const started = nativeDiagnosticsEnabled ? this.runtime.mono() : 0;
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = this.runtime.setTimeout(() => controller.abort(), TRANSPORT_DEADLINE_MS);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
      'x-spotify-connection-id': this.connectionId };
    if (this.clientToken) headers['client-token'] = this.clientToken;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-encoding'] = 'gzip'; }
    try {
      const response = await this.bounded(this.runtime.fetch(new URL(path, this.route).toString(), { method, headers, signal: controller.signal,
        ...(body !== undefined ? { body: Uint8Array.from(gzip(JSON.stringify(body))).buffer } : {}) }), controller);
      if (nativeDiagnosticsEnabled) nativeClockDiagnostics?.emitNativeClockDiagnostic('spotify-http-response', { endpoint: method === 'GET' ? 'metadata' : 'player-control',
        method, status: response.status, requestGeneration: run, currentGeneration: this.generation,
        elapsedMs: this.runtime.mono() - started, staleGeneration: run !== this.generation, cacheProvenance: 'network-response' });
      if (controller.signal.aborted || run !== this.generation || requestConnection !== this.connectionId) throw new Error('Spotify session changed during request.');
      if (response.status === 401) this.needSession('Spotify session expired. Refreshing login…', true);
      if (response.status === 429) this.rateLimited(response);
      if (method === 'POST' && response.status === 404) { this.retryObservation(); throw new SpotifyPlaybackUnavailableError('Spotify playback target changed. Restoring observation; command was not retried.'); }
      if (!response.ok) throw new SpotifyControlRejectedError(`Spotify ${method === 'GET' ? 'metadata' : 'control'} HTTP ${response.status}.`, response.status);
      // Read while the abort/timeout is still installed, including slow bodies.
      const bytes = await this.bounded(response.arrayBuffer(), controller);
      if (controller.signal.aborted || run !== this.generation || requestConnection !== this.connectionId) throw new Error('Spotify session changed during response.');
      return new Uint8Array(bytes);
    } finally { this.runtime.clearTimeout(timeout); this.requests.delete(controller); }
  }
  private disconnect() {
    this.generation++; this.reconciling = false; this.commandConfirmed = null;
    this.token = ''; this.clientToken = ''; this.expiresAt = 0; this.route = ''; this.dealer = '';
    this.connectingWithCachedSession = false;
    this.deliveryAuthEpoch++;
    if (this.commandPending || this.commandPhase === 'awaitingConfirmation') this.commandPhase = 'outcomeUnknown';
    this.commandPending = null;
    this.healthySince = null;
    if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
    if (this.onlineTimer) this.runtime.clearTimeout(this.onlineTimer); this.onlineTimer = null;
    if (this.phaseDeadline) this.runtime.clearTimeout(this.phaseDeadline); this.phaseDeadline = null;
    this.deliveryBaseline.clear();
    if (this.snapshotTimer) this.runtime.clearTimeout(this.snapshotTimer); this.snapshotTimer = null;
    this.clearPongDeadline();
    this.missedPongs = 0;
    this.controller?.abort(); this.controller = null;
    for (const controller of this.requests) controller.abort();
    this.requests.clear(); this.metadataPending.clear();
    if (this.heartbeat) this.runtime.clearInterval(this.heartbeat);
    if (this.reconnect) this.runtime.clearTimeout(this.reconnect);
    if (this.expiry) this.runtime.clearTimeout(this.expiry);
    this.heartbeat = null; this.reconnect = null; this.expiry = null;
    const ws = this.socket; this.socket = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; try { ws.close(); } catch {} }
    this.connectionId = ''; this.registered = false; this.observed = false; this.commandObserved = false; this.currentTarget = undefined; this.pendingState = null;
    this.deviceRestricted = false;
    this.payloadRestrictions = {};
    this.blockedOperations.clear();
    this.restrictionSignature = ''; this.acceptedAuthority = '';
    this.cancelCapture();
  }
  private requireSignIn(reason: SignInReason) {
    this.signInReason = reason;
    this.reconnectSession = null;
    this.cachedFallbackPending = false;
    const run = this.generation + 1;
    this.disconnect();
    if (run === this.generation && this.enabled) this.transition('signInRequired', reason);
  }
  private needSession(message: string, unauthorized = false) {
    if (unauthorized) {
      const error = { category: 'authentication' as const, httpStatus: 401, occurredAtWall: this.runtime.wall() };
      if (this.connectingWithCachedSession) { this.retryObservation(error); return; }
      this.lastError = error;
      if (this.cachedFallbackPending || this.rejectedFreshToken) {
        this.requireSignIn('freshTokenRejected');
        return;
      }
      this.rejectedFreshToken = true;
    }
    if (this.connectingWithCachedSession) this.cachedFallbackPending = true;
    this.reconnectSession = null;
    const run = this.generation + 1;
    this.disconnect();
    if (run !== this.generation || !this.enabled || this.reachability === 'offline') return;
    this.startCapture(false, false, message);
  }
  private canRenewLive() {
    return this.socket?.readyState === 1 && this.phase === 'ready' && this.registered && this.observed &&
      this.runtime.wall() < this.expiresAt - CONTROL_EXPIRY_MARGIN_MS;
  }
  private startCapture(soft: boolean, resetOrdering: boolean, message = 'Refreshing Spotify session…') {
    if (this.pendingSession || this.activity !== 'active') return;
    const pending: PendingSession = { id: ++this.captureId, soft, resetOrdering };
    this.pendingSession = pending;
    this.renewalTimer = this.runtime.setTimeout(() => {
      if (this.pendingSession === pending) this.captureFailed(pending, 'timeout');
    }, SESSION_DEADLINE_MS);
    if (!soft) {
      this.transition('renewingSession');
      if (this.pendingSession === pending) this.callbacks.status(message);
    }
    if (this.pendingSession === pending) this.callbacks.sessionNeeded(pending.id);
  }
  private cancelCapture() {
    const captureId = this.detachCapture();
    if (captureId !== undefined) this.callbacks.sessionFinished?.(captureId);
  }
  private detachCapture() {
    const captureId = this.pendingSession?.id;
    this.pendingSession = null;
    if (this.renewalTimer) this.runtime.clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
    return captureId;
  }
  private captureFailed(pending: PendingSession, category: 'timeout' | 'transport' = 'transport') {
    if (pending.soft && this.socket?.readyState === 1 && this.runtime.wall() < this.expiresAt - CONTROL_EXPIRY_MARGIN_MS) {
      // Keep the live authority. If this was the expiry probe, try again at
      // the existing safety cutoff, when the old token must be retired.
      this.cancelCapture();
    } else this.retryObservation({ category, occurredAtWall: this.runtime.wall() });
  }
  private scheduleRenewal(margin = SESSION_RENEWAL_MARGIN_MS) {
    if (this.expiry) this.runtime.clearTimeout(this.expiry);
    const ws = this.socket;
    const deadline = this.runtime.setTimeout(() => {
      if (this.expiry !== deadline || this.socket !== ws) return;
      this.expiry = null;
      if (this.activity !== 'active') return;
      if (this.runtime.wall() >= this.expiresAt - CONTROL_EXPIRY_MARGIN_MS) {
        this.needSession('Refreshing Spotify session…');
      } else {
        this.scheduleRenewal(CONTROL_EXPIRY_MARGIN_MS);
        if (this.canRenewLive()) this.startCapture(true, false);
      }
    }, Math.max(1, this.expiresAt - this.runtime.wall() - margin));
    this.expiry = deadline;
  }
  private resetOrdering() {
    this.fingerprint = ''; this.lastSourceTimestamp = 0;
    this.orderingDeviceId = undefined; this.orderingSessionId = undefined; this.lastDealerConnection = '';
  }
  private emit(payload: unknown, receivedAt = this.runtime.wall(), timing: TimingContext = {}, authorityScope = this.sourceClockScope,
      { allowRegistrationHandoff = false, bufferedDuringRegistration = false } = {}) {
    const selected = sampleWithContext(payload, 0, timing);
    const s = selected?.sample;
    if (!s || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(s.uri)) {
      if (idleState(payload)) {
        if (this.reconciling && timing.origin === 'dealer') return true;
        this.commandObserved = true; this.commandObservationRevision++;
        this.stateConfirmed(undefined, false);
        return true;
      }
      return false;
    }
    if (nativeDiagnosticsEnabled) nativeClockDiagnostics?.emitNativeClockDiagnostic('source-candidate', { origin: timing.origin ?? 'unknown', generation: timing.generation,
      rawPosition: s.positionMs, playerTimestamp: s.positionTimestampMs, serverTimestamp: s.sourceServerTimestampMs,
      receiptWall: timing.receipt?.wallMs, receiptMono: timing.receipt?.monotonicMs, receivedAt,
      playing: s.playing,
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
    // During recovery, an unordered Dealer sample cannot stand in for the
    // current registration response.
    if (timing.origin === 'dealer' && (this.reconciling ||
        (bufferedDuringRegistration && (this.lastSample || this.lastSourceTimestamp))) &&
        (!s.positionTimestampMs || (!identityChanged && s.positionTimestampMs === this.lastSourceTimestamp))) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) this.logDeliveryRejection(s, timing.origin, 'dealer-without-newer-recovery-evidence');
      return true;
    }
    // A registration snapshot can predate a Dealer handoff on a different clock.
    // Comparing timestamps across those identities cannot order that race.
    if (timing.origin === 'registration' && !allowRegistrationHandoff && this.lastDealerConnection === connection && identityChanged) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) this.logDeliveryRejection(s, timing.origin, 'registration-conflicts-with-dealer-identity');
      if (typeof __DEV__ !== 'undefined' && __DEV__) developmentTimingLog?.logDevelopmentTiming('registration-conflict', s);
      if (typeof __DEV__ !== 'undefined' && __DEV__) timingDiagnostics?.recordTiming('stale', s.timingProvenance);
      return true;
    }
    // A stale packet cannot establish authority or close a registration
    // deadline, regardless of how the registration was started.
    if (!identityChanged && s.positionTimestampMs && s.positionTimestampMs < this.lastSourceTimestamp) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) this.logDeliveryRejection(s, timing.origin, 'source-timestamp-older-than-watermark');
      if (typeof __DEV__ !== 'undefined' && __DEV__) developmentTimingLog?.logDevelopmentTiming('stale', s);
      if (typeof __DEV__ !== 'undefined' && __DEV__) timingDiagnostics?.recordTiming('stale', s.timingProvenance);
      return true;
    }
    if (this.currentTarget !== (device ?? this.orderingDeviceId) || this.lastSample?.uri !== s.uri || this.lastSample?.playbackSessionId !== s.playbackSessionId) this.targetVersion++;
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
        const diagnosticBaseline = nativeDiagnosticsEnabled ? this.deliveryBaseline.fork() : null;
        const accepted = this.deliveryBaseline.observeDealer(observation);
        if (diagnosticBaseline) {
          const decision = diagnosticBaseline.observeDealerDecision(observation);
          deliveryDiagnostics?.logDealerDeliveryDecision('dealer-envelope', { ...decision, accepted });
        }
      } else if (nativeDiagnosticsEnabled) {
        deliveryDiagnostics?.logDealerDeliveryDecision('dealer-envelope', { accepted: false, reason: 'dealer-missing-valid-timestamp-pair', sampleCount: 0 });
      }
    } else if (timing.origin === 'registration') {
      if (observation) {
        const diagnosticBaseline = nativeDiagnosticsEnabled ? this.deliveryBaseline.fork() : null;
        s.dealerDeliveryExcessMs = this.deliveryBaseline.registrationExcess(observation, s.playing);
        if (nativeDiagnosticsEnabled) {
          const decision = diagnosticBaseline!.registrationDecision(observation, s.playing);
          deliveryDiagnostics?.logDealerDeliveryDecision('registration-correction', { ...decision, excessMs: s.dealerDeliveryExcessMs });
        }
      } else {
        s.dealerDeliveryExcessMs = undefined;
        if (nativeDiagnosticsEnabled) deliveryDiagnostics?.logDealerDeliveryDecision('registration-correction', {
          accepted: false, reason: 'registration-missing-valid-timestamp-pair', sampleCount: 0,
        });
      }
    }
    // A new connection may confirm identical state once. Within the connection,
    // session-only handoffs must not disappear behind an equal state fingerprint.
    const key = JSON.stringify([connection, this.orderingDeviceId, this.orderingSessionId,
      stateFingerprint({ ...s, activeDeviceId: this.orderingDeviceId })]);
    const restrictions = selectedRestrictions(selected!);
    const changedRestrictions = restrictions.signature !== this.restrictionSignature;
    const target = device ?? this.orderingDeviceId;
    this.commandObserved = true; this.commandObservationRevision++;
    if (key === this.fingerprint) {
      if (changedRestrictions) this.applyAuthoritativeState(restrictions, key);
      this.stateConfirmed(target, changedRestrictions);
      if (typeof __DEV__ !== 'undefined' && __DEV__) developmentTimingLog?.logDevelopmentTiming('duplicate', s);
      if (typeof __DEV__ !== 'undefined' && __DEV__) timingDiagnostics?.recordTiming('duplicate', s.timingProvenance);
      return true;
    }
    this.fingerprint = key;
    if (s.positionTimestampMs) this.lastSourceTimestamp = s.positionTimestampMs;
    this.lastSample = s;
    this.applyAuthoritativeState(restrictions, key);
    this.stateConfirmed(target);
    if (typeof __DEV__ !== 'undefined' && __DEV__) timingDiagnostics?.recordTiming('accepted', s.timingProvenance, { positionMs: s.positionMs, playing: s.playing });
    if (typeof __DEV__ !== 'undefined' && __DEV__) developmentTimingLog?.logDevelopmentTiming('accepted', s);
    this.callbacks.sample(s);
    return true;
  }
  private logDeliveryRejection(sample: Sample, origin: TimingContext['origin'], reason: string) {
    if (!nativeDiagnosticsEnabled || (origin !== 'dealer' && origin !== 'registration')) return;
    const receipt = sample.positionObservedAt;
    const nowMono = this.runtime.mono();
    deliveryDiagnostics?.logDealerDeliveryDecision(origin === 'dealer' ? 'dealer-envelope' : 'registration-correction', {
      accepted: false, reason, playerTimestampMs: sample.positionTimestampMs,
      serverMs: sample.sourceServerTimestampMs, receiptWallMs: receipt?.wallMs,
      receiptMonotonicMs: receipt?.monotonicMs, nowMono,
      receiptAgeMs: receipt ? nowMono - receipt.monotonicMs : undefined, sampleCount: 0,
    });
  }
  private connectIfReady() {
    if (this.startingConnection) { this.connectionRequested = true; return; }
    const previousRun = this.generation;
    const previousCaptureId = this.captureId;
    this.startingConnection = true; this.connectionRequested = false;
    try { this.connectAttempt(); }
    finally {
      this.startingConnection = false;
      // Capture completion, suspension or a network change can leave a
      // replacement to start once the previous attempt releases ownership.
      if (this.connectionRequested && this.enabled && !this.socket && !this.pendingSession && !this.reconnect && !this.onlineTimer &&
          !this.blocked && !this.signInReason && this.activity === 'active' && this.reachability !== 'offline' &&
          (this.token || this.generation !== previousRun || this.captureId !== previousCaptureId)) {
        const run = this.generation;
        const captureId = this.captureId;
        void Promise.resolve().then(() => {
          if (run === this.generation && captureId === this.captureId) this.connectIfReady();
        });
      }
      this.connectionRequested = false;
    }
  }
  private installSession({ token, clientToken, expiresAt, route, dealer }: ReconnectSession) {
    this.token = token; this.clientToken = clientToken; this.expiresAt = expiresAt;
    this.route = route; this.dealer = dealer;
  }
  private connectAttempt() {
    if (!this.enabled || this.activity !== 'active') return;
    if (this.blocked) { if (this.phase !== 'denied') this.transition('denied'); return; }
    if (this.signInReason) {
      if (this.phase !== 'signInRequired' || this.reason !== this.signInReason) this.transition('signInRequired', this.signInReason);
      return;
    }
    if (this.socket || this.reconnect || this.pendingSession || this.onlineTimer) return;
    if (this.reachability === 'offline') { this.transition('offline'); return; }
    const wait = this.cooldownRemaining();
    if (wait > 0) {
      this.nextRetry = this.cooldownWall;
      this.reconnect = this.runtime.setTimeout(() => { this.reconnect = null; this.connectIfReady(); }, Math.min(wait, 2147483647));
      this.transition('rateLimited');
      return;
    }
    if (this.waitForObservationRetry()) return;
    if (!this.token) {
      const cached = this.reconnectSession;
      if (!cached || cached.expiresAt <= this.runtime.wall() + CONTROL_EXPIRY_MARGIN_MS) {
        this.reconnectSession = null;
        this.startCapture(false, false);
        return;
      }
      this.installSession(cached);
      this.connectingWithCachedSession = true;
    }
    if (this.runtime.wall() >= this.expiresAt - CONTROL_EXPIRY_MARGIN_MS) { this.needSession('Refreshing Spotify session…'); return; }
    const run = ++this.generation;
    const sourceClockScope = this.sourceClockScope;
    const url = new URL(this.dealer);
    url.searchParams.set('access_token', this.token);
    let ws: WebSocket;
    try { ws = this.runtime.socket(url.toString()); }
    catch {
      if (run === this.generation) this.retryObservation();
      return;
    }
    if (!this.enabled || run !== this.generation || sourceClockScope !== this.sourceClockScope) { try { ws.close(); } catch {} return; }
    this.socket = ws;
    this.armPhaseDeadline();
    const alive = () => this.enabled && run === this.generation && this.socket === ws;
    const ping = () => {
      if (!alive() || this.activity !== 'active' || ws.readyState !== 1 || this.pongDeadline) return;
      const due = this.runtime.mono() + PONG_DEADLINE_MS;
      const deadline = this.runtime.setTimeout(() => {
        if (this.pongDeadline !== deadline || !alive()) return;
        this.pongDeadline = null;
        if (this.activity !== 'active' || this.runtime.mono() - due > PONG_TIMER_GRACE_MS) {
          this.missedPongs = 0;
          return;
        }
        if (++this.missedPongs >= 2) this.retryObservation();
      }, PONG_DEADLINE_MS);
      this.pongDeadline = deadline;
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch { if (alive()) this.retryObservation(); }
    };
    this.scheduleRenewal(this.expiresAt - this.runtime.wall() <= SESSION_RENEWAL_MARGIN_MS
      ? CONTROL_EXPIRY_MARGIN_MS : SESSION_RENEWAL_MARGIN_MS);
    this.heartbeat = this.runtime.setInterval(ping, HEARTBEAT_INTERVAL_MS);
    ws.onopen = () => {
      if (!alive() || this.activity !== 'active') return;
      // The cached budget covers both socket open and Dealer identification.
      if (!this.connectingWithCachedSession || !this.phaseDeadline) this.armPhaseDeadline();
      ping();
    };
    ws.onmessage = e => {
      if (!alive() || this.activity !== 'active') return;
      const receivedAt = this.runtime.wall();
      const receipt = timingNow(receivedAt);
      try {
        const payload = JSON.parse(String(e.data));
        const id = connectionIdFrom(payload);
        const decoded = decodeDealer(payload);
        if (payload.type !== 'pong' && !id && !sampleFrom(decoded) && !idleState(decoded)) return;
        this.lastContact = this.runtime.mono();
        this.clearPongDeadline();
        this.missedPongs = 0;
        if (this.healthySince !== null && this.lastContact - this.healthySince >= 60000) { this.reconnects = 0; this.rateLimits = 0; this.rejectedFreshToken = false; }
        if (payload.type === 'pong') return;
        if (id && id !== this.connectionId) {
          this.reconciling ||= Boolean(this.connectionId);
          this.registered = false; this.observed = false; this.commandObserved = false; this.currentTarget = undefined; this.pendingState = null;
          this.blockedOperations.clear();
          if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
          if (this.commandPending || this.commandPhase === 'awaitingConfirmation') this.commandPhase = 'outcomeUnknown';
          this.commandPending = null; for (const request of this.requests) request.abort();
          // ID rotation supersedes the request, not the observation deadline.
          // Otherwise a responsive Dealer can keep us registering indefinitely
          // by replacing IDs before any registration proves usable state.
          const enteringRegistration = this.phase !== 'registering';
          this.connectionId = id; this.transition('registering');
          if (!alive() || this.connectionId !== id || this.activity !== 'active') return;
          if (enteringRegistration || !this.phaseDeadline) this.armPhaseDeadline();
          void this.register(run, ws, sourceClockScope); }
        if (sampleFrom(decoded) || idleState(decoded)) this.dealerStateRevision++;
        const timing: TimingContext = { receipt, origin: 'dealer', connectionId: this.connectionId, generation: run };
        if (this.registered) this.emit(decoded, receivedAt, timing, sourceClockScope);
        else if (sampleFrom(decoded) || idleState(decoded)) this.pendingState = { payload: decoded, receivedAt, timing, sourceClockScope };
      } catch { this.callbacks.status('A Spotify update could not be decoded; awaiting the next update.'); }
    };
    ws.onerror = () => { if (alive()) this.retryObservation(); };
    ws.onclose = () => { if (alive()) this.retryObservation(); };
    // Publish only after local ownership, handlers and deadlines are installed.
    this.transition('connecting');
    if (alive()) this.callbacks.status('Connecting to Spotify playback…');
  }
  private clearPongDeadline() {
    if (this.pongDeadline) this.runtime.clearTimeout(this.pongDeadline);
    this.pongDeadline = null;
  }
  private scheduleSnapshot() {
    if (this.controller || !this.enabled || this.activity !== 'active' ||
        !this.registered || !this.observed || !this.socket || this.cooldownRemaining() > 0) return;
    // Remote snapshots, not pongs or locally extrapolated progress, bound lost
    // pause, seek and track events. Never send playback commands as probes.
    const delay = !this.currentTarget ? SNAPSHOT_IDLE_MS :
      this.lastSample?.playing ? SNAPSHOT_PLAYING_MS : SNAPSHOT_PAUSED_MS;
    const due = this.runtime.mono() + delay;
    if (this.snapshotTimer && this.snapshotAt <= due) return;
    if (this.snapshotTimer) this.runtime.clearTimeout(this.snapshotTimer);
    this.snapshotAt = due;
    const run = this.generation;
    this.snapshotTimer = this.runtime.setTimeout(() => {
      this.snapshotTimer = null;
      const ws = this.socket;
      if (run !== this.generation || !ws || !this.enabled || this.activity !== 'active') return;
      if (this.controller || this.commandPending || this.commandPhase === 'awaitingConfirmation') {
        this.scheduleSnapshot(); return;
      }
      void this.register(run, ws, this.sourceClockScope, true);
    }, delay);
  }
  recheckPlaybackObservation() {
    if (this.registered && this.observed && !this.reconciling) this.reconcileObservation();
  }
  private reconcileObservation() {
    const ws = this.socket;
    if (!this.enabled || this.activity !== 'active' || !ws || !this.connectionId || this.cooldownRemaining() > 0) return;
    // Resume and ambiguous commands require current state on this socket.
    // Retire outstanding command authority before asking for a new snapshot.
    const run = this.generation; const connection = this.connectionId;
    if (this.confirmation) this.runtime.clearTimeout(this.confirmation); this.confirmation = null;
    if (this.commandPending || this.commandPhase === 'awaitingConfirmation') this.commandPhase = 'outcomeUnknown';
    this.commandPending = null; this.commandConfirmed = null;
    for (const request of this.requests) request.abort();
    this.pendingState = null;
    this.reconciling = true; this.registered = false; this.observed = false; this.commandObserved = false; this.currentTarget = undefined;
    this.phaseStarted = this.runtime.mono(); this.armPhaseDeadline(); this.transition('registering');
    if (this.enabled && run === this.generation && this.socket === ws && connection === this.connectionId) void this.register(run, ws);
  }
  private armPhaseDeadline() {
    if (this.phaseDeadline) this.runtime.clearTimeout(this.phaseDeadline);
    const deadline = this.runtime.setTimeout(() => {
      if (this.phaseDeadline !== deadline) return;
      this.phaseDeadline = null;
      if (this.activity === 'active') this.retryObservation({ category: 'timeout', occurredAtWall: this.runtime.wall() });
    }, this.connectingWithCachedSession && !this.connectionId ? CACHED_CONNECT_DEADLINE_MS : TRANSPORT_DEADLINE_MS);
    this.phaseDeadline = deadline;
  }
  private retryObservation(error: SpotifyHealth['lastError'] = { category: 'transport', occurredAtWall: this.runtime.wall() }, reuseSession = false) {
    this.lastError = error;
    // A 401 before fallback confirmation ends this recovery. Once confirmed,
    // live 401s use the existing authentication retry budget.
    if (this.connectingWithCachedSession) this.cachedFallbackPending = true;
    if (!reuseSession || this.connectingWithCachedSession) this.reconnectSession = null;
    if (this.enabled && !this.blocked && !this.signInReason && this.reachability !== 'offline') {
      // Reserve backoff before sessionFinished can request another connection.
      const attempt = this.reconnects++;
      const delay = attempt === 0 ? 0 : attempt <= 5
        ? Math.min(30000, 2000 * 2 ** (attempt - 1) * (0.8 + this.runtime.random() * 0.4)) : 60000;
      this.observationRetryAt = this.runtime.mono() + delay;
    }
    const run = this.generation + 1;
    this.disconnect();
    if (run !== this.generation || !this.enabled || this.blocked || this.signInReason) return;
    if (this.reachability === 'offline') { this.transition('offline'); return; }
    if (this.startingConnection) {
      // A socket factory may throw while connectIfReady still owns the attempt.
      void Promise.resolve().then(() => { if (run === this.generation) this.connectIfReady(); });
    } else this.connectIfReady();
  }
  private waitForObservationRetry() {
    const delay = this.observationRetryAt - this.runtime.mono();
    if (delay <= 0) return false;
    this.nextRetry = this.runtime.wall() + delay;
    // Own the deadline before publishing: a callback may synchronously dispose us.
    this.reconnect = this.runtime.setTimeout(() => { this.reconnect = null; this.connectIfReady(); }, delay);
    this.transition('retryWait');
    return true;
  }
  private rateLimited(response: Response) {
    const value = response.headers?.get('retry-after');
    const seconds = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1000) : NaN;
    const serverDate = Date.parse(response.headers?.get('date') || '');
    const parsed = value ? Date.parse(value) - (Number.isFinite(serverDate) ? serverDate : this.runtime.wall()) : NaN;
    const duration = Math.max(1000, Number.isFinite(seconds) ? seconds : Number.isFinite(parsed) ? parsed : Math.min(300000, 30000 * 2 ** Math.min(this.rateLimits++, 4) * (1 + this.runtime.random() * 0.2)));
    this.cooldownWall = Math.max(this.cooldownWall, this.runtime.wall() + duration);
    this.cooldownMono = Math.max(this.cooldownMono, this.runtime.mono() + duration);
    this.nextRetry = this.cooldownWall;
    this.reconnectSession = null;
    this.disconnect(); this.lastError = { category: 'rateLimit', httpStatus: 429, occurredAtWall: this.runtime.wall() }; this.transition('rateLimited');
    this.callbacks.status('Spotify HTTP 429: limiting requests; waiting before reconnecting.');
    this.connectIfReady();
  }
  private bounded<T>(work: Promise<T>, controller: AbortController): Promise<T> {
    let cleanup = () => {};
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('Spotify request interrupted; playback outcome may be unknown.'));
      const timer = this.runtime.setTimeout(() => { controller.abort(); abort(); }, TRANSPORT_DEADLINE_MS);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      cleanup = () => { this.runtime.clearTimeout(timer); controller.signal.removeEventListener('abort', abort); };
      work.then(resolve, reject);
    }).finally(() => cleanup());
  }

  private async register(run: number, ws: WebSocket, sourceClockScope = this.sourceClockScope, snapshot = false, reconciliationRetry = false) {
    const connectionId = this.connectionId;
    const dealerRevision = this.dealerStateRevision;
    const reconcile = this.reconciling;
    const requestCapture = nativeDiagnosticsEnabled ? nativeClockDiagnostics?.getNativeClockCapture() : null;
    const requestStarted = nativeDiagnosticsEnabled ? this.runtime.mono() : 0;
    if (nativeDiagnosticsEnabled) nativeClockDiagnostics?.emitNativeClockDiagnostic('registration-request', { endpoint: 'connect-state-registration', method: 'PUT',
      requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null,
      registered: this.registered, cacheProvenance: 'network-request' });
    if (this.snapshotTimer) this.runtime.clearTimeout(this.snapshotTimer); this.snapshotTimer = null;
    const controller = new AbortController(); this.controller?.abort(); this.controller = controller;
    const timeout = this.runtime.setTimeout(() => controller.abort(), TRANSPORT_DEADLINE_MS);
    const alive = () => this.enabled && this.activity === 'active' && run === this.generation &&
      this.socket === ws && this.connectionId === connectionId && this.controller === controller;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json',
        'content-type': 'application/json', 'x-spotify-connection-id': this.connectionId };
      if (this.clientToken) headers['client-token'] = this.clientToken;
      const response = await this.bounded(this.runtime.fetch(this.route, { method: 'PUT', headers, body: JSON.stringify(observerBody()), signal: controller.signal }), controller);
      if (!alive()) return;
      if (this.connectingWithCachedSession && response.status === 403) {
        this.retryObservation({ category: 'authentication', httpStatus: response.status, occurredAtWall: this.runtime.wall() });
        return;
      }
      if (response.status === 401) { this.needSession('Spotify session expired. Refreshing login…', true); return; }
      if (response.status === 429) { this.rateLimited(response); return; }
      if (response.status === 403) {
        this.reconnectSession = null;
        this.cachedFallbackPending = false;
        this.blocked = true;
        const deniedRun = this.generation + 1;
        this.disconnect();
        if (deniedRun === this.generation && this.enabled) {
          this.lastError = { category: 'denied', httpStatus: 403, occurredAtWall: this.runtime.wall() };
          this.transition('denied');
        }
        return;
      }
      const headersAt = nativeDiagnosticsEnabled ? this.runtime.mono() : 0;
      if (nativeDiagnosticsEnabled) nativeClockDiagnostics?.emitNativeClockDiagnostic('registration-headers', { endpoint: 'connect-state-registration', status: response.status,
        requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null,
        currentGeneration: this.generation, alive: alive(), elapsedMs: headersAt - requestStarted });
      const bytes = new Uint8Array(await this.bounded(response.arrayBuffer(), controller));
      const receipt = timingNow();
      let errorTag: string | null = null;
      if (nativeDiagnosticsEnabled && !response.ok && nativeClockDiagnostics?.nativeClockCaptureActive()) {
        // Classify existing response bytes without logging the body or changing error handling.
        const text = new TextDecoder().decode(bytes.subarray(0, 8192));
        errorTag = /expired.?id/i.test(text) ? 'expired-id' : /connection.{0,8}not.{0,8}found/i.test(text) ? 'connection-not-found'
          : /device.{0,8}not.{0,8}found/i.test(text) ? 'device-not-found' : /gone/i.test(text) ? 'gone' : 'unclassified';
      }
      if (nativeDiagnosticsEnabled) nativeClockDiagnostics?.emitNativeClockDiagnostic('registration-body', { endpoint: 'connect-state-registration', status: response.status,
        requestGeneration: run, requestSwitchId: requestCapture?.switchId ?? null, currentGeneration: this.generation, alive: alive(), errorTag,
        requestMs: receipt.monotonicMs - requestStarted, bodyMs: receipt.monotonicMs - headersAt,
        bytes: bytes.length, pendingDealer: !!this.pendingState, cacheProvenance: 'network-response',
        receiptWall: receipt.wallMs, receiptMono: receipt.monotonicMs,
        responseAction: !response.ok ? 'no-state-emitted-existing-error-path' : 'pending-dealer-then-response-state' });
      if (!alive()) return;
      if (!response.ok) { this.retryObservation({ category: 'http', httpStatus: response.status, occurredAtWall: this.runtime.wall() }); return; }
      // A Dealer update received during this request outranks its potentially
      // older snapshot, including idle responses and device/session handoffs.
      if (snapshot && dealerRevision !== this.dealerStateRevision) return;
      const decoded = bytes.length ? decodeStateBody(bytes) : null;
      if (snapshot && !sampleFrom(decoded) && !idleState(decoded)) { this.retryObservation(); return; }
      this.registered = true;
      // A successful PUT alone is not progress. Keep the existing deadline
      // until emit confirms a recognizable active or idle observation.
      if (!snapshot) this.callbacks.status('Spotify detector connected. Play music in the Spotify app.');
      if (!alive()) return;
      // Apply any newer Dealer anchor first, so an HTTP response that was
      // generated earlier cannot undo a pause/seek received during registration.
      const pending = this.pendingState; this.pendingState = null;
      if (pending) this.emit(pending.payload, pending.receivedAt, pending.timing, pending.sourceClockScope,
        { bufferedDuringRegistration: true });
      if (alive() && bytes.length && !(reconcile && this.commandObserved)) this.emit(decoded, undefined,
        { receipt, origin: 'registration', connectionId: this.connectionId, generation: run }, sourceClockScope,
        { allowRegistrationHandoff: reconcile || (snapshot && dealerRevision === this.dealerStateRevision) });
    } catch { if (nativeDiagnosticsEnabled) nativeClockDiagnostics?.emitNativeClockDiagnostic('registration-error', { endpoint: 'connect-state-registration',
      requestGeneration: run, currentGeneration: this.generation, alive: alive(), elapsedMs: this.runtime.mono() - requestStarted,
      cacheProvenance: 'no-state-emitted' }); if (alive()) this.retryObservation(); }
    finally {
      this.runtime.clearTimeout(timeout);
      const retry = alive() && !snapshot && !this.commandObserved &&
        (this.reconciling || this.lastSourceTimestamp > 0) && !reconciliationRetry;
      if (this.controller === controller) {
        this.controller = null;
        if (retry) {
          // Retry once inside the same phase deadline. A stale response must
          // neither disarm that deadline nor wait for the regular poll.
          this.snapshotAt = this.runtime.mono() + RECONCILE_RETRY_MS;
          this.snapshotTimer = this.runtime.setTimeout(() => {
            this.snapshotTimer = null;
            if (run === this.generation && this.socket === ws && this.connectionId === connectionId &&
                this.activity === 'active' && !this.commandObserved) {
              void this.register(run, ws, sourceClockScope, false, true);
            } else {
              this.scheduleSnapshot();
            }
          }, RECONCILE_RETRY_MS);
        } else {
          this.scheduleSnapshot();
        }
      }
    }
  }
}
