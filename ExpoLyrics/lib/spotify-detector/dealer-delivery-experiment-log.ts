import { dealerDeliveryExperimentBounds, type DeliveryDecision } from './dealer-delivery-baseline';

const MARKER = '[Spotify delivery experiment]';
const WINDOW_MS = 10_000;
const MAX_WINDOW_LINES = 12;
const MAX_SESSION_LINES = 120;
let windowStartedAt = 0;
let windowLines = 0;
let sessionLines = 0;
let sequence = 0;
const REASONS = new Set([
  'dealer-envelope-recorded', 'dealer-carried-baseline-updated', 'dealer-baseline-unavailable',
  'dealer-player-timestamp-regressed', 'dealer-offset-nonfinite', 'dealer-low-envelope-jump-reset',
  'dealer-high-envelope-outlier', 'dealer-duplicate-or-out-of-order', 'dealer-missing-valid-timestamp-pair',
  'dealer-identity-changed-reseed', 'dealer-clock-discontinuity-reseed',
  'dealer-carried-baseline-expired-or-mismatched-reseed',
  'registration-conflicts-with-dealer-identity', 'source-timestamp-older-than-watermark',
  'invalid-server-timestamp', 'invalid-player-timestamp', 'server-before-player-timestamp',
  'invalid-receipt-clock-pair', 'invalid-processing-monotonic-time', 'receipt-from-future', 'receipt-too-old',
  'missing-device-or-session-identity', 'registration-invalid-server-timestamp', 'registration-invalid-player-timestamp',
  'registration-server-before-player-timestamp', 'registration-invalid-receipt-clock-pair',
  'registration-invalid-processing-monotonic-time', 'registration-receipt-from-future', 'registration-receipt-too-old',
  'registration-missing-device-or-session-identity', 'registration-carried-baseline-expired-or-mismatched',
  'registration-baseline-unavailable', 'registration-identity-mismatch', 'registration-clock-discontinuity',
  'registration-player-timestamp-regressed', 'paused-no-correction', 'registration-baseline-stale',
  'registration-receipt-too-old', 'registration-excess-nonfinite', 'registration-below-envelope-reset-required',
  'registration-excess-over-cap', 'registration-excess-within-cap', 'registration-at-envelope',
  'registration-missing-valid-timestamp-pair',
]);

/** Bounded native-console diagnostics. Inputs are numeric decision evidence and fixed reason codes only. */
export function logDealerDeliveryDecision(stage: 'dealer-envelope' | 'registration-correction', decision: DeliveryDecision) {
  if (!(typeof __DEV__ !== 'undefined' && __DEV__)) return false;
  const now = typeof performance !== 'undefined' ? performance.now() : Number.NaN;
  if (!Number.isFinite(now)) return false;
  if (now < windowStartedAt || now - windowStartedAt >= WINDOW_MS) {
    windowStartedAt = now;
    windowLines = 0;
  }
  if (sessionLines >= MAX_SESSION_LINES || windowLines >= MAX_WINDOW_LINES) return false;
  windowLines++;
  sessionLines++;
  const acceptedCorrection = stage === 'registration-correction' && decision.accepted && (decision.excessMs ?? 0) > 0;
  const event = {
    schema: 1,
    sequence: ++sequence,
    stage,
    outcome: stage === 'dealer-envelope' ? (decision.accepted ? 'baseline-observed' : 'rejected')
      : acceptedCorrection ? 'correction-applied' : decision.accepted ? 'no-correction' : 'fallback',
    reason: REASONS.has(decision.reason) ? decision.reason : 'unclassified',
    units: 'ms',
    processedAtMonotonicMs: now,
    receiptWallMs: finite(decision.receiptWallMs),
    receiptMonotonicMs: finite(decision.receiptMonotonicMs),
    processedMonotonicMs: finite(decision.nowMono),
    playerTimestampMs: finite(decision.playerTimestampMs),
    serverTimestampMs: finite(decision.serverMs),
    receiptAgeMs: finite(decision.receiptAgeMs),
    baselineFreshnessAgeMs: finite(decision.baselineFreshnessAgeMs),
    baselineOffsetMs: finite(decision.baselineOffsetMs),
    currentEnvelopeOffsetMs: finite(decision.currentOffsetMs),
    rawExcessMs: finite(decision.rawExcessMs),
    frozenExcessMs: finite(decision.excessMs),
    dealerSamplesPruned: finite(decision.dealerSamplesPruned),
    dealerSamplesEvictedAtCapacity: finite(decision.dealerSamplesEvictedAtCapacity),
    clockElapsedMs: finite(decision.clockElapsedMs),
    clockDriftMs: finite(decision.clockDriftMs),
    clockDriftLimitMs: finite(decision.clockDriftLimitMs),
    dealerSampleCount: Number.isInteger(decision.sampleCount) ? Math.max(0, Math.min(16, decision.sampleCount)) : 0,
    cutoffsMs: dealerDeliveryExperimentBounds,
    rateLimit: { windowMs: WINDOW_MS, maxPerWindow: MAX_WINDOW_LINES, maxPerSession: MAX_SESSION_LINES },
  };
  try { console.log(`${MARKER} ${JSON.stringify(event)}`); } catch { /* Diagnostics cannot affect the detector. */ }
  return true;
}

function finite(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
