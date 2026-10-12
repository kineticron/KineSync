# KineSync mobile app

[← Documentation](../docs/README.md) · [Architecture](../docs/architecture.md) · [Contributing](../CONTRIBUTING.md)

The Expo / React Native app for Android and iOS. It follows Spotify through an embedded browser or the optional Desktop Bridge and presents synchronized lyrics using Spicy and AMLL WebView hosts.

For downloads and end-user setup, see [Android installation](../ANDROID_INSTALL.md), [iOS installation](../IOS_INSTALL.md), and the [documentation index](../docs/README.md).

## Development

> [!IMPORTANT]
> **Native features need a native build.** Expo Go cannot validate the iOS widget or every native module. Use a release build for performance comparisons.

Use Node.js 22 and the committed npm lockfile:

```sh
npm ci
npm start
```

The project currently uses Expo SDK 58, React Native 0.88.0-rc.3, React 19, Reanimated, and Zustand. Exact versions are in [package.json](package.json) and `package-lock.json`. Native modules and widgets require a development or release build. Expo Go cannot exercise all features.

For an Android native build, install the Android SDK and JDK 17, then use `npm run android`. For iOS, use macOS with Xcode and the SDK required by the current Expo version, then use `npm run ios`. Prebuild generates ignored native projects from the tracked config plugins and module sources. See [SETUP.md](../SETUP.md) for pairing and Windows native build requirements.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run test:performance
```

The default test suite runs deterministic lyric, playback, vault, tour, artwork, security, detector, and launch checks without an emulator. Live Activity checks have their own `test:live-activity` command. Timing-based performance assertions are separate from CI's deterministic suite. Compare native performance with matching release builds. [Performance measurements](docs/performance-results.md) include reproduction commands and measurement limits.

## Generated bundles and shared providers

Rebuild tracked WebView bundles after changing an entry point or its styles:

```sh
npm run build:spicy-webview
npm run build:amll-webview
```

Shared provider changes originate in `DesktopBridge/src/lyrics/parts/`. The mobile service is a portable bundled copy with runtime adapters. No regeneration tool is currently shipped. Keep provider behavior aligned in both implementations and run their regression tests.

## Structure

| Directory | Purpose |
| --- | --- |
| `app/` | Expo Router screens |
| `components/lyrics/` | WebView hosts, controls, artwork, and settings |
| `lib/` | Playback, providers, storage, translation, and timing |
| `store/`, `providers/`, `hooks/` | State and lifecycle |
| `plugins/`, `modules/`, `widgets/` | Native project generation and iOS integration |
| `scripts/` | Tests, bundle generation, and profiling |
| `docs/` | Implementation notes and measurement reports |

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Upstream renderer code retains its own attribution.
