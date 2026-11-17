import { fetchMobileLyricsForTrack } from "@/lib/mobile-lyrics-client";
import { saveMobileVaultLyrics } from "@/lib/mobile-lyrics-vault";
import { bridgeClient } from "@/lib/bridge-client";
import type { LyricsPacket, Track } from "@/types/bridge";
import { usePlaybackStore } from "@/store/playback-store";

let latestLyricsRequestId = 0;

function normalizeSignatureText(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getTrackMetadataSignature(track: Track | null | undefined) {
  if (!track) {
    return "";
  }
  return [
    String(track.id || "").trim(),
    normalizeSignatureText(track.title),
    normalizeSignatureText(track.artist),
    normalizeSignatureText(track.album),
    Math.max(0, Math.round(Number(track.durationMs || 0))),
    String(track.spotifyTrackId || "").trim(),
  ].join("\u0000");
}

function hasUsableTrackMetadata(value: unknown) {
  const normalized = normalizeSignatureText(value);
  return Boolean(normalized) && !/^(?:unknown(?: track| artist| album)?|spotify[-_ ]connect:?)$/.test(normalized);
}

function isMetadataEnrichmentValue(before: unknown, after: unknown) {
  return normalizeSignatureText(before) === normalizeSignatureText(after) ||
    (!hasUsableTrackMetadata(before) && hasUsableTrackMetadata(after));
}

function isSpotifyIdentityEnrichment(before: unknown, after: unknown) {
  const beforeId = String(before || "").trim();
  const afterId = String(after || "").trim();
  return beforeId === afterId ||
    (!hasUsableTrackMetadata(beforeId) && hasUsableTrackMetadata(afterId));
}

function isSameRecordingOrEnrichment(
  requestedTrack: Track | null | undefined,
  currentTrack: Track | null | undefined,
) {
  if (!requestedTrack || !currentTrack || requestedTrack.id !== currentTrack.id) return false;
  if (normalizeSignatureText(requestedTrack.title) !== normalizeSignatureText(currentTrack.title) ||
    normalizeSignatureText(requestedTrack.artist) !== normalizeSignatureText(currentTrack.artist)) return false;
  if (!isMetadataEnrichmentValue(requestedTrack.album, currentTrack.album) ||
    !isSpotifyIdentityEnrichment(requestedTrack.spotifyTrackId, currentTrack.spotifyTrackId)) return false;
  const beforeDuration = Math.max(0, Math.round(Number(requestedTrack.durationMs || 0)));
  const currentDuration = Math.max(0, Math.round(Number(currentTrack.durationMs || 0)));
  return beforeDuration === currentDuration || (beforeDuration === 0 && currentDuration > 0);
}

function isCurrentTrackRequest(requestId: number, requestedTrack: Track) {
  return requestId === latestLyricsRequestId &&
    isSameRecordingOrEnrichment(requestedTrack, usePlaybackStore.getState().currentTrack);
}
export type LyricsSourcePreference =
  | "auto"
  | "local-vault"
  | "lrc-red"
  | "kugou"
  | "netease"
  | "qq-direct"
  | "musixmatch"
  | "lrclib"
  | "spicy-lyrics";

function applyMobileLyricsPacket(packet: LyricsPacket) {
  const state = usePlaybackStore.getState();
  // A request can outlive the browser fallback that started it. Once the
  // bridge reconnects it is the authoritative lyrics publisher again.
  if (state.connectionStatus === "connected") {
    return;
  }
  const activeTrackId = state.currentTrack?.id ?? "";
  if (packet.trackId && activeTrackId && packet.trackId !== activeTrackId) {
    return;
  }
  state.setLyrics(packet.lyrics || [], packet.source || "mobile-app", {
    metadata: packet.metadata || {},
    statusMessage: packet.statusMessage ||
      ((packet.lyrics || []).length
        ? `Fetched ${(packet.lyrics || []).length} lines from ${packet.source || "mobile-app"}.`
        : "No synced lyrics available."),
  });
}
function inferCurrentSourcePreference(
  lyricsSource: string,
): LyricsSourcePreference {
  const source = String(lyricsSource || "").toLowerCase();
  if (source.includes("local-vault")) {
    return "local-vault";
  }
  if (source.includes("lrc-red")) return "lrc-red";
  if (source.includes("spicy")) {
    return "spicy-lyrics";
  }
  if (source.includes("musixmatch")) {
    return "musixmatch";
  }
  if (source.includes("kugou")) {
    return "kugou";
  }
  if (source.includes("netease")) {
    return "netease";
  }
  if (source.includes("lrclib")) {
    return "lrclib";
  }
  if (source.includes("qq")) {
    return "qq-direct";
  }
  return "auto";
}

export async function refreshLyricsForCurrentTrack(
  preferredSource: LyricsSourcePreference = "auto",
  { force = false }: { force?: boolean } = {},
) {
  const { currentTrack, clearLyrics, setLyricsStatusMessage, connectionStatus } =
    usePlaybackStore.getState();
  if (!currentTrack) {
    clearLyrics();
    return;
  }

  const sourceLabel =
    preferredSource === "auto" ? "best source" : preferredSource;

  // Keep the original desktop-bridge behavior whenever it is available.
  // The mobile service is a fallback, not a replacement for bridge commands.
  if (connectionStatus === "connected") {
    latestLyricsRequestId += 1;
    setLyricsStatusMessage(
      preferredSource === "auto"
        ? "Loading best lyrics source on desktop..."
        : `Switching to ${sourceLabel} on desktop...`,
    );
    bridgeClient.requestLyricsRefresh(preferredSource);
    return;
  }

  setLyricsStatusMessage(
    preferredSource === "auto"
      ? "Loading best lyrics source on mobile..."
      : `Switching to ${sourceLabel} on mobile...`,
  );

  const requestId = latestLyricsRequestId + 1;
  latestLyricsRequestId = requestId;
  const activeSignature = getTrackMetadataSignature(currentTrack);
  const applyCurrentPacket = (packet: LyricsPacket) => {
    const state = usePlaybackStore.getState();
    if (isCurrentTrackRequest(requestId, currentTrack)) {
      applyMobileLyricsPacket(packet);
      return;
    }
    if (
      requestId === latestLyricsRequestId &&
      state.connectionStatus !== "connected" &&
      state.currentTrack?.id === currentTrack.id &&
      getTrackMetadataSignature(state.currentTrack) !== activeSignature &&
      !isSameRecordingOrEnrichment(currentTrack, state.currentTrack)
    ) {
      // Meaningful same-ID metadata changes may be a different recording.
      // Keep the displayed packet guarded and start a newly owned request.
      void refreshLyricsForCurrentTrack(preferredSource, { force });
    }
  };
  try {
    const packet = await fetchMobileLyricsForTrack(currentTrack, {
      preferredSource,
      force,
      onSyncedLyrics: applyCurrentPacket,
    });
    applyCurrentPacket(packet);
  } catch (error) {
    if (!isCurrentTrackRequest(requestId, currentTrack)) {
      return;
    }
    setLyricsStatusMessage(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function refetchCachedLyrics() {
  const state = usePlaybackStore.getState();
  if (state.connectionStatus === "connected") {
    latestLyricsRequestId += 1;
    state.setLyricsStatusMessage("Refetching cached desktop lyrics and artwork...");
    bridgeClient.requestLyricsRefetch();
    bridgeClient.requestArtworkRefetch();
    return;
  }
  void refreshLyricsForCurrentTrack(inferCurrentSourcePreference(state.lyricsSource));
}

export function requestImmediateTranslationForCurrentSource() {
  const {
    currentTrack,
    setLyricsStatusMessage,
    beginTranslationRequest,
    lyricsSource,
    connectionStatus,
  } =
    usePlaybackStore.getState();
  if (!currentTrack) {
    return;
  }

  if (connectionStatus === "connected") {
    latestLyricsRequestId += 1;
    setLyricsStatusMessage("Translating on-screen lyrics on desktop...");
    beginTranslationRequest();
    bridgeClient.requestLyricsRefresh("auto", { immediateTranslation: true, translationLanguage: usePlaybackStore.getState().translationLanguage });
    return;
  }

  const requestId = latestLyricsRequestId + 1;
  latestLyricsRequestId = requestId;
  setLyricsStatusMessage("Translating on-screen lyrics on mobile...");
  beginTranslationRequest();
  void fetchMobileLyricsForTrack(currentTrack, {
    preferredSource: inferCurrentSourcePreference(lyricsSource),
    immediateTranslation: true,
    onSyncedLyrics: (packet) => {
      if (isCurrentTrackRequest(requestId, currentTrack)) {
        applyMobileLyricsPacket(packet);
      }
    },
  })
    .then((packet) => {
      if (isCurrentTrackRequest(requestId, currentTrack)) {
        applyMobileLyricsPacket(packet);
      }
    })
    .catch((error) => {
      if (isCurrentTrackRequest(requestId, currentTrack)) {
        usePlaybackStore
          .getState()
          .setLyricsStatusMessage(error instanceof Error ? error.message : String(error));
      }
    });
}

export async function saveCurrentTrackToVault({
  includeTranslations = false,
}: {
  includeTranslations?: boolean;
} = {}) {
  const {
    currentTrack,
    lyrics,
    lyricsSource,
    lyricsMetadata,
    setLyricsStatusMessage,
    connectionStatus,
  } = usePlaybackStore.getState();
  if (!currentTrack) {
    throw new Error("No track is playing.");
  }
  if (!Array.isArray(lyrics) || !lyrics.length) {
    throw new Error("No synced lyrics are loaded for the current track.");
  }

  setLyricsStatusMessage(
    includeTranslations
      ? "Saving to local vault and translating if needed..."
      : "Saving to local lyrics vault...",
  );

  if (connectionStatus === "connected") {
    const result = await bridgeClient.saveCurrentTrackToVault({
      includeTranslations,
    });
    setLyricsStatusMessage(
      `Saved ${result.lineCount || 0} lines to local vault (${result.sourceLabel || "local-vault"}).`,
    );
    bridgeClient.requestLyricsRefresh("local-vault");
    return result;
  }

  let lyricsToSave = lyrics;
  let sourceToSave = lyricsSource;
  let metadataToSave = lyricsMetadata;
  if (
    includeTranslations &&
    !lyricsToSave.some(
      (line) =>
        String(line.translatedText || "").trim() ||
        String(line.backgroundTranslatedText || "").trim(),
    )
  ) {
    const translatedPacket = await fetchMobileLyricsForTrack(currentTrack, {
      preferredSource: inferCurrentSourcePreference(lyricsSource),
      immediateTranslation: true,
      onSyncedLyrics: applyMobileLyricsPacket,
    });
    if (translatedPacket.lyrics?.length) {
      lyricsToSave = translatedPacket.lyrics;
      sourceToSave = translatedPacket.source || sourceToSave;
      metadataToSave = translatedPacket.metadata || metadataToSave;
    }
  }

  const result = await saveMobileVaultLyrics({
    track: currentTrack,
    lyrics: lyricsToSave,
    sourceLabel: "local-vault",
    originalSource: sourceToSave,
    metadata: metadataToSave,
  });
  setLyricsStatusMessage(
    `Saved ${result.lineCount || 0} lines to local vault (${result.sourceLabel || "local-vault"}).`,
  );
  void refreshLyricsForCurrentTrack("local-vault");
  return result;
}
