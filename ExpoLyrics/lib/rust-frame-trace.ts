export type Distribution = { count: number; p50: number; p95: number; worst: number };
export type CallbackSummary = {
  requestedHz: number;
  activeCallbackHz?: number;
  windowCallbackHz?: number;
  windowMs: number;
  callbackIntervalMs?: Distribution;
  budgetMs?: number;
  phase: string;
  deliveredCallbacks: number;
  busyCallbacks: number;
  inactiveCallbacks: number;
  idleCallbacks: number;
  estimatedMissedCallbackVsyncs: number;
  overwritten: number;
  previousSummaryCpuMs: number;
  recordCpuMs?: Distribution;
};
export type WorkerSummary = {
  activePresentCallHz: number | null;
  windowPresentCallHz: number | null;
  presentIntervalMs: Distribution | null;
  encodeMs: Distribution | null;
  acquireMs: Distribution | null;
  gpuMs: Distribution | null;
  gpuUnavailable: string | null;
  drawableUnavailable: string;
  latestGpu: { frameId: number; ageMs: number; readbackLatencyMs: number } | null;
  nativeBookkeepingMs: Distribution | null;
  gpuMarkerCpuMs: Distribution | null;
  collectCpuMsTotal: number;
  previousSnapshotCpuMs: number;
  capacitySkips: number;
  noDrawable: number;
  awaitingInput: number;
  failed: number;
  overwritten: number;
  gpuSlotsFull: number;
  gpuReadbackFailed: number;
  gpuLate: number;
};
export type CaptureIdentity = { token: number; generation: number; surface: number };
export type TraceEvent = CaptureIdentity & { worker: string; callbacks: CallbackSummary; snapshotMs: number; session: string };
export type TraceReset = CaptureIdentity & { session: string; active: boolean };
export type TraceGate = { session: string; minimumToken: number; active: boolean; visibleSince: number };
export type TraceExport = {
  json: string;
  expected: Omit<CaptureIdentity, 'token'> & { session: string; minimumToken: number; token?: number };
  isCurrent: () => boolean;
};
export type LegacyMetrics = { generation: number; presentCallRate: number; deliveredCallbackHz: number; displayIntervalMs: number; cpuEncodeMs: number };
export type TraceUpdate = { kind: 'trace'; event: TraceEvent } | { kind: 'legacy'; event: LegacyMetrics } | { kind: 'reset' };

export function applyTraceReset(gate: TraceGate, reset: TraceReset) {
  if (reset.session !== gate.session || !Number.isSafeInteger(reset.token) || reset.token <= gate.minimumToken) return false;
  gate.minimumToken = reset.token;
  gate.active = reset.active;
  return true;
}

export function acceptsTraceSummary(gate: TraceGate, event: TraceEvent) {
  return gate.active && gate.session === event.session && gate.minimumToken === event.token &&
    event.snapshotMs >= gate.visibleSince;
}

export function traceScalarPages(rows: ReadonlyArray<{ label: string; stats: Distribution | null | undefined }>) {
  return rows.flatMap(({ label, stats }) => (['p50', 'p95', 'worst'] as const).map(percentile => ({
    label: label + ' · ' + percentile,
    value: stats?.[percentile],
  })));
}

export const traceScenarios = [
  'Spicy translated', 'Spicy untranslated', 'AMLL steady', 'AMLL autoscroll', 'AMLL drag', 'AMLL far-return',
] as const;
export type TraceScenario = (typeof traceScenarios)[number];

export function budgetTone(value: number | null | undefined, budgetMs: number | undefined) {
  if (value == null || budgetMs == null || !Number.isFinite(value) || !Number.isFinite(budgetMs) || budgetMs <= 0) return 'neutral';
  if (value <= budgetMs * 1.05) return 'good';
  if (value <= budgetMs * 1.25) return 'warn';
  return 'bad';
}

function sameCapture(left: CaptureIdentity | undefined, right: CaptureIdentity | undefined) {
  return !!left && !!right && left.token === right.token && left.generation === right.generation && left.surface === right.surface;
}

export function decodeWorker(value: string, expected?: CaptureIdentity): WorkerSummary | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(value) as { capture?: CaptureIdentity; summary?: WorkerSummary };
    return !expected || sameCapture(decoded.capture, expected) ? decoded.summary ?? null : null;
  } catch {
    return null;
  }
}

export const maxShareTraceBytes = 1024 * 1024;

export function shareTracePayload(nativeJson: string, scenario: TraceScenario, overlayReactMs: number | null, expected?: TraceExport['expected']) {
  const capture = JSON.parse(nativeJson) as {
    callbacks?: { capture?: CaptureIdentity; session?: string };
    worker?: { capture?: CaptureIdentity };
  };
  if (expected) {
    const identity = capture.callbacks?.capture;
    if (!identity || !sameCapture(identity, capture.worker?.capture) || identity.generation !== expected.generation ||
        identity.surface !== expected.surface || identity.token < expected.minimumToken ||
        (expected.token !== undefined && identity.token !== expected.token) ||
        capture.callbacks?.session !== expected.session) {
      throw new Error('The capture changed before export.');
    }
  }
  const payload = JSON.stringify({
    scenario,
    overlay: { previousReactProfilerActualDurationMs: overlayReactMs },
    capture,
  });
  let bytes = 0;
  for (const character of payload) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > maxShareTraceBytes) throw new Error('Capture exceeds the share limit. Start a shorter capture and try again.');
  }
  return payload;
}
