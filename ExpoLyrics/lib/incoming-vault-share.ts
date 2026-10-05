import type { ResolvedSharePayload, SharePayload } from 'expo-sharing';

export type IncomingVaultShareApi = {
  getSharedPayloads?: () => SharePayload[];
  getResolvedSharedPayloadsAsync?: () => Promise<ResolvedSharePayload[]>;
};

export const SHARE_BUILD_MESSAGE = 'Receiving files from other apps needs a new KineSync development build with the share extension enabled. You can still manage your vault and import files here.';

// Older development binaries may have outbound sharing but no incoming API or
// iOS App Group. Never invoke those native methods while rendering the page.
export async function readIncomingVaultShare(api: IncomingVaultShareApi) {
  try {
    if (!api.getSharedPayloads || !api.getResolvedSharedPayloadsAsync) {
      return { payloads: [] as ResolvedSharePayload[], error: new Error(SHARE_BUILD_MESSAGE) };
    }
    const raw = api.getSharedPayloads();
    return {
      payloads: raw.length ? await api.getResolvedSharedPayloadsAsync() : [],
      error: null,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const unavailable = /app.?group|getSharedPayloads|not.*function|not.*supported|not.*available/i.test(message);
    return {
      payloads: [] as ResolvedSharePayload[],
      error: new Error(unavailable ? SHARE_BUILD_MESSAGE : `Could not read the shared file: ${message}`),
    };
  }
}
