import { memo, Profiler, useCallback, useEffect, useRef, useState, type ProfilerOnRenderCallback, type RefObject } from 'react';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Debug buttons are isolated from the lyric gesture sibling.
import { Pressable, Share, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import {
  budgetTone, decodeWorker, shareTracePayload, traceScalarPages, traceScenarios,
  type CallbackSummary, type Distribution, type LegacyMetrics, type TraceExport, type TraceScenario, type TraceUpdate, type WorkerSummary,
} from '@/lib/rust-frame-trace';

type Snapshot = { callbacks: CallbackSummary; worker: WorkerSummary | null };
type Props = {
  subscription: RefObject<((update: TraceUpdate) => void) | null>;
  supported: boolean;
  android: boolean;
  failed: boolean;
  capturing: boolean;
  ready: boolean;
  visualRate: number;
  onCapture: (enabled: boolean) => void;
  onExport: () => Promise<TraceExport>;
  onHide: () => void;
  onRecreate: () => void;
  onVisualRate: () => void;
};

function number(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function Stat({ label, stats, budget, stacked, width }: {
  label: string; stats?: Distribution | null; budget?: number; stacked: boolean; width: number;
}) {
  const tone = budgetTone(stats?.p95, budget);
  const column = { width };
  return <View style={[styles.row, stacked && styles.stacked]}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.columns}>
      <Text style={[styles.value, column]}>{number(stats?.p50)}</Text>
      <Text style={[styles.value, column, styles[tone]]}>{number(stats?.p95)}</Text>
      <Text style={[styles.value, column]}>{number(stats?.worst)}</Text>
    </View>
  </View>;
}

function Control({ label, onPress, disabled = false, hint }: { label: string; onPress: () => void; disabled?: boolean; hint?: string }) {
  return <Pressable accessibilityRole="button" accessibilityHint={hint} disabled={disabled} onPress={onPress} style={styles.control}>
    <Text maxFontSizeMultiplier={1.35} style={[styles.controlText, disabled && styles.disabled]}>{label}</Text>
  </Pressable>;
}

export const RustFpsOverlay = memo(function RustFpsOverlay(props: Props) {
  const renderMs = useRef<number | null>(null);
  const profile: ProfilerOnRenderCallback = useCallback((_id, _phase, actualDuration) => {
    if (Number.isFinite(actualDuration) && actualDuration > 0) renderMs.current = actualDuration;
  }, []);
  return <Profiler id="Rust FPS overlay" onRender={profile}>
    <OverlayContent {...props} renderMs={renderMs} />
  </Profiler>;
});

function OverlayContent({
  subscription, supported, android, failed, capturing, ready, visualRate, onCapture, onExport, onHide, onRecreate, onVisualRate,
  renderMs,
}: Props & { renderMs: RefObject<number | null> }) {
  const { fontScale } = useWindowDimensions();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [controlsHeight, setControlsHeight] = useState(0);
  const [page, setPage] = useState(0);
  const [scalarPage, setScalarPage] = useState(0);
  const panelWidth = Math.min(350, bounds.width);
  const stacked = fontScale > 1.35 || panelWidth < 265;
  const columnWidth = Math.min(Math.ceil(38 * Math.min(fontScale, 2)), Math.floor(Math.max(0, panelWidth - 28) / 3));
  const panelInset = bounds.height < 120 ? 0 : 8;
  const readoutHeight = Math.max(0, bounds.height - controlsHeight - panelInset * 3);
  const showReadout = readoutHeight >= 20;
  const showTable = readoutHeight >= (stacked ? 192 : 125) * Math.max(1, fontScale);
  const [sample, setSample] = useState<Snapshot | null>(null);
  const [legacy, setLegacy] = useState<LegacyMetrics | null>(null);
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const scenario: TraceScenario = traceScenarios[scenarioIndex] ?? traceScenarios[0];

  useEffect(() => {
    if (failed || (!capturing && !android)) {
      setSample(null);
      setLegacy(null);
      return;
    }
    const receive = (update: TraceUpdate) => {
      if (update.kind === 'reset') setSample(null);
      else if (update.kind === 'legacy') setLegacy(update.event);
      else setSample({ callbacks: update.event.callbacks, worker: decodeWorker(update.event.worker, update.event) });
    };
    subscription.current = receive;
    return () => {
      if (subscription.current === receive) subscription.current = null;
    };
  }, [android, capturing, failed, subscription]);

  const measureBounds = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBounds(previous => previous.width === width && previous.height === height ? previous : { width, height });
  };

  const exportCapture = async () => {
    setExporting(true);
    setExportError('');
    try {
      const { json, expected, isCurrent } = await onExport();
      const message = shareTracePayload(json, scenario, renderMs.current, expected);
      if (!isCurrent()) throw new Error('The capture changed before export.');
      await Share.share({ message });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Export unavailable.');
    } finally {
      setExporting(false);
    }
  };

  const callbacks = sample?.callbacks;
  const worker = sample?.worker;
  const budget = callbacks?.budgetMs;
  const gpuStatus = worker?.gpuUnavailable ||
    (!worker?.gpuMs ? (worker?.gpuReadbackFailed ? 'GPU readback failed for observed samples.' : 'Awaiting GPU samples.') : '');
  const statRows = [
    { label: 'Callback interval', stats: callbacks?.callbackIntervalMs },
    { label: 'Present-call interval', stats: worker?.presentIntervalMs },
    { label: 'CPU encode', stats: worker?.encodeMs },
    { label: 'GPU queue elapsed', stats: worker?.gpuMs },
  ];
  const statProps = { stacked, budget, width: columnWidth };
  const stats = capturing && supported ? <>
    <View style={[styles.row, stacked && styles.stacked]}>
      <Text style={styles.label}>Active segment · ms</Text>
      <View style={styles.columns}>
        {['p50', 'p95', 'Worst'].map(heading => <Text key={heading} style={[styles.heading, { width: columnWidth }]}>{heading}</Text>)}
      </View>
    </View>
    {statRows.map(row => <Stat key={row.label} {...row} {...statProps} />)}
  </> : null;
  const pacingDetails = [
    'Requested ' + number(callbacks?.requestedHz, 0) + ' Hz · busy ' + (callbacks?.busyCallbacks ?? 'n/a') + ' · capacity ' + (worker?.capacitySkips ?? 'n/a') + ' · no drawable ' + (worker?.noDrawable ?? 'n/a'),
    'Idle ' + (callbacks?.idleCallbacks ?? 'n/a') + ' · inactive ' + (callbacks?.inactiveCallbacks ?? 'n/a') + ' · awaiting input ' + (worker?.awaitingInput ?? 'n/a') + ' · failed ' + (worker?.failed ?? 'n/a'),
    'Acquire p95 ' + number(worker?.acquireMs?.p95) + ' ms',
    (worker?.drawableUnavailable ?? 'Drawable presentedTime is unavailable.') + ' Physical scanout is unmeasured.',
  ];
  const costDetails = [
    'Native bookkeeping p95 · callback ' + number(callbacks?.recordCpuMs?.p95, 3) + ' ms · worker ' + number(worker?.nativeBookkeepingMs?.p95, 3) + ' ms',
    'Timestamp setup p95 ' + number(worker?.gpuMarkerCpuMs?.p95, 3) + ' ms · prior snapshot CPU ' + number(callbacks?.previousSummaryCpuMs, 3) + ' main / ' + number(worker?.previousSnapshotCpuMs, 3) + ' worker ms',
    'Overlay React render (previous) ' + number(renderMs.current, 3) + ' ms. UI thread and compositor cost unknown.',
    'Latest GPU frame ' + (worker?.latestGpu?.frameId ?? 'n/a') + ' · age ' + number(worker?.latestGpu?.ageMs, 0) + ' ms · readback ' + number(worker?.latestGpu?.readbackLatencyMs, 0) + ' ms',
    'Overwritten · callbacks ' + (callbacks?.overwritten ?? 'n/a') + ' · worker ' + (worker?.overwritten ?? 'n/a'),
    'GPU samples · slots busy ' + (worker?.gpuSlotsFull ?? 'n/a') + ' · failed ' + (worker?.gpuReadbackFailed ?? 'n/a') + ' · late ' + (worker?.gpuLate ?? 'n/a'),
  ];
  const compact = !showTable && capturing && supported;
  const scalarPages = compact ? [
    ...traceScalarPages(statRows).map(({ label, value }) => label + ' · ' + number(value) + ' ms'),
    'Active callbacks/s ' + number(callbacks?.activeCallbackHz, 0),
    'Active present calls/s ' + number(worker?.activePresentCallHz, 0),
    'Active budget ' + number(budget, 2) + ' ms',
    'Window callbacks/s ' + number(callbacks?.windowCallbackHz, 0),
    'Window present calls/s ' + number(worker?.windowPresentCallHz, 0),
    'Estimated callback gaps ' + (callbacks?.estimatedMissedCallbackVsyncs ?? 'n/a'),
    gpuStatus || 'GPU queue samples available',
    ...pacingDetails, ...costDetails,
  ] : [];
  const scalarPageSelected = compact && page !== 0 && page !== 4;
  const showScalar = scalarPageSelected && readoutHeight >= 14;
  const inlineScalar = scalarPageSelected && !showScalar && panelWidth >= 320 && bounds.height >= 40;
  const scalarText = <Text style={[styles.scalar, !!exportError && styles.bad]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.55}
    accessibilityRole={exportError ? 'alert' : undefined}
    maxFontSizeMultiplier={showScalar ? Math.min(1.35, readoutHeight / 14) : 1.15}>
    {exportError || (scalarPages[scalarPage] ?? scalarPages[0])}
  </Text>;
  const nextDetails = () => {
    if (exportError) setExportError('');
    if (!compact) { setPage(value => (value + 1) % 5); return; }
    if (page === 1 && scalarPage + 1 < scalarPages.length) {
      setScalarPage(value => value + 1);
    } else {
      setScalarPage(0);
      setPage(page === 1 ? 4 : page === 4 ? 0 : 1);
    }
  };

  return <View pointerEvents="box-none" style={[styles.position, failed && styles.recoveryPosition]} onLayout={measureBounds}>
      <View pointerEvents="box-none" style={[styles.panel, failed
        ? { marginBottom: panelInset, paddingVertical: panelInset }
        : { marginTop: panelInset, paddingVertical: panelInset }]}>
        <View pointerEvents="box-none" onLayout={event => setControlsHeight(event.nativeEvent.layout.height)}>
          <View pointerEvents="box-none" style={inlineScalar ? styles.inlineControls : undefined}>
            <View pointerEvents="box-none" style={styles.controls}>
              {failed ? <Control label="Recreate surface" onPress={onRecreate} /> :
                !android && supported && <Control label={capturing ? 'Stop' : 'Capture'} onPress={() => onCapture(!capturing)} />}
              {!failed && !android && supported && capturing && <Control label="Share" disabled={!ready || exporting} onPress={() => { void exportCapture(); }} />}
              <Control label="Hide" hint="Restore from the developer menu or Rust diagnostics settings" onPress={onHide} />
              {!failed && <Control label={compact && page === 1 ? 'Next' : page ? `Details ${page}/4` : 'Details'} onPress={nextDetails} />}
            </View>
            {inlineScalar && <View pointerEvents="none" style={styles.inlineScalar}>{scalarText}</View>}
          </View>
          {!failed && page === 4 && <View pointerEvents="box-none" style={styles.controls}>
            {supported && <Control label={scenario} onPress={() => setScenarioIndex(index => (index + 1) % traceScenarios.length)} />}
            <Control label="Recreate surface" onPress={onRecreate} />
            <Control label={`Visual rate ${visualRate}×`} onPress={onVisualRate} disabled={!ready} />
          </View>}
        </View>
        {showScalar ? <View pointerEvents="none">{scalarText}</View>
          : !inlineScalar && showReadout && <View pointerEvents="none" style={[styles.readout, { maxHeight: readoutHeight }]}>
          {!!exportError && <Text style={styles.bad} accessibilityRole="alert">{exportError}</Text>}
          <View style={[styles.row, stacked && styles.stacked]}>
            <Text style={styles.title}>Renderer pacing</Text>
            <Text style={styles.phase}>{failed ? 'Failed' : android ? 'Legacy' : !supported ? 'Unavailable' : !capturing ? 'Off' : callbacks?.phase ?? 'Warmup'}</Text>
          </View>
          {failed ? null : android ? <Text style={styles.secondary}>
            {number(legacy?.deliveredCallbackHz, 0)} callbacks/s · {number(legacy?.presentCallRate, 0)} calls/s · {number(legacy?.cpuEncodeMs)} ms encode
          </Text> : capturing && supported ? <>
            {page === 0 && <>
              <Text style={styles.secondary}>Active · {number(callbacks?.activeCallbackHz, 0)} callbacks/s · {number(worker?.activePresentCallHz, 0)} calls/s · {number(budget, 2)} ms budget</Text>
              <Text style={styles.secondary}>Window · {number(callbacks?.windowCallbackHz, 0)} callbacks/s · {number(worker?.windowPresentCallHz, 0)} calls/s</Text>
              <Text style={styles.secondary}>Estimated callback gaps {callbacks?.estimatedMissedCallbackVsyncs ?? 'n/a'} · Drawable gaps unavailable</Text>
              {!!gpuStatus && <Text style={styles.secondary}>{gpuStatus}</Text>}
              {showTable && stats}
            </>}
            {page === 1 && showTable && stats}
          </> : <Text style={styles.secondary}>{supported ? 'Start capture to measure the last five seconds.' : 'Device trace requires an instrumented development client.'}</Text>}
          {!failed && !android && page === 2 && <>
            {pacingDetails.map(text => <Text key={text} style={styles.secondary}>{text}</Text>)}
            <Text style={styles.secondary}>GPU scope includes both Vello renders through the final blit and any queue gaps.</Text>
          </>}
          {!failed && !android && page === 3 && <>
            {costDetails.map(text => <Text key={text} style={styles.secondary}>{text}</Text>)}
          </>}
          {!failed && page === 4 && <Text style={styles.secondary}>Restore the hidden panel with “Show Rust debug overlay” in the developer menu or Rust diagnostics settings.</Text>}
        </View>}
      </View>
  </View>;
}

