import type { ClockStamp } from './timing-diagnostics';

export type DeliveryIdentity = Readonly<{ device: string; session: string; routeEpoch: number; authEpoch: number }>;
type Entry = Readonly<{ serverMs: number; localEpochMs: number; receipt: ClockStamp }>;
type State = { identity: DeliveryIdentity; entries: Entry[]; latestReceipt: ClockStamp; latestPlayerTimestampMs: number };
type Carry = { state: State; expiresAtMono: number };
export type DeliveryObservation = Readonly<{ serverMs: number; playerTimestampMs?: number; receipt: ClockStamp; nowMono: number; identity: DeliveryIdentity }>;
export type DeliveryDecision = Readonly<{
  accepted: boolean;
  reason: string;
  excessMs?: number;
  playerTimestampMs?: number;
  serverMs?: number;
  receiptWallMs?: number;
  receiptMonotonicMs?: number;
  nowMono?: number;
  receiptAgeMs?: number;
  baselineFreshnessAgeMs?: number;
  baselineOffsetMs?: number;
  currentOffsetMs?: number;
  rawExcessMs?: number;
  dealerSamplesPruned?: number;
  dealerSamplesEvictedAtCapacity?: number;
  clockElapsedMs?: number;
  clockDriftMs?: number;
  clockDriftLimitMs?: number;
  sampleCount: number;
}>;

const MAX_WINDOW_MS = 10_000;
const MAX_CARRY_MS = 5_000;
const MAX_FRESH_MS = 3_000;
const MAX_RECEIPT_AGE_MS = 1_000;
const MAX_CORRECTION_MS = 500;
const MAX_HIGH_OUTLIER_MS = 1_000;
const MIN_LOW_JUMP_MS = 100;
const MAX_CLOCK_STEP_MS = 100;
const CLOCK_DRIFT_TOLERANCE_MS = 10;
const MAX_SAMPLES = 16;

const sameIdentity = (a: DeliveryIdentity, b: DeliveryIdentity) => !!a.device && !!a.session &&
  !!b.device && !!b.session && a.device === b.device && a.session === b.session &&
  a.routeEpoch === b.routeEpoch && a.authEpoch === b.authEpoch;
