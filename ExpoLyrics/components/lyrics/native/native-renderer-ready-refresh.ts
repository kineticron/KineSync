type RefreshRegistration = { canResync: () => boolean; resyncPlayback: () => void };
type PendingReadyRequest = { isCurrent: () => boolean; onRejected?: () => void };
let currentRegistration: RefreshRegistration | null = null;
let pendingReadyRequest: PendingReadyRequest | null = null;

/** Registers the detector's existing resyncPlayback path without importing its UI/WebView module here. */
export function registerNativeRendererReadyResync(registration: RefreshRegistration) {
  currentRegistration = registration;
  const pending = pendingReadyRequest;
  pendingReadyRequest = null;
  if (pending) {
    if (pending.isCurrent() && registration.canResync()) registration.resyncPlayback();
    else pending.onRejected?.();
  }
  return () => { if (currentRegistration === registration) currentRegistration = null; };
}

export function requestNativeRendererReadyResync(isCurrent: () => boolean = () => true, onRejected?: () => void) {
  if (!isCurrent()) { onRejected?.(); return false; }
  const registration = currentRegistration;
  if (!registration) { pendingReadyRequest = { isCurrent, onRejected }; return true; }
  if (!registration.canResync() || !isCurrent()) { onRejected?.(); return false; }
  registration.resyncPlayback();
  return true;
}

/** One detector resync per live native renderer generation; stale layout callbacks are ignored. */
export class NativeRendererReadyRefreshGate {
  private currentKey = '';
  private generation = 0;
  private completedGeneration = -1;
  private mounted = true;

  begin(key: string) {
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.generation += 1;
      this.completedGeneration = -1;
    }
    return this.generation;
  }

  setMounted(mounted: boolean) { this.mounted = mounted; }

  foreground(key: string) {
    this.begin(key);
    this.generation += 1;
    this.completedGeneration = -1;
    return this.generation;
  }

  isCurrent(generation: number) { return this.mounted && generation === this.generation; }

  onReady(generation: number, eligible: boolean, request: (isCurrent: () => boolean, onRejected?: () => void) => boolean,
    canDispatch: () => boolean = () => true) {
    if (!eligible || !this.isCurrent(generation) || generation === this.completedGeneration) return false;
    this.completedGeneration = generation;
    const isCurrent = () => this.isCurrent(generation) && canDispatch();
    const onRejected = () => {
      if (this.isCurrent(generation) && this.completedGeneration === generation) this.completedGeneration = -1;
    };
    try { if (request(isCurrent, onRejected)) return true; }
    catch { /* A failed detector request may retry on the next genuine ready event. */ }
    onRejected();
    return false;
  }
}
