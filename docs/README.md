# KineSync documentation

<p align="center">
  <strong>Your route from first install to first contribution.</strong><br>
  Choose a starting point, then explore the implementation when you need it.
</p>

| Get started | Make it yours | Build with us |
| --- | --- | --- |
| [Install on Android](../ANDROID_INSTALL.md) or [iOS](../IOS_INSTALL.md) | [Configure lyric sources](lyrics-sources.md) | [Set up a contribution](../CONTRIBUTING.md) |
| [Choose a playback setup](../SETUP.md) | [Run your own bridge](../DOCKER.md) | [Explore the architecture](architecture.md) |
| [Get help](https://github.com/Kineticron/KineSync/issues) | [Import and preserve TTML](../ExpoLyrics/docs/ttml-preservation.md) | [Measure performance](../ExpoLyrics/docs/performance-results.md) |

> [!TIP]
> **New to KineSync?** Install the mobile app first. The Desktop Bridge is optional, and the installation guides walk through phone-only playback.

## Install and use

- [Android installation](../ANDROID_INSTALL.md)
- [iOS installation and sideloading](../IOS_INSTALL.md)
- [Playback setup, pairing, and source builds](../SETUP.md)
- [Docker Desktop Bridge](../DOCKER.md)
- [Lyric providers, credentials, and restrictions](lyrics-sources.md)
- [Troubleshooting and support](https://github.com/Kineticron/KineSync/issues)

## Development

- [Contributing and local checks](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Mobile app](../ExpoLyrics/README.md)
- [Desktop Bridge](../DesktopBridge/README.md)

<details>
<summary><strong>Explore the implementation</strong> · Rendering, timing, storage, and native integration</summary>

- [Shared lyric service layout](../DesktopBridge/src/lyrics/README.md)
- [Lyric renderer behavior and timing](../ExpoLyrics/docs/lyrics-renderers.md)
- [TTML preservation](../ExpoLyrics/docs/ttml-preservation.md)
- [Spotify detector](../ExpoLyrics/docs/spotify-detector.md)
- [Android seeking](../ExpoLyrics/docs/android-seeking.md)
- [Current iOS Live Activity and historical investigation](../ExpoLyrics/docs/live-activities.md)
- [Measured performance and reproduction](../ExpoLyrics/docs/performance-results.md)
- [Static performance scan audit](../scripts/PERFORMANCE_SCAN.md)

</details>

## Project maintenance

- [Release operations](../RELEASES.md)
- [GitHub configuration](maintaining.md)
- [Security policy](../SECURITY.md)
- Be respectful when contributing and reporting issues.
- [Third-party notices](../THIRD_PARTY_NOTICES.md)

> [!NOTE]
> The SDK 58 Live Activity experiment and UI polish notes in `ExpoLyrics/docs/` are historical engineering notes. Use the guides linked above for current installation and behavior.
