export type LyricsLiveActivityProps = {
  title: string;
  subtitle: string;
  source: string;
  lyricsMode: 'karaoke' | 'interpolated' | 'static' | 'unknown';
  currentLineText: string;
  isPlaying: boolean;
  progress: number;
  accentHex: string;
};

// Live Activities are iOS-only. Keeping a web-specific module prevents the
// static web renderer from loading expo-widgets' native view manager.
const unsupportedLiveActivity = {
  start() {
    return undefined;
  },
  getInstances() {
    return [];
  },
};

export default unsupportedLiveActivity;