const validEpoch = (value: number | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value > 1_000_000_000_000;
const finiteReceipt = (receipt: ClockStamp) => Number.isFinite(receipt.wallMs) && Number.isFinite(receipt.monotonicMs) && receipt.wallMs > 1_000_000_000_000;
const copyState = (state: State): State => ({ ...state, identity: { ...state.identity }, entries: [...state.entries], latestReceipt: { ...state.latestReceipt } });

/** Experimental cross-transport comparison. It learns only Dealer receipt envelopes. */
export class DealerDeliveryBaseline {
  private state: State | null = null;
  private carry: Carry | null = null;

  clear() { this.state = null; this.carry = null; }

  /** Snapshot the bounded model so diagnostics can evaluate without driving playback state. */
  fork() {
    const snapshot = new DealerDeliveryBaseline();
    snapshot.state = this.state ? copyState(this.state) : null;
    snapshot.carry = this.carry ? { state: copyState(this.carry.state), expiresAtMono: this.carry.expiresAtMono } : null;
    return snapshot;
  }

  /** Preserve evidence only for an explicit same-instance refresh, without renewing its age. */
  preserveForExplicitRefresh(nowMono: number, identity: DeliveryIdentity) {
    const state = this.state;
    const fresh = state && sameIdentity(state.identity, identity) &&
      nowMono >= state.latestReceipt.monotonicMs && nowMono - state.latestReceipt.monotonicMs <= MAX_CARRY_MS &&
      state.entries.length > 0 && !!state.identity.device && !!state.identity.session;
    this.carry = fresh ? { state: copyState(state!), expiresAtMono: state!.latestReceipt.monotonicMs + MAX_CARRY_MS } : null;
    this.state = null;
  }

  /** Observe a Dealer envelope only after normal source ordering and identity guards pass. */
  observeDealer(observation: DeliveryObservation) {
    if (!this.validObservation(observation)) return false;
    const restored = this.restoreCarry(observation);
    if (this.carry) this.carry = null;
    let state = this.state;
    if (state && !sameIdentity(state.identity, observation.identity)) { this.clear(); state = null; }
    if (state && !this.clockContinuous(state, observation)) { this.clear(); state = null; }
    if (state && observation.playerTimestampMs! < state.latestPlayerTimestampMs) return false;
    const localEpochMs = state
      ? state.entries[0].localEpochMs + (observation.receipt.monotonicMs - state.entries[0].receipt.monotonicMs)
      : observation.receipt.wallMs;
    const serverOffset = localEpochMs - observation.serverMs;
    if (!Number.isFinite(serverOffset)) return false;
    if (state) {
      const floor = Math.min(...state.entries.map(entry => entry.localEpochMs - entry.serverMs));
      // A suddenly advanced envelope clock could create a false low envelope and
      // keep adding a large correction. Discard it and require fresh Dealer evidence.
      if (serverOffset < floor - MIN_LOW_JUMP_MS) { this.clear(); return false; }
      if (serverOffset > floor + MAX_HIGH_OUTLIER_MS) return false;
      const last = state.entries.at(-1);
      if (last && (observation.receipt.monotonicMs <= last.receipt.monotonicMs || observation.serverMs <= last.serverMs)) return false;
      state.entries = state.entries.filter(entry => observation.nowMono - entry.receipt.monotonicMs <= MAX_WINDOW_MS);
      state.entries.push({ serverMs: observation.serverMs, localEpochMs, receipt: { ...observation.receipt } });
      if (state.entries.length > MAX_SAMPLES) state.entries.shift();
      state.latestReceipt = { ...observation.receipt };
      state.latestPlayerTimestampMs = observation.playerTimestampMs!;
    } else {
      this.state = { identity: { ...observation.identity }, entries: [{ serverMs: observation.serverMs,
        localEpochMs, receipt: { ...observation.receipt } }], latestReceipt: { ...observation.receipt },
        latestPlayerTimestampMs: observation.playerTimestampMs! };
    }
    return !restored || !!this.state;
  }

  observeDealerDecision(observation: DeliveryObservation): DeliveryDecision {
    const base = this.decisionContext(observation);
    const invalid = this.invalidReason(observation);
    if (invalid) return { ...base, accepted: false, reason: invalid };
    const hadCarry = !!this.carry;
    const restored = this.restoreCarry(observation);
    if (this.carry) this.carry = null;
    let state = this.state;
    let resetReason: string | undefined;
    let clockEvidence: Pick<DeliveryDecision, 'clockElapsedMs' | 'clockDriftMs' | 'clockDriftLimitMs'> = {};
    if (hadCarry && !restored) resetReason = 'dealer-carried-baseline-expired-or-mismatched-reseed';
    if (state && !sameIdentity(state.identity, observation.identity)) { this.clear(); state = null; resetReason = 'dealer-identity-changed-reseed'; }
    if (state && !this.clockContinuous(state, observation)) {
      clockEvidence = this.clockDiscontinuityEvidence(state, observation);
      this.clear(); state = null; resetReason = 'dealer-clock-discontinuity-reseed';
    }
    if (state && observation.playerTimestampMs! < state.latestPlayerTimestampMs)
      return { ...base, accepted: false, reason: 'dealer-player-timestamp-regressed', sampleCount: state.entries.length };
    const localEpochMs = state
      ? state.entries[0].localEpochMs + (observation.receipt.monotonicMs - state.entries[0].receipt.monotonicMs)
      : observation.receipt.wallMs;
    const serverOffset = localEpochMs - observation.serverMs;
    if (!Number.isFinite(serverOffset)) return { ...base, accepted: false, reason: 'dealer-offset-nonfinite', sampleCount: state?.entries.length ?? 0 };
    if (state) {
      const floor = Math.min(...state.entries.map(entry => entry.localEpochMs - entry.serverMs));
      // A suddenly advanced envelope clock could create a false low envelope and
      // keep adding a large correction. Discard it and require fresh Dealer evidence.
      if (serverOffset < floor - MIN_LOW_JUMP_MS) {
        this.clear();
        return { ...base, accepted: false, reason: 'dealer-low-envelope-jump-reset', baselineOffsetMs: floor,
          currentOffsetMs: serverOffset, rawExcessMs: serverOffset - floor, sampleCount: 0 };
      }
      if (serverOffset > floor + MAX_HIGH_OUTLIER_MS)
        return { ...base, accepted: false, reason: 'dealer-high-envelope-outlier', baselineOffsetMs: floor,
          currentOffsetMs: serverOffset, rawExcessMs: serverOffset - floor, sampleCount: state.entries.length };
      const last = state.entries.at(-1);
      if (last && (observation.receipt.monotonicMs <= last.receipt.monotonicMs || observation.serverMs <= last.serverMs))
        return { ...base, accepted: false, reason: 'dealer-duplicate-or-out-of-order', baselineOffsetMs: floor,
          currentOffsetMs: serverOffset, rawExcessMs: serverOffset - floor, sampleCount: state.entries.length };
      const entriesBeforeWindow = state.entries.length;
      state.entries = state.entries.filter(entry => observation.nowMono - entry.receipt.monotonicMs <= MAX_WINDOW_MS);
      const dealerSamplesPruned = entriesBeforeWindow - state.entries.length;
      state.entries.push({ serverMs: observation.serverMs, localEpochMs, receipt: { ...observation.receipt } });
      const dealerSamplesEvictedAtCapacity = state.entries.length > MAX_SAMPLES ? 1 : 0;
      if (dealerSamplesEvictedAtCapacity) state.entries.shift();
      state.latestReceipt = { ...observation.receipt };
      state.latestPlayerTimestampMs = observation.playerTimestampMs!;
      const accepted = !restored || !!this.state;
      return { ...base, accepted, reason: resetReason ?? (accepted ? 'dealer-envelope-recorded' : 'dealer-baseline-unavailable'),
        baselineOffsetMs: Math.min(...state.entries.map(entry => entry.localEpochMs - entry.serverMs)),
        currentOffsetMs: serverOffset, dealerSamplesPruned, dealerSamplesEvictedAtCapacity,
        sampleCount: state.entries.length, ...clockEvidence };
    } else {
      this.state = { identity: { ...observation.identity }, entries: [{ serverMs: observation.serverMs,
        localEpochMs, receipt: { ...observation.receipt } }], latestReceipt: { ...observation.receipt },
        latestPlayerTimestampMs: observation.playerTimestampMs! };
    }
    const accepted = !restored || !!this.state;
    return { ...base, accepted, reason: resetReason ?? (accepted ? (restored ? 'dealer-carried-baseline-updated' : 'dealer-envelope-recorded') : 'dealer-baseline-unavailable'),
      baselineOffsetMs: this.state ? Math.min(...this.state.entries.map(entry => entry.localEpochMs - entry.serverMs)) : undefined,
      currentOffsetMs: serverOffset, sampleCount: this.state?.entries.length ?? 0, ...clockEvidence };
  }

  /** Freeze one finite excess on registration; never incorporate registration into the envelope. */
  registrationExcess(observation: DeliveryObservation, playing: boolean): number | undefined {
    if (!this.validObservation(observation)) return undefined;
    if (this.carry) {
      if (!this.restoreCarry(observation)) { this.carry = null; return undefined; }
      this.carry = null;
    }
    const state = this.state;
    if (!state || !sameIdentity(state.identity, observation.identity) || !this.clockContinuous(state, observation)) {
      this.clear(); return undefined;
    }
    if (observation.playerTimestampMs! < state.latestPlayerTimestampMs) return undefined;
    if (!playing) return 0;
    const latestAge = observation.nowMono - state.latestReceipt.monotonicMs;
    if (latestAge < 0 || latestAge > MAX_FRESH_MS || observation.nowMono - observation.receipt.monotonicMs > MAX_RECEIPT_AGE_MS) return undefined;
    const localEpochMs = state.entries[0].localEpochMs +
      (observation.receipt.monotonicMs - state.entries[0].receipt.monotonicMs);
    const currentOffset = localEpochMs - observation.serverMs;
    const baseline = Math.min(...state.entries.map(entry => entry.localEpochMs - entry.serverMs));
    const excess = currentOffset - baseline;
    if (!Number.isFinite(excess) || excess < -MIN_LOW_JUMP_MS || excess > MAX_CORRECTION_MS) return undefined;
    return Math.max(0, excess);
  }

  registrationDecision(observation: DeliveryObservation, playing: boolean): DeliveryDecision {
    const base = this.decisionContext(observation);
    const invalid = this.invalidReason(observation);
    if (invalid) return { ...base, accepted: false, reason: `registration-${invalid}`, sampleCount: this.state?.entries.length ?? 0 };
    if (this.carry) {
      if (!this.restoreCarry(observation)) {
        this.carry = null;
        return { ...base, accepted: false, reason: 'registration-carried-baseline-expired-or-mismatched', sampleCount: this.state?.entries.length ?? 0 };
      }
      this.carry = null;
    }
    const state = this.state;
    if (!state || !sameIdentity(state.identity, observation.identity) || !this.clockContinuous(state, observation)) {
      const reason = !state ? 'registration-baseline-unavailable' : !sameIdentity(state.identity, observation.identity)
        ? 'registration-identity-mismatch' : 'registration-clock-discontinuity';
      this.clear(); return { ...base, accepted: false, reason, sampleCount: 0 };
    }
    const baseline = Math.min(...state.entries.map(entry => entry.localEpochMs - entry.serverMs));
    if (observation.playerTimestampMs! < state.latestPlayerTimestampMs)
      return { ...base, accepted: false, reason: 'registration-player-timestamp-regressed', baselineOffsetMs: baseline, sampleCount: state.entries.length };
    if (!playing) return { ...base, accepted: true, reason: 'paused-no-correction', excessMs: 0,
      baselineOffsetMs: baseline, sampleCount: state.entries.length };
    const latestAge = observation.nowMono - state.latestReceipt.monotonicMs;
    if (latestAge < 0 || latestAge > MAX_FRESH_MS)
      return { ...base, accepted: false, reason: 'registration-baseline-stale', baselineFreshnessAgeMs: latestAge,
        baselineOffsetMs: baseline, sampleCount: state.entries.length };
    if (observation.nowMono - observation.receipt.monotonicMs > MAX_RECEIPT_AGE_MS)
      return { ...base, accepted: false, reason: 'registration-receipt-too-old', baselineFreshnessAgeMs: latestAge,
        baselineOffsetMs: baseline, sampleCount: state.entries.length };
    const localEpochMs = state.entries[0].localEpochMs +
      (observation.receipt.monotonicMs - state.entries[0].receipt.monotonicMs);
    const currentOffset = localEpochMs - observation.serverMs;
    const excess = currentOffset - baseline;
    if (!Number.isFinite(excess)) return { ...base, accepted: false, reason: 'registration-excess-nonfinite',
      baselineFreshnessAgeMs: latestAge, baselineOffsetMs: baseline, currentOffsetMs: currentOffset, rawExcessMs: excess, sampleCount: state.entries.length };
    if (excess < -MIN_LOW_JUMP_MS) return { ...base, accepted: false, reason: 'registration-below-envelope-reset-required',
      baselineFreshnessAgeMs: latestAge, baselineOffsetMs: baseline, currentOffsetMs: currentOffset, rawExcessMs: excess, sampleCount: state.entries.length };
    if (excess > MAX_CORRECTION_MS) return { ...base, accepted: false, reason: 'registration-excess-over-cap',
      baselineFreshnessAgeMs: latestAge, baselineOffsetMs: baseline, currentOffsetMs: currentOffset, rawExcessMs: excess, sampleCount: state.entries.length };
    const applied = Math.max(0, excess);
    return { ...base, accepted: true, reason: applied > 0 ? 'registration-excess-within-cap' : 'registration-at-envelope',
      excessMs: applied, baselineFreshnessAgeMs: latestAge, baselineOffsetMs: baseline,
      currentOffsetMs: currentOffset, rawExcessMs: excess, sampleCount: state.entries.length };
  }

  private decisionContext(observation: DeliveryObservation): DeliveryDecision {
    return { accepted: false, reason: 'unclassified', playerTimestampMs: observation.playerTimestampMs,
      serverMs: observation.serverMs, receiptWallMs: observation.receipt?.wallMs,
      receiptMonotonicMs: observation.receipt?.monotonicMs, nowMono: observation.nowMono,
      receiptAgeMs: observation.nowMono - (observation.receipt?.monotonicMs ?? Number.NaN),
      sampleCount: this.state?.entries.length ?? 0 };
  }

  private invalidReason(observation: DeliveryObservation): string | undefined {
    if (!validEpoch(observation.serverMs)) return 'invalid-server-timestamp';
    if (!validEpoch(observation.playerTimestampMs)) return 'invalid-player-timestamp';
    if (observation.serverMs < observation.playerTimestampMs!) return 'server-before-player-timestamp';
    if (!finiteReceipt(observation.receipt)) return 'invalid-receipt-clock-pair';
    if (!Number.isFinite(observation.nowMono)) return 'invalid-processing-monotonic-time';
    const age = observation.nowMono - observation.receipt.monotonicMs;
    if (age < 0) return 'receipt-from-future';
    if (age > MAX_RECEIPT_AGE_MS) return 'receipt-too-old';
    if (!observation.identity.device || !observation.identity.session) return 'missing-device-or-session-identity';
    return undefined;
  }

  private validObservation(observation: DeliveryObservation) {
    const age = observation.nowMono - observation.receipt.monotonicMs;
    return validEpoch(observation.serverMs) && validEpoch(observation.playerTimestampMs) &&
      observation.serverMs >= observation.playerTimestampMs! && finiteReceipt(observation.receipt) &&
      Number.isFinite(observation.nowMono) && age >= 0 && age <= MAX_RECEIPT_AGE_MS &&
      !!observation.identity.device && !!observation.identity.session;
  }

  private restoreCarry(observation: DeliveryObservation) {
    const carry = this.carry;
    if (!carry) return false;
    if (observation.nowMono > carry.expiresAtMono || !sameIdentity(carry.state.identity, observation.identity) ||
      !this.clockContinuous(carry.state, observation)) { this.carry = null; return false; }
    this.state = copyState(carry.state);
    this.carry = null;
    return true;
  }

  private clockContinuous(state: State, observation: DeliveryObservation) {
    const previous = state.latestReceipt;
    const elapsed = observation.receipt.monotonicMs - previous.monotonicMs;
    if (elapsed <= 0) return false;
    const nextOffset = observation.receipt.wallMs - observation.receipt.monotonicMs;
    const origin = state.entries[0];
    const originOffset = origin.localEpochMs - origin.receipt.monotonicMs;
    const totalElapsed = observation.receipt.monotonicMs - origin.receipt.monotonicMs;
    const drift = Math.abs(nextOffset - originOffset);
    const limit = Math.min(MAX_CLOCK_STEP_MS, Math.max(CLOCK_DRIFT_TOLERANCE_MS, totalElapsed * 0.0002));
    if (drift > limit) return false;
    return true;
  }

  private clockDiscontinuityEvidence(state: State, observation: DeliveryObservation) {
    const previous = state.latestReceipt;
    const elapsed = observation.receipt.monotonicMs - previous.monotonicMs;
    const nextOffset = observation.receipt.wallMs - observation.receipt.monotonicMs;
    const origin = state.entries[0];
    const originOffset = origin.localEpochMs - origin.receipt.monotonicMs;
    const totalElapsed = observation.receipt.monotonicMs - origin.receipt.monotonicMs;
    const drift = Math.abs(nextOffset - originOffset);
    const limit = Math.min(MAX_CLOCK_STEP_MS, Math.max(CLOCK_DRIFT_TOLERANCE_MS, totalElapsed * 0.0002));
    return { clockElapsedMs: elapsed, clockDriftMs: drift, clockDriftLimitMs: limit };
  }
}

export const dealerDeliveryExperimentBounds = Object.freeze({ MAX_WINDOW_MS, MAX_CARRY_MS, MAX_FRESH_MS,
  MAX_RECEIPT_AGE_MS, MAX_CORRECTION_MS, MAX_HIGH_OUTLIER_MS, MIN_LOW_JUMP_MS, MAX_CLOCK_STEP_MS,
  CLOCK_DRIFT_TOLERANCE_MS, MAX_SAMPLES });
