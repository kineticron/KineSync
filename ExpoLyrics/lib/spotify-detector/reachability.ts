import { requireOptionalNativeModule } from 'expo-modules-core';
import type { Reachability } from './health';
type NetworkState = { isConnected?: boolean; isInternetReachable?: boolean | null };
export function networkHint(state: NetworkState): Reachability {
  return state.isConnected === false || state.isInternetReachable === false ? 'offline'
    : state.isConnected === true && state.isInternetReachable === true ? 'online' : 'unknown';
}
/** Uses an already installed ExpoNetwork module only. No new native dependency.
 * Stock builds without it remain unknown and use bounded real transport attempts. */
export function subscribeSpotifyReachability(receive: (hint: Reachability) => void): () => void {
  const module = requireOptionalNativeModule<{
    getNetworkStateAsync?: () => Promise<NetworkState>;
    addListener?: (event: string, callback: (state: NetworkState) => void) => { remove: () => void };
  }>('ExpoNetwork');
  let disposed = false;
  let eventRevision = 0;
  const emit = (state: NetworkState) => { if (!disposed) receive(networkHint(state)); };
  receive('unknown');
  let subscription: { remove: () => void } | undefined;
  try {
    subscription = module?.addListener?.('onNetworkStateChanged', state => { eventRevision++; emit(state); });
    void module?.getNetworkStateAsync?.().then(state => { if (!eventRevision) emit(state); }, () => {});
  } catch { receive('unknown'); }
  return () => { disposed = true; subscription?.remove(); };
}
