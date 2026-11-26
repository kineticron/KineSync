export const PLAYBACK_INTENT_TTL_MS = 12_000;
export const PLAYBACK_CONFIRMATION_MS = 5_000;

export type PlaybackOperation = 'pause' | 'resume' | 'next' | 'previous' | 'seek' | 'resync';
export type PlaybackRestrictions = Readonly<Partial<Record<PlaybackOperation, boolean>>>;
export type PlaybackCommand =
  | { type: 'play'; playing: boolean }
  | { type: 'next' | 'previous' }
  | { type: 'resync' }
  | { type: 'seek'; positionMs: number };

export type PlaybackObservation = {
  revision: number;
  trackId: string;
  sessionId?: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  observedAt: number;
};

export type PlaybackCommandState = {
  ready: boolean;
  // An accepted observation can exist while a command keeps dispatch busy.
  // A lifecycle gate can also retain a sample for display while it is stale.
  fresh?: boolean;
  targetId?: string;
  blocked?: PlaybackRestrictions;
  // undefined means transport is unable to observe. null is a confirmed idle player.
  observation?: PlaybackObservation | null;
};

export type PlaybackCommandResult = 'sent' | 'rejected' | 'unknown';
type Timer = ReturnType<typeof setTimeout>;
type Runtime = {
  now: () => number;
  setTimeout: (fn: () => void, delay: number) => Timer;
  clearTimeout: (timer: Timer) => void;
};

export type SendPlaybackCommand = (command: PlaybackCommand, observation: PlaybackObservation, expiresAt: number) =>
  PlaybackCommandResult | Promise<PlaybackCommandResult>;

export type PlaybackControlAnchor = {
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  isPlaying: boolean;
};

export type PlaybackCommandView = {
  anchor?: PlaybackControlAnchor;
  playing?: boolean;
  observedPlaying?: boolean;
  seekEpoch?: number;
  seekPreviewPositionMs?: number;
  playPending: boolean;
  seekPending: boolean;
  nextPending: boolean;
  previousPending: boolean;
  blocked: PlaybackRestrictions;
};

type Intent = {
  command: PlaybackCommand;
  expiresAt: number;
  trackEpoch: number;
};

type Flight = {
  intent: Intent;
  before: PlaybackObservation;
  deadline: number;
  sentAt: number;
  settled: boolean;
  confirmed: boolean;
  sawPause: boolean;
};

const NO_RESTRICTIONS = {};
const EMPTY_VIEW: PlaybackCommandView = {
  playPending: false, seekPending: false, nextPending: false, previousPending: false,
  blocked: NO_RESTRICTIONS,
};
const OPERATIONS: PlaybackOperation[] = ['pause', 'resume', 'next', 'previous', 'seek', 'resync'];

export function playbackOperation(command: PlaybackCommand): PlaybackOperation {
  return command.type === 'play' ? (command.playing ? 'resume' : 'pause') : command.type;
}

function project(observation: PlaybackObservation, at: number) {
  return observation.positionMs + (observation.playing ? Math.max(0, at - observation.observedAt) : 0);
}

function playbackRestarted(before: PlaybackObservation, after: PlaybackObservation, afterSkip: boolean) {
  const backwardJump = before.positionMs - after.positionMs;
  if (after.positionMs >= 2000 || backwardJump < 750) return false;
  // A return to the opening quarter-second is stronger evidence than a
  // correction elsewhere near the start. Require a sizable raw jump.
  return afterSkip || (after.positionMs <= 250 && backwardJump >= 1250) ||
    project(before, after.observedAt) - after.positionMs >= 2000;
}

/** User intents and confirmation policy. All authority and time are supplied by the caller. */
export class PlaybackCommandQueue {
  private scope: unknown;
  private send?: SendPlaybackCommand;
  private requestObservation?: () => void;
  private ready = false;
  private blocked: PlaybackRestrictions = NO_RESTRICTIONS;
  private targetId?: string;
  private observation?: PlaybackObservation;
  private trackEpoch = 0;
  private needsRevisionAfter = -Infinity;
  private pending: Intent[] = [];
  private flight?: Flight;
  private timer?: Timer;
  private view = EMPTY_VIEW;
  private anchorOwners?: { play?: Intent; seek?: Intent; epoch: number };
  private listeners = new Set<() => void>();

  constructor(private runtime: Runtime) {}

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setTransport(scope: unknown, send?: SendPlaybackCommand, requestObservation?: () => void) {
    if (scope === this.scope && send === this.send && requestObservation === this.requestObservation) return;
    this.scope = scope;
    this.send = send;
    this.requestObservation = requestObservation;
    this.targetId = undefined;
    this.observation = undefined;
    this.blocked = NO_RESTRICTIONS;
    this.ready = false;
    this.needsRevisionAfter = -Infinity;
    this.trackEpoch++;
    this.cancel();
  }

