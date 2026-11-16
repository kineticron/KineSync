import { requireOptionalNativeModule } from 'expo-modules-core';
import type { Reachability } from './health';
type NetworkState = { type?: string | null; isConnected?: boolean; isInternetReachable?: boolean | null };
type Receive = (hint: Reachability, path?: string) => void;
export function networkHint(state: NetworkState): Reachability {
  return state.isConnected === false || state.isInternetReachable === false ? 'offline'
    : state.isConnected === true && state.isInternetReachable === true ? 'online' : 'unknown';
}
/** Stable interface key such as WIFI or CELLULAR. NONE and UNKNOWN carry no interface. */
export function networkPath(type: unknown): string | undefined {
  if (typeof type !== 'string') return undefined;
  const key = type.trim().toUpperCase();
  return key && key !== 'NONE' && key !== 'UNKNOWN' ? key : undefined;
}
type BrowserEnv = {
  navigator?: { onLine?: boolean; connection?: { type?: string; addEventListener?: (e: string, f: () => void) => void; removeEventListener?: (e: string, f: () => void) => void } };
  addEventListener?: (e: string, f: () => void) => void;
  removeEventListener?: (e: string, f: () => void) => void;
};
/** Uses an already installed ExpoNetwork module, else browser online/offline and navigator.connection when present.
 * No new native dependency. Stock IPAs without ExpoNetwork report unknown (no path) and rely on bounded real transport attempts. */
export function subscribeSpotifyReachability(receive: Receive): () => void {
  const module = requireOptionalNativeModule<{
    getNetworkStateAsync?: () => Promise<NetworkState>;
    addListener?: (event: string, callback: (state: NetworkState) => void) => { remove: () => void };
  }>('ExpoNetwork');
  let disposed = false;
  let eventRevision = 0;
  let last: string | undefined;
  const emit = (hint: Reachability, path?: string) => {
    if (disposed) return;
    const key = hint + '|' + (path ?? '');
    if (key === last) return;
    last = key; receive(hint, path);
  };
  const emitState = (state: NetworkState) => emit(networkHint(state), networkPath(state?.type));
  emit('unknown');
  let subscription: { remove: () => void } | undefined;
  let cleanupBrowser: (() => void) | undefined;
  if (module?.addListener || module?.getNetworkStateAsync) {
    try {
      subscription = module.addListener?.('onNetworkStateChanged', state => { eventRevision++; emitState(state); });
      void module.getNetworkStateAsync?.().then(state => { if (!eventRevision) emitState(state); }, () => {});
    } catch { emit('unknown'); }
  } else {
    const env = globalThis as unknown as BrowserEnv;
    const connection = env.navigator?.connection;
    const read = () => {
      const online = env.navigator?.onLine;
      emit(online === false ? 'offline' : online === true ? 'online' : 'unknown', networkPath(connection?.type));
    };
    if (typeof env.addEventListener === 'function' && typeof env.navigator?.onLine === 'boolean') {
      env.addEventListener('online', read); env.addEventListener('offline', read);
      connection?.addEventListener?.('change', read);
      cleanupBrowser = () => {
        env.removeEventListener?.('online', read); env.removeEventListener?.('offline', read);
        connection?.removeEventListener?.('change', read);
      };
      read();
    }
  }
  return () => { disposed = true; subscription?.remove(); cleanupBrowser?.(); };
}
