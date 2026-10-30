import type { ClockStamp } from './timing-diagnostics';

export type DeliveryIdentity = Readonly<{ device: string; session: string; routeEpoch: number; authEpoch: number }>;
type Entry = Readonly<{ serverMs: number; localEpochMs: number; receipt: ClockStamp }>;
type State = { identity: DeliveryIdentity; entries: Entry[]; latestReceipt: ClockStamp; latestPlayerTimestampMs: number };
type Carry = { state: State; expiresAtMono: number };
export type DeliveryObservation = Readonly<{ serverMs: number; playerTimestampMs?: number; receipt: ClockStamp; nowMono: number; identity: DeliveryIdentity }>;

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
}

export const dealerDeliveryExperimentBounds = Object.freeze({ MAX_WINDOW_MS, MAX_CARRY_MS, MAX_FRESH_MS,
  MAX_RECEIPT_AGE_MS, MAX_CORRECTION_MS, MAX_HIGH_OUTLIER_MS, MIN_LOW_JUMP_MS, MAX_CLOCK_STEP_MS, MAX_SAMPLES });
