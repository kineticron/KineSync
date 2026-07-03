import { bridgeClient } from "@/lib/bridge-client";
import { usePlaybackStore } from "@/store/playback-store";

export type LyricsSourcePreference =
  | "auto"
  | "local-vault"
  | "kugou"
  | "netease"
  | "qq-direct"
  | "musixmatch"
  | "lrclib"
  | "spicy-lyrics";

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
  const { currentTrack, clearLyrics, setLyricsStatusMessage } =
    usePlaybackStore.getState();
  if (!currentTrack) {
    clearLyrics();
    return;
  }

  const sourceLabel =
    preferredSource === "auto" ? "best source" : preferredSource;
  setLyricsStatusMessage(
    preferredSource === "auto"
      ? "Loading best lyrics source..."
      : `Switching to ${sourceLabel}...`,
  );
  bridgeClient.requestLyricsRefresh(preferredSource);
}

export function refetchCachedLyrics() {
  const { currentTrack, setLyricsStatusMessage } = usePlaybackStore.getState();
  if (!currentTrack) {
    return;
  }

  setLyricsStatusMessage(
    "Refetching cached lyrics and artwork...",
  );
  bridgeClient.requestLyricsRefetch();
  bridgeClient.requestArtworkRefetch();
}

export function requestImmediateTranslationForCurrentSource() {
  const { currentTrack, setLyricsStatusMessage, beginTranslationRequest } =
    usePlaybackStore.getState();
  if (!currentTrack) {
    return;
  }

  setLyricsStatusMessage("Translating on-screen lyrics...");
  beginTranslationRequest();
  bridgeClient.requestLyricsRefresh("auto", {
    immediateTranslation: true,
  });
}

export async function saveCurrentTrackToVault({
  includeTranslations = false,
}: {
  includeTranslations?: boolean;
} = {}) {
  const { currentTrack, lyrics, setLyricsStatusMessage } =
    usePlaybackStore.getState();
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

  const result = await bridgeClient.saveCurrentTrackToVault({
    includeTranslations,
  });
  setLyricsStatusMessage(
    `Saved ${result.lineCount || 0} lines to local vault (${result.sourceLabel || "local-vault"}).`,
  );
  bridgeClient.requestLyricsRefresh("local-vault");
  return result;
}
