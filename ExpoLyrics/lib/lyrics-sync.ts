import { clearMobileLyricsCache, fetchMobileLyricsForTrack } from "@/lib/mobile-lyrics-client";
import { saveMobileVaultLyrics } from "@/lib/mobile-lyrics-vault";
import { bridgeClient } from "@/lib/bridge-client";
import type { LyricsPacket, Track } from "@/types/bridge";
import { usePlaybackStore } from "@/store/playback-store";

let latestLyricsRequestId = 0;
let activeMobileTrackSignature = '';

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

function isCurrentTrackRequest(requestId: number, signature: string) {
  return (
    requestId === latestLyricsRequestId &&
    getTrackMetadataSignature(usePlaybackStore.getState().currentTrack) === signature
  );
}
export type LyricsSourcePreference =
  | "auto"
  | "local-vault"
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
  state.setLyrics(packet.lyrics || [], packet.source || "mobile-app");
  state.setLyricsMetadata(packet.metadata || {});
  state.setLyricsStatusMessage(
    packet.statusMessage ||
      ((packet.lyrics || []).length
        ? `Fetched ${(packet.lyrics || []).length} lines from ${packet.source || "mobile-app"}.`
        : "No synced lyrics available."),
  );
}
function inferCurrentSourcePreference(
  lyricsSource: string,
): LyricsSourcePreference {
  const source = String(lyricsSource || "").toLowerCase();
  if (source.includes("local-vault")) {
    return "local-vault";
  }
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
  if (activeMobileTrackSignature !== activeSignature) {
    // The bundled service contains source-level result caches. They are safe
    // only for one metadata identity, not merely a recycled playback id.
    clearMobileLyricsCache();
    activeMobileTrackSignature = activeSignature;
  }


  try {
    const packet = await fetchMobileLyricsForTrack(currentTrack, {
      preferredSource,
      onSyncedLyrics: (progressPacket) => {
        if (isCurrentTrackRequest(requestId, activeSignature)) {
          applyMobileLyricsPacket(progressPacket);
        }
      },
    });
    if (isCurrentTrackRequest(requestId, activeSignature)) {
      applyMobileLyricsPacket(packet);
    }
  } catch (error) {
    if (!isCurrentTrackRequest(requestId, activeSignature)) {
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
    bridgeClient.requestLyricsRefresh("auto", { immediateTranslation: true });
    return;
  }

  const requestId = latestLyricsRequestId + 1;
  latestLyricsRequestId = requestId;
  const activeSignature = getTrackMetadataSignature(currentTrack);
  setLyricsStatusMessage("Translating on-screen lyrics on mobile...");
  beginTranslationRequest();
  void fetchMobileLyricsForTrack(currentTrack, {
    preferredSource: inferCurrentSourcePreference(lyricsSource),
    immediateTranslation: true,
    onSyncedLyrics: (packet) => {
      if (isCurrentTrackRequest(requestId, activeSignature)) {
        applyMobileLyricsPacket(packet);
      }
    },
  })
    .then((packet) => {
      if (isCurrentTrackRequest(requestId, activeSignature)) {
        applyMobileLyricsPacket(packet);
      }
    })
    .catch((error) => {
      if (isCurrentTrackRequest(requestId, activeSignature)) {
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
