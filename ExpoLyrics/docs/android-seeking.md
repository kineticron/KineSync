# Android Spotify seeking

Android Mobile-Only mode sends both progress scrubs and lyric taps through the injected Spotify browser controller. Timestamps remain milliseconds all the way to `seek`.

The previous controller calculated its seek fraction from the DOM slider's maximum, treating that number as seconds or milliseconds. A normalized `max=1` was therefore interpreted as a one-second track; a 45-second lyric tap clamped to the end. A percentage `max=100` was interpreted as a 100-second track, so a 90-second seek in a 180-second song jumped to 90% instead of 50%.

Seeking now uses the fresh Connect sample's duration, independently of the slider's scale. Without Connect it retains the media/Media Session/visible-clock fallback. Slider maxima at or below 100 cannot be used as duration; without another duration source, the command reports an error and dispatches no seek events. Non-finite targets are also rejected. The requested fraction is then mapped to the range's own min/max or the role slider's pixel width.

`npm run test:spotify-browser` includes `scripts/check-spotify-seek.cjs`, which executes the actual injected controller and covers normalized, percentage and offset ranges, role sliders, Connect and visible-clock duration, unknown duration and invalid targets.

The controller was also tested in a locally compiled Android WebView fixture APK on BlueStacks (Android 7.1.1, Chromium 119). Before/after results were:

| Case | Previous slider value | Patched slider value | Expected |
| --- | --- | --- | --- |
| 45 seconds / 180 seconds, range 0–1 | 1 | 0.25 | 0.25 |
| 90 seconds / 180 seconds, range 0–100 | 90 | 50 | 50 |
| Visible clock, no Connect, range 0–1 | — | 0.25 | 0.25 |
| Unknown duration, range 0–1 | — | 0, no change event | No seek |

The native fixture uses the real injected script and real HTML range events with mocked Spotify state. It verifies Android WebView behavior, not end-to-end Spotify playback on an authenticated account. Local harness assets, APK and result logs are under ignored `.expo/android-seek-smoke/`.

KineSync remains on Expo SDK 58. These are JavaScript changes; an existing development client can load them through Metro reload. A distributed release with an embedded JavaScript bundle needs the updated bundle to reach users.
