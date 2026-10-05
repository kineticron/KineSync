import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { readIncomingVaultShare } from '@/lib/incoming-vault-share';

export function useVaultIncomingShare() {
  const [resolvedSharedPayloads, setPayloads] = useState<Sharing.ResolvedSharePayload[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);

  const refreshSharePayloads = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const request = ++generation.current;
    const result = await readIncomingVaultShare(Sharing);
    if (request !== generation.current) return;
    setPayloads(result.payloads);
    setError(result.error);
  }, []);

  const clearSharedPayloads = useCallback(() => {
    ++generation.current;
    setPayloads([]);
    try {
      if (Platform.OS !== 'web') Sharing.clearSharedPayloads();
    } catch {
      // An older native binary must not prevent closing the import editor.
    }
  }, []);

  const cancelPendingRead = useCallback(() => {
    ++generation.current;
  }, []);

  useEffect(() => {
    void refreshSharePayloads();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refreshSharePayloads();
    });
    return () => {
      cancelPendingRead();
      subscription.remove();
    };
  }, [refreshSharePayloads, cancelPendingRead]);

  return { resolvedSharedPayloads, error, clearSharedPayloads, refreshSharePayloads };
}
