import "expo-live-activity";

declare module "expo-live-activity" {
  export type LyricsLiveActivityConfig = LiveActivityConfig & {
    timerType?: "circular" | "digital";
  };

  export type LyricsLiveActivityState = {
    title: string;
    subtitle?: string;
    progressBar?: {
      date?: number;
      progress?: number;
    };
    imageName?: string;
    dynamicIslandImageName?: string;
    source?: string;
    lyricsMode?: "karaoke" | "interpolated" | "static" | "unknown";
    currentLineText?: string;
    lineStartMs?: number;
    lineEndMs?: number;
    playbackAnchorMs?: number;
    playbackAnchorEpochMs?: number;
    isPlayingLive?: boolean;
    syllablePayload?: string;
  };

  export function startActivity(
    state: LyricsLiveActivityState,
    config?: LyricsLiveActivityConfig,
  ): string | undefined;

  export function updateActivity(
    id: string,
    state: LyricsLiveActivityState,
  ): void;

  export function stopActivity(
    id: string,
    state: LyricsLiveActivityState,
  ): void;
}
