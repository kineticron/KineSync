# KineSync Desktop Bridge

[← Documentation](../docs/README.md) · [Architecture](../docs/architecture.md) · [Contributing](../CONTRIBUTING.md)

An optional Electron companion that follows desktop Spotify and sends playback anchors, artwork, and lyrics to the mobile app over WebSocket. Windows uses GSMTC and a native seek helper. The Docker deployment uses MPRIS on Linux.

## Run from source

> [!TIP]
> **Looking for the easiest setup?** Use the [Windows installer](../SETUP.md#method-2-windows-installer-optional-desktop-bridge) or [Docker guide](../DOCKER.md). Source builds are useful when you want to contribute or customize the bridge.

Use Node.js 22. On Windows:

```sh
npm ci
npm start
```

Postinstall attempts to download verified native assets for the matching release. If no assets are available, follow [SETUP.md](../SETUP.md) to build them with Visual Studio C++ tools and .NET 9. To install JavaScript dependencies without the native downloader, set `SKIP_POSTINSTALL=1` before `npm ci`.

Copy [.env.example](.env.example) to `.env` only when needed and keep credentials private. Pair the mobile app with the QR code shown in the bridge. See [Docker setup](../DOCKER.md) and [provider configuration](../docs/lyrics-sources.md) for other deployments.

## Checks and structure

```sh
npm run lint
npm test
```

The lint command checks JavaScript syntax in maintained source, scripts, and tests. It is not an ESLint style check. Tests use Node's built-in runner and mocked providers rather than live credentials.

- `src/index.js`: Electron main process.
- `src/index.html`: bridge settings and status UI.
- `src/lyrics/`: ordered shared-context provider modules. See [the service guide](src/lyrics/README.md).
- `native/`: Windows media-session addon and seek helper.
- `docker/`: Linux runtime configuration.
- `test/`: deterministic regression tests.

## License

GPL-3.0-only. See [the root license](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md).
