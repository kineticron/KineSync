export type NativeClockCapture = { build: string; session: string; switchId: number; instance: number;
  from: string; to: string; startedMono: number };
type Fields = Record<string, string | number | boolean | null | undefined>;
const build = 'switch-trace-1/f995a98';
const session = typeof __DEV__ !== 'undefined' && __DEV__ ? Date.now().toString(36) : '';
let instance = 0, serial = 0, lines = 0, captureLines = 0;
let current: NativeClockCapture | null = null;
let pictureLines = 0;
const WINDOW_MS = 15_000;
export const NATIVE_CLOCK_HTTP_TRACE_SCRIPT = typeof __DEV__ !== 'undefined' && __DEV__ ? `
(() => {
  if (window.__kineClockHttpTrace) return;
  window.__kineClockHttpTrace = true;
  let count = 0;
  const family = raw => { try { const path = new URL(String(raw), location.href).pathname;
    return /connect-state.*devices/.test(path) ? 'browser-device-registration' : /connect-state.*player/.test(path) ? 'browser-player-state'
      : /track-playback/.test(path) ? 'browser-track-playback' : 'browser-other'; } catch { return 'browser-other'; } };
  const report = (endpoint, status) => { if (status !== 410 || count++ >= 12) return;
    try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'nativeClockHttp', endpoint, status, wallMs: Date.now() })); } catch {} };
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function(input, ...args) { const endpoint = family(input?.url || input);
    return originalFetch.call(this, input, ...args).then(response => { report(endpoint, response.status); return response; }); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) { const endpoint = family(url);
    this.addEventListener('loadend', () => report(endpoint, this.status), { once: true });
    return open.call(this, method, url, ...args); };
})(); true;
` : '';
type StoreClock = { anchorPositionMs: number; anchorMonotonicMs: number; isPlaying: boolean };
let readStore: (() => StoreClock) | null = null;
export function setNativeClockStoreReader(reader: () => StoreClock) { readStore = reader; }

export function nativeClockCaptureActive() {
  return typeof __DEV__ !== 'undefined' && __DEV__ && current !== null &&
    performance.now() - current.startedMono <= WINDOW_MS && captureLines < 80 && lines < 600;
}
export function getNativeClockCapture() { return nativeClockCaptureActive() ? current : null; }
export function nextNativeClockInstance() { return ++instance; }

/** Numeric timing/state evidence only: never pass URLs, tokens, track or device identities. */
export function emitNativeClockDiagnostic(stage: string, fields: Fields = {}, scope = current) {
  if (!nativeClockCaptureActive() || !scope || scope.session !== session) return;
  lines++; captureLines++;
  console.log('[NativeClockTrace]', JSON.stringify({ ...scope, stage, wallMs: Date.now(),
    rnNow: performance.now(), ...fields }));
}

export function beginNativeClockCapture(style: string, rendererInstance: number) {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return null;
  if (current?.instance === rendererInstance && current.to === style) return getNativeClockCapture();
  const from = current?.to ?? 'cold';
  current = { build, session, switchId: ++serial, instance: rendererInstance, from, to: style, startedMono: performance.now() };
  captureLines = 0;
  pictureLines = 0;
  emitNativeClockDiagnostic('switch-start', { windowMs: WINDOW_MS, maxLines: 80, maxSessionLines: 600 });
  return current;
}

export function reportNativePicture(fields: Fields) {
  if (!nativeClockCaptureActive() || pictureLines >= 4 || !current?.to.startsWith(`${fields.style}/`)) return;
  pictureLines++;
  reportNativeUiClock(current, 'picture-consumed-clock', fields);
}

/** Receipt-time comparison retains the UI sample's own timestamp and reports RN delivery delay. */
export function reportNativeUiClock(scope: NativeClockCapture, stage: string, fields: Fields) {
  const state = readStore?.();
  if (!state) { emitNativeClockDiagnostic(stage, fields, scope); return; }
  const now = performance.now();
  const projected = state.anchorPositionMs + (state.isPlaying ? Math.max(0, now - state.anchorMonotonicMs) : 0);
  const nativeNow = typeof fields.nativeNow === 'number' ? fields.nativeNow : null;
  const uiPosition = typeof fields.position === 'number' ? fields.position : null;
  emitNativeClockDiagnostic(stage, { ...fields, storeAnchorPosition: state.anchorPositionMs,
    storeAnchorMono: state.anchorMonotonicMs, storePlaying: state.isPlaying, storeProjectedAtReceipt: projected,
    uiToRnMs: nativeNow === null ? null : now - nativeNow,
    uiMinusStoreAtReceipt: nativeNow === null || uiPosition === null ? null
      : uiPosition + (fields.playing ? Math.max(0, now - nativeNow) : 0) - projected,
  }, scope);
}
