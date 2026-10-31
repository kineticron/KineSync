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
  private mountCount = 0;

  begin(key: string) {
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.generation += 1;
      this.completedGeneration = -1;
    }
    return this.generation;
  }

  mount() {
    this.mountCount += 1;
    this.mounted = true;
  }

  unmount() {
    this.mountCount = Math.max(0, this.mountCount - 1);
    if (this.mountCount === 0) this.mounted = false;
  }

  setMounted(mounted: boolean) {
    this.mounted = mounted;
    if (mounted) {
      if (this.mountCount <= 0) this.mountCount = 1;
    } else {
      this.mountCount = 0;
    }
  }

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

export type RendererContentIdentity = {
  demo: boolean;
  trackId: string | null;
  source: string;
  lyrics: unknown;
};

let sharedGate: NativeRendererReadyRefreshGate | null = null;
let sharedContentIdentity: RendererContentIdentity | null = null;
let sharedContentGeneration = 0;

export function getSharedNativeRendererReadyRefreshGate(): NativeRendererReadyRefreshGate {
  if (!sharedGate) {
    sharedGate = new NativeRendererReadyRefreshGate();
  }
  return sharedGate;
}

export function getRendererContentKey(identity: RendererContentIdentity): string {
  const isChanged = !sharedContentIdentity ||
    sharedContentIdentity.demo !== identity.demo ||
    sharedContentIdentity.trackId !== identity.trackId ||
    sharedContentIdentity.source !== identity.source ||
    sharedContentIdentity.lyrics !== identity.lyrics;
  if (isChanged) {
    sharedContentGeneration += 1;
    sharedContentIdentity = {
      demo: identity.demo,
      trackId: identity.trackId,
      source: identity.source,
      lyrics: identity.lyrics,
    };
  }
  return `content-${sharedContentGeneration}`;
}

export function resetNativeRendererReadyRefreshForTests() {
  sharedGate = null;
  sharedContentIdentity = null;
  sharedContentGeneration = 0;
  currentRegistration = null;
  pendingReadyRequest = null;
}
