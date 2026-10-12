# Third-party notices

KineSync has component-specific licenses: the Desktop Bridge declares GPL-3.0-only and the mobile app declares AGPL-3.0-only. See [LICENSE](LICENSE), [ExpoLyrics/LICENSE](ExpoLyrics/LICENSE), and the component package manifests. This file does not relicense upstream material.

## Lyric renderers

The mobile app includes adapted Spicy Lyrics code and styles and the Apple Music-like Lyrics core package. Their versions, source locations, and licenses are recorded in [ExpoLyrics/THIRD_PARTY_NOTICES.md](ExpoLyrics/THIRD_PARTY_NOTICES.md). Preserve these notices in source distributions and include license material when distributing built applications.

## Dependencies and distribution

The committed npm lockfiles identify dependency versions. Each dependency's license and notices remain authoritative. This summary is not an exhaustive dependency license inventory. When packaging an application, retain the notices included by dependencies and review newly added dependencies for compatibility with the relevant component license.

The Docker image installs third-party programs including Spotify, Spicetify, and Xpra. These programs retain their own licenses and service terms. See [DOCKER.md](DOCKER.md) for the image contents and build provenance. KineSync's software license does not grant rights to Spotify, provider-hosted lyrics, artwork, trademarks, or accounts.

## Changes to upstream code

Record the upstream project, version or commit, license, copied paths, and the nature of modifications when importing or updating third-party code. Prefer keeping upstream copyright notices in the adapted source itself as well as in the component notices.
