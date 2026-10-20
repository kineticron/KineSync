# Lyric sources and configuration

KineSync supports local vault lyrics and online providers including lrc.red, Spicy Lyrics, Musixmatch, QQ Music, NetEase, Kugou, and LRCLIB. Availability and timing differ by recording and provider. Word/syllable timings generally take precedence over line timings. Selecting a provider does not guarantee a match or convert line timings into accurate syllable timings.

## lrc.red

[lrc.red](https://lrc.red) provides a free public [API](https://lrc.red/docs) with no key required. Desktop and phone-only modes search by title and artist, validate the recording and duration, and fetch TTML by ISRC. Tracks that already supply an ISRC use it directly. Original timings, background vocals, TTML, and provider credit are retained. Static or missing lyrics fall through to other providers in Auto mode.

Among online providers, `lrc-red-karaoke` has the highest priority, above `spicy-lyrics-syllable`. `lrc-red-line` ranks immediately above `spicy-lyrics-line`, below all karaoke sources. Existing local vault lookup still runs first. lrc.red can also be selected explicitly in the source picker.

## Spicy Lyrics

Use a publishable `sl_pk_` client key from the [Spicy developer dashboard](https://developers.spicylyrics.org/dashboard). Enter it in Desktop Bridge's Lyrics Sources settings or the mobile app's Advanced lyrics settings. Never embed an `sl_sk_` server key. Spotify credentials are not sent to the Spicy API.

Native requests need no-origin access enabled for the application. Web requests need the actual origin allowlisted. See the [API documentation](https://developers.spicylyrics.org/docs).

Only the official `GET /v1/lyrics/{spotifyTrackId}` developer endpoint is used, with publishable-key authentication. KineSync accepts community syncs from this adapter. Non-community replies fall through to lrc.red and the other online providers. The developer API cannot filter by source before answering.

For an application-wide publishable key, set `publishableKey` in [DesktopBridge/src/spicyLyricsConfig.json](../DesktopBridge/src/spicyLyricsConfig.json). Desktop and mobile builds use this shared public configuration. User configuration and environment variables take precedence. Rebuild after changing it. Environment alternatives are `SPICY_LYRICS_PUBLISHABLE_KEY` for desktop and `EXPO_PUBLIC_SPICY_LYRICS_PUBLISHABLE_KEY` for mobile/web.

Maintainers can submit KineSync as an application template in the developer dashboard. Approval is required before users can obtain configured keys from its catalog. KineSync does not issue keys itself.

## Other providers and translation

Musixmatch anonymous access is configured automatically in desktop and phone-only modes, with a user-token override available. Source availability, throttling, and provider changes can interrupt lookup. QQ Music, NetEase, Kugou, and LRCLIB fallbacks are implemented in the shared lyric service. See its [module layout](../DesktopBridge/src/lyrics/README.md) when changing adapters.

Gemini translation is optional and requires a configured API key. Lyrics are sent to the translation service when requested. Target-language selection is separate from UI localization. Keep API keys out of issues, screenshots, and source control.

## Attribution, caching, and export

For lyrics retrieved through Spicy, attribution stays at the bottom right while lyrics are visible in either renderer, in portrait and landscape. Community handles use U: and M:. Opening playback controls reveals the Spicy Lyrics provider name and a glass background, animated with the controls. Tap the attribution to open contributor links and songwriter details. Apple Music and Spotify responses from Spicy show just their provider name. Missing provider attribution is shown as Unknown. Other sources retain their existing attribution UI.

Community syncs obtained from Spicy Lyrics cannot be exported as TTML or JSON, including after saving to a vault, importing a previously saved copy, or transferring within KineSync. Export restrictions follow the original provider metadata rather than the local-vault label. lrc.red lyrics retain normal save and export support.

Spicy vault copies are deleted at their original API expiry, capped at 30 days from retrieval, and refetched using the official developer API. Saving or transferring a copy does not renew its expiry. On a failed refresh, only the track identifiers remain for retry, with no stale lyrics available for playback or export. A withdrawn or missing community sync is discarded. Maintenance runs while the application is active and resumes on launch or mobile foregrounding. Legacy Spicy recovery copies are removed during migration. See Spicy's [terms](https://developers.spicylyrics.org/terms).
