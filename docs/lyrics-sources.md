# Lyric sources and configuration

KineSync supports local vault lyrics and online providers including Spicy Lyrics, Musixmatch, QQ Music, NetEase, Kugou, and LRCLIB. Availability and timing differ by recording and provider. Word/syllable timings generally take precedence over line timings. Selecting a provider does not guarantee a match or convert line timings into accurate syllable timings.

## Spicy Lyrics

Use a publishable `sl_pk_` client key from the [Spicy developer dashboard](https://developers.spicylyrics.org/dashboard). Enter it in Desktop Bridge's Lyrics Sources settings or the mobile app's Advanced lyrics settings. Never embed an `sl_sk_` server key. Spotify credentials are not sent to the Spicy API.

Native requests need no-origin access enabled for the application. Web requests need the actual origin allowlisted. See the [API documentation](https://developers.spicylyrics.org/docs).

For an application-wide publishable key, set `publishableKey` in [DesktopBridge/src/spicyLyricsConfig.json](../DesktopBridge/src/spicyLyricsConfig.json). Desktop and mobile builds use this shared public configuration. User configuration and environment variables take precedence. Rebuild after changing it. Environment alternatives are `SPICY_LYRICS_PUBLISHABLE_KEY` for desktop and `EXPO_PUBLIC_SPICY_LYRICS_PUBLISHABLE_KEY` for mobile/web.

Maintainers can submit KineSync as an application template in the developer dashboard. Approval is required before users can obtain configured keys from its catalog. KineSync does not issue keys itself.

## Other providers and translation

Musixmatch anonymous access is configured automatically in desktop and phone-only modes, with a user-token override available. Source availability, throttling, and provider changes can interrupt lookup. QQ Music, NetEase, Kugou, and LRCLIB fallbacks are implemented in the shared lyric service. See its [module layout](../DesktopBridge/src/lyrics/README.md) when changing adapters.

Gemini translation is optional and requires a configured API key. Lyrics are sent to the translation service when requested. Target-language selection is separate from UI localization. Keep API keys out of issues, screenshots, and source control.

## Attribution, caching, and export

Provider names and supplied community uploader/maker links are shown in both renderers and retained in vault metadata and TTML exports. Missing provider attribution is shown as Unknown. Spicy API cache entries expire after 30 days.

Export support does not grant permission to redistribute provider data. KineSync currently exposes sync-data export, while Spicy's [terms](https://developers.spicylyrics.org/terms) prohibit exporting that data. Review the relevant provider terms before using export or distributing a build that includes those workflows. This limitation remains unresolved. The presence of an export button is not evidence of provider approval.
