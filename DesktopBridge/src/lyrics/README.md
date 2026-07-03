# Lyrics service layout

`src/lyricsService.js` is a compatibility facade. The actual lyrics service
is split into ordered parts under `parts/` and loaded by `index.js` into a
shared Node.js VM context.

Parts are ordered to match the original monolithic file's execution order:

- **01a-text-normalization.js**: Text normalization, diacritic folding, tokenization,
  artist name parsing, and Musixmatch artist variant building.
- **01b-candidate-matching.js**: Candidate match quality comparison, title/artist
  overlap scoring, Spotify catalog overlay, featured-artist detection, and
  lyric performer credit analysis.
- **01c-fingerprinting.js**: Lyrics content fingerprinting, Spicy payload
  metadata extraction, featured-variant mismatch detection.
- **01d-lyrics-parsing.js**: Query variant building, timestamp parsing,
  LRC/QRC/YRC syllable parsing.
- **01e-utilities.js**: Timing markup stripping, network helpers (fetch,
  retry, timeout), JSON parsing, source error helpers, and diagnostic
  utilities.
- **02-network-and-spotify.js**: Endpoint constants, fetch/retry helpers,
  source diagnostics, Spotify token/search/playback, coverage scoring.
- **03-qq-sources.js**: QQ legacy, direct musicu, jsososo mirror, open API
  fallback, and Meting adapters.
- **04-netease-spicy-lrclib-sources.js**: Netease, Spicy Lyrics, and LRCLib
  adapters.
- **04-kugou-source.js**: Kugou karaoke (KRC) search, download, and adapter.
- **05a-musixmatch-client.js**: Musixmatch API client, token handling,
  profile resolution, and signature building.
- **05b-musixmatch-parsing.js**: Musixmatch query matching, richsync/subtitle
  parsing, translation mapping, and Musixmatch adapter.
- **06-translation.js**: Gemini/OpenRouter translation enrichment and cache.
- **07a-source-scoring.js**: Source registry, ordering, timing tier
  classification, coverage stats, candidate scoring, and upgrade logic.
- **07b-service-orchestration.js**: `createLyricsService` — the main
  orchestration pipeline.
- **07c-module-exports.js**: Module exports for the lyrics service.
- **08-local-vault-source.js**: Local vault lyrics adapter.

When changing behavior, prefer editing the smallest relevant part file.
Keep in mind that all parts share the same VM context — top-level
`const`/`let` declarations become global to all files.