  cancel() {
    this.pending = [];
    this.flight = undefined;
    this.flush();
  }

  update(state: PlaybackCommandState) {
    const sample = state.observation;
    const last = this.observation;
    if (sample && last && sample.revision < last.revision) return;
    const fresh = state.fresh ?? sample !== undefined;
    this.ready = state.ready && fresh && !!sample;
    if (state.targetId && this.targetId && state.targetId !== this.targetId) {
      this.pending = [];
      this.flight = undefined;
      this.observation = undefined;
      this.trackEpoch++;
    }
    if (state.targetId) this.targetId = state.targetId;
    // Keep explicit restrictions through a transport outage until its replacement observes.
    if (state.blocked) this.blocked = state.blocked;

    const before = this.observation;
    if (sample === null) {
      if (before) this.trackEpoch++;
      this.observation = undefined;
    } else if (sample && (!before || sample.revision > before.revision)) {
      const newTrack = !!before && (sample.trackId !== before.trackId ||
        (!!sample.sessionId && !!before.sessionId && sample.sessionId !== before.sessionId));
      const flight = this.flight;
      const flightCommand = flight?.intent.command.type;
      const checkingSkip = flight && !flight.confirmed && (flightCommand === 'next' || flightCommand === 'previous');
      const expectedSeek = flightCommand === 'seek' && flight && this.confirms(flight, sample, false);
      const restartBaseline = checkingSkip ? flight.before : before;
      const restarted = !newTrack && !expectedSeek && !!restartBaseline &&
        playbackRestarted(restartBaseline, sample, !!checkingSkip);
      if (newTrack || restarted) this.trackEpoch++;
      if (before && Math.abs(sample.positionMs - project(before, sample.observedAt)) > 2000 &&
          !this.view.seekPending) this.anchorOwners = undefined;
      this.observation = !newTrack && !sample.sessionId && before?.sessionId
        ? { ...sample, sessionId: before.sessionId } : sample;
      if (fresh && flight && sample.revision > flight.before.revision) {
        flight.confirmed ||= this.confirms(flight, sample, newTrack || restarted);
      }
    }
    if (!fresh) this.needsRevisionAfter = Math.max(this.needsRevisionAfter, sample?.revision ?? last?.revision ?? -Infinity);
    this.flush();
  }

  toggle() {
    const playing = this.view.playing ?? this.view.observedPlaying;
    return playing !== undefined && this.enqueue({ type: 'play', playing: !playing });
  }

  enqueue(command: PlaybackCommand, expectedSeekEpoch?: number | null) {
    if (!this.send || this.blocked[playbackOperation(command)]) return false;
    if (command.type === 'seek') {
      if (!this.observation || !Number.isFinite(command.positionMs) ||
          (expectedSeekEpoch !== undefined && expectedSeekEpoch !== this.trackEpoch)) return false;
      const duration = this.observation.durationMs || Infinity;
      command = { type: 'seek', positionMs: Math.round(Math.max(0, Math.min(duration, command.positionMs))) };
    }
    if (command.type === 'play' || command.type === 'seek') {
      this.pending = this.pending.filter(intent => intent.command.type !== command.type);
    }
    this.pending.push({ command, expiresAt: this.runtime.now() + PLAYBACK_INTENT_TTL_MS, trackEpoch: this.trackEpoch });
    this.flush();
    return true;
  }

  private confirms(flight: Flight, sample: PlaybackObservation, trackChanged: boolean) {
    const command = flight.intent.command;
    if (command.type === 'play') return sample.playing === command.playing;
    if (command.type === 'resync') {
      flight.sawPause ||= !sample.playing;
      return trackChanged || (flight.sawPause && sample.playing);
    }
    if (command.type === 'seek') {
      if (flight.intent.trackEpoch !== this.trackEpoch) return false;
      const expected = command.positionMs + (sample.playing ? Math.max(0, sample.observedAt - flight.sentAt) : 0);
      return Math.abs(sample.positionMs - command.positionMs) <= 1000 || Math.abs(sample.positionMs - expected) <= 1000;
    }
    // Previous can restart the same item. A backward discontinuity near its
    // beginning can settle either skip, including repeat-one transitions.
    return trackChanged;
  }

  private finish(flight: Flight, result: PlaybackCommandResult) {
    if (this.flight !== flight) return;
    flight.settled = true;
    if (result === 'rejected') this.flight = undefined;
    this.flush();
  }