const styles = StyleSheet.create({
  position: { position: 'absolute', top: 0, bottom: 0, right: 12, left: 12, zIndex: 10, alignItems: 'flex-end' },
  recoveryPosition: { justifyContent: 'flex-end' },
  panel: { width: '100%', maxWidth: 350, backgroundColor: 'rgba(22, 25, 28, 0.94)', borderRadius: 14, paddingHorizontal: 10 },
  readout: { gap: 3, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 },
  stacked: { flexDirection: 'column', gap: 1 },
  title: { color: '#F1F4F5', fontSize: 13, fontWeight: '700', flexShrink: 1 },
  phase: { color: '#BAC5C9', fontSize: 11, textTransform: 'capitalize' },
  secondary: { color: '#BAC5C9', fontSize: 11, fontVariant: ['tabular-nums'] },
  scalar: { color: '#E1E8EA', fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
  label: { color: '#E1E8EA', fontSize: 11, flexShrink: 1 },
  columns: { flexDirection: 'row', gap: 4 },
  value: { textAlign: 'right', color: '#F1F4F5', fontSize: 11, fontVariant: ['tabular-nums'] },
  heading: { textAlign: 'right', color: '#BAC5C9', fontSize: 10 },
  neutral: { color: '#BAC5C9' },
  good: { color: '#76E0CB' },
  warn: { color: '#F8CE79' },
  bad: { color: '#FF9B9B' },
  controls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 3 },
  inlineControls: { flexDirection: 'row', alignItems: 'center' },
  inlineScalar: { flex: 1, minWidth: 0 },
  control: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 7 },
  controlText: { color: '#C9F6EA', fontSize: 12, fontWeight: '600' },
  disabled: { color: '#819094' },
});
