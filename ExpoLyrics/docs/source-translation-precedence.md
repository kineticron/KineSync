# Source translation precedence

For TTML packets with lrc.red sourceMetadata translation tracks, existing inline
translations remain authoritative. The chosen target-language source track wins
over Gemini on each unambiguous paragraph key; Gemini supplies other lines.
`automaticallyCreated` remains source provenance, not a claim of human authorship.
Track ranking (language, subtitle type, automatic flag, document order) is unchanged.

## Existing controls and data

The settings menu selects a lyric provider, a target language, and requests AI
translation of the current source. Choosing a provider selects the entire lyric
packet; it does not make Gemini output a manual translation. There is no separate
manual subtitle-track picker or per-line translation editor in the inspected UI.
Existing inline lead/background translations and non-AI text already present in
a source packet are represented choices and remain protected. This does not invent
a new manual-choice flag or UI. Source metadata only applies to its own packet;
selecting a different provider does not graft lrc.red subtitles onto its lyrics.

## Small merge boundary

Both services select retained source tracks before display and after the three
current-source AI paths (explicit request, source-stable translation, final pass).
The same shared helper handles fresh Gemini output and Gemini cache hits.
`rememberPublishedLyrics` retains text/provenance for packets with source tracks
so the existing translate-current-source action cannot erase inline choices.
Other provider flows retain their existing translation behavior.

`ttml.appliedTranslations` records displayed source subtitles. The small
`ttml.preservedTranslations` list retains existing inline lead/background text by
index within the unchanged lyric array, including paragraphs without lrc:key.
Source subtitle joins still use lrc:key, never array order. Both vaults retain the
list; the desktop compact serializer adds only that metadata field. No timing,
syllable, background, alignment, or source-track provenance is changed.

New AI fallback metadata records its target language. Switching languages removes
stale AI text and reselects the source track while preserving inline choices.
Legacy AI packets without a target tag cannot reliably identify a mismatched AI
language; no language is guessed. An old unmarked edit already overwritten by AI
cannot be reconstructed as a manual choice. AI provider/count metadata describes
the enrichment pass, not human authorship or the number of visible AI-only lines.

## Regression checks

From the repository root with PATH=/opt/hako/bin:$PATH:

```sh
node --test DesktopBridge/test/lrc-red*.test.js DesktopBridge/test/translation-language.test.js DesktopBridge/test/sqlite-vault.test.js DesktopBridge/test/vault-spotify-import.test.js
node ExpoLyrics/scripts/check-lrc-red-vault.cjs
node ExpoLyrics/scripts/check-mobile-picker-cache.cjs
node ExpoLyrics/scripts/sync-lyrics-picker.cjs --check
```

The service regression runs the actual Desktop and generated Expo services with
mock HTTP responses, asserting fresh AI, AI-cache and source-cache behavior,
per-line fallback, language switching, inline/unkeyed choices, provenance and
unchanged atoms. Vault tests close/reopen real SQLite stores on the host (including
desktop compact serialization), inspect selected text and native UI model fields,
and retain the exact 54/42/12 real-fixture tests. They are not phone/device tests.