  private flush() {
    if (this.timer !== undefined) this.runtime.clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.runtime.now();
    this.pending = this.pending.filter(intent =>
      now < intent.expiresAt && !this.blocked[playbackOperation(intent.command)] &&
      (intent.command.type !== 'seek' || intent.trackEpoch === this.trackEpoch));

    const flight = this.flight;
    let needsObservation = false;
    if (flight && ((flight.settled && flight.confirmed) || now >= flight.deadline)) {
      if (!flight.confirmed) {
        this.needsRevisionAfter = Math.max(this.needsRevisionAfter, this.observation?.revision ?? flight.before.revision);
        needsObservation = true;
      }
      this.flight = undefined;
    }

    const observation = this.observation;
    const send = this.send;
    while (!this.flight && this.ready && observation && observation.revision > this.needsRevisionAfter && send && this.pending.length) {
      const intent = this.pending.shift()!;
      if (intent.command.type === 'play' && intent.command.playing === observation.playing) continue;
      if (intent.command.type === 'resync' && !observation.playing) continue;
      const next = { intent, before: observation, sentAt: now, settled: false, confirmed: false, sawPause: false,
        deadline: Math.min(intent.expiresAt, now + PLAYBACK_CONFIRMATION_MS) };
      this.flight = next;
      this.schedule(now);
      this.publish(now);
      if (this.flight !== next) return;
      // The transport can publish synchronous health events during send.
      // Install the flight first so those events cannot dispatch it again.
      try {
        const result = send(intent.command, observation, intent.expiresAt);
        if (typeof result === 'string') this.finish(next, result);
        else void result.then(value => this.finish(next, value), () => this.finish(next, 'unknown'));
      } catch {
        this.finish(next, 'unknown');
      }
      return;
    }

    this.publish(now);
    this.schedule(now);
    if (needsObservation) this.requestObservation?.();
  }

  private schedule(now: number) {
    const deadline = Math.min(this.flight?.deadline ?? Infinity, ...this.pending.map(intent => intent.expiresAt));
    if (deadline < Infinity) this.timer = this.runtime.setTimeout(() => this.flush(), Math.max(0, deadline - now));
  }

  private publish(now: number) {
    const active = this.flight && !this.flight.confirmed ? this.flight.intent : undefined;
    const latest = (type: PlaybackCommand['type']) =>
      [...this.pending].reverse().find(intent => intent.command.type === type) ??
      (active?.command.type === type ? active : undefined);
    const play = latest('play');
    const seekCandidate = latest('seek');
    const seek = seekCandidate?.trackEpoch === this.trackEpoch ? seekCandidate : undefined;
    const playing = play?.command.type === 'play' ? play.command.playing : undefined;
    const sample = this.observation;
    const isPlaying = playing ?? sample?.playing;
    const priorAnchor = this.view.anchor;
    let anchor = priorAnchor;
    const owners = this.anchorOwners;
    if (!owners || play !== owners.play || seek !== owners.seek || this.trackEpoch !== owners.epoch ||
        (anchor && anchor.isPlaying !== isPlaying)) {
      const continuingSeek = seek && seek === owners?.seek && this.trackEpoch === owners?.epoch ? priorAnchor : undefined;
      const position = continuingSeek
        ? continuingSeek.anchorPositionMs + (continuingSeek.isPlaying ? Math.max(0, now - continuingSeek.anchorMonotonicMs) : 0)
        : seek?.command.type === 'seek' ? seek.command.positionMs : sample ? project(sample, now) : 0;
      anchor = (seek || play) && sample && isPlaying !== undefined ? {
        anchorPositionMs: Math.min(sample.durationMs || Infinity, position),
        anchorMonotonicMs: now,
        isPlaying,
      } : undefined;
      this.anchorOwners = { play, seek, epoch: this.trackEpoch };
    }

    const blocked = OPERATIONS.every(op => !!this.view.blocked[op] === !!this.blocked[op]) ? this.view.blocked : this.blocked;
    const next = {
      anchor, playing, observedPlaying: this.observation?.playing,
      seekEpoch: this.observation ? this.trackEpoch : undefined,
      seekPreviewPositionMs: seek?.command.type === 'seek' ? seek.command.positionMs : undefined,
      playPending: !!play || !!latest('resync'), seekPending: !!seek,
      nextPending: !!latest('next'), previousPending: !!latest('previous'), blocked,
    };
    if (Object.keys(next).every(key => next[key as keyof PlaybackCommandView] === this.view[key as keyof PlaybackCommandView])) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }
}
