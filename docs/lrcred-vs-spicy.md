# lrc.red and Spicy Lyrics live comparison

Captured on 2026-10-25, 11:30 to 11:35 UTC, against development commit `98f9195` and the reviewed working tree. The requirement is **not fully met**. Final results are 6 passes and 2 failures among 8 non-community tracks. Two community tracks are excluded.

## Method and evidence

The [request evidence](lrcred-vs-spicy.evidence.json) contains 90 captured real HTTP requests with URLs, statuses, response SHA-256 hashes, actual metadata outputs, lyric text hashes and line timestamp samples. Full response bodies are retained locally in `/tmp/lrcred-audit`, named by each request's `bodyFile`. Authorization values are omitted. The evidence file retains selected JSON fields rather than complete lyric bodies.

The baseline harness evaluated the actual desktop lookup from `98f9195`, with its original TTML importer and the production matching and network helpers. Each lookup received only title, artist and duration. No Spotify ID or supplied ISRC was passed to lrc.red. The production function performed Deezer search, ISRC selection, `/s/{isrc}.json`, `/s/{isrc}.ttml` and text fallback when needed. Each HTTP call used the real network, sequentially with a 600 ms delay. No live lookup used mocked responses.

Spotify embed metadata supplied independent playback durations and verified track IDs. Spicy requests used `GET https://api.spicylyrics.org/v1/lyrics/{spotifyTrackId}`, `Authorization: Bearer` with the configured publishable key from `DesktopBridge/src/spicyLyricsConfig.json`, and `User-Agent: KineSync`. All ten returned HTTP 200 and payload `Status: 200`. Every `source_via` was JSON null, shown as `null` below.

Lead and background text were compared separately across the entire song after Unicode NFKC normalization and whitespace removal. Punctuation, spelling and case were retained. Equal hashes mean equal normalized text, not a subjective similarity judgment. Line counts count parsed vocal lines, excluding Spicy interludes. Timing comparisons include both start and end boundaries. For rows with equal counts, every line was checked, beyond the requested first, middle and last samples. Word and Syllable are treated as equivalent granularity. Granularity alone does not establish parity.

## Test set

The two October releases fall within the requested 2026-08-25 to 2026-10-25 window. Their selected Spotify album release dates are both 2026-10-15. The lrc.red metadata dates ew's single to 2026-10-01. Other dates below describe the selected catalog edition or original release as returned by Spotify, not an inferred recording date.

| Song | Input artist | Coverage | Spotify track ID | Playback duration ms |
| --- | --- | --- | --- | ---: |
| ew | DPR CREAM | New release, Korean R&B | `6dfJecdkrYg19hefBy4kts` | 125000 |
| 후 (puff) | DPR CREAM | New release, Korean | `0MmlAwSg3Zx8590JMei6G9` | 128000 |
| Rewind | Wonder Girls | K-pop, 2015 | `2YZa0dsV3xXGZ61XFYiRt8` | 213480 |
| Dynamite | 방탄소년단 | K-pop, localized artist | `5QDLhrAOJJdNAmCTJ8xMyW` | 199053 |
| アイドル | YOASOBI | J-pop, Japanese title | `1hAloWiinXLPQUJxrJReb1` | 211733 |
| First Love | 宇多田ヒカル | J-pop, localized artist, 1999 | `39HrUxcvKF3jtLz7fUDWXc` | 257293 |
| DtMF | Bad Bunny | Spanish, 2025 | `3sK8wGT43QFpWrvNQsrQya` | 237117 |
| Yesterday - Remastered 2009 | The Beatles | Remaster, older catalog | `3BQHpFgAp4l80e1XslIjNI` | 125666 |
| Bohemian Rhapsody - Live Aid | Queen | Live version, 2018 edition | `7xHATAMD7ezTZGYsNAMr5R` | 147840 |
| Billie Jean | Michael Jackson | Older catalog, 2005 compilation | `1Rt3oh7shVSWj6q2MieDHa` | 294601 |

## Results

The ISRC column is the final chosen recording. Baseline Dynamite and First Love returned no match. All other baseline rows selected the same ISRC and sync type as the final result.

| Song | Chosen ISRC | lrc.red sync / lines | Spicy source | source_via | Spicy Type / lines | Same full text | Maximum line boundary delta ms | Requirement |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| ew | KRMIM2652961 | word / 12 | apple_music | null | Syllable / 12 | Yes | 20 | Pass |
| 후 (puff) | KRMIM2654845 | word / 42 | apple_music | null | Syllable / 42 | Yes | 20 | Pass |
| Rewind | US5TA1500050 | line / 54 | apple_music | null | Line / 54 | Yes | 20 | Pass |
| Dynamite | QM7282022872 | word / 62 | apple_music | null | Syllable / 62 | Yes, including background | 20 | Pass after fix |
| アイドル | JPP302300157 | word / 74 | spicy_lyrics | null | Syllable / 80 | No | Not aligned | Community, excluded |
| First Love | JPTO09901670 | word / 32 | apple_music | null | Syllable / 32 | Yes | 20 | Pass after fix |
| DtMF | QMFMF2447070 | word / 62 | spicy_lyrics | null | Syllable / 61 | No, including background | Not aligned | Community, excluded |
| Yesterday - Remastered 2009 | GBAYE0601477 | word / 25 | apple_music | null | Syllable / 25 | Yes | 2053 | Fail, upstream timing differences |
| Bohemian Rhapsody - Live Aid | GBUM71805979 | line / 22 | apple_music | null | Line / 22 | Yes | 20 | Pass |
| Billie Jean | USSM19902991 | word / 56 | apple_music | null | Syllable / 58 | No, including background | Not aligned | Fail, upstream text and timing differences |

## Recording checks

These are actual `/s/{isrc}.json` title, artist and duration values. Catalog identity was checked against the Deezer hit and playback metadata. This is metadata verification, not an audio fingerprint comparison.

| Song | lrc.red title | lrc.red artist | lrc.red duration ms | Recording assessment |
| --- | --- | --- | ---: | --- |
| ew | ew | DPR CREAM | 125000 | Correct title, artist and duration |
| 후 (puff) | 후 (puff) | DPR CREAM & DPR ARTIC | 128000 | Correct title and duration, featured artist retained |
| Rewind | Rewind | الفتيات الرائعات | 213480 | Correct ISRC and duration, Deezer artist Wonder Girls, localized lrc.red artist |
| Dynamite | Dynamite | BTS | 199054 | Correct title and duration, localized input corroborated by Deezer artist ID 6982223 |
| アイドル | アイドル | YOASOBI | 213234 | Correct title and artist, duration differs by 1501 ms |
| First Love | First Love | Hikaru Utada | 257293 | Correct title and duration, localized input corroborated by Deezer artist ID 211217 |
| DtMF | DtMF | バッド・バニー | 237117 | Correct ISRC and duration, Deezer artist Bad Bunny, localized lrc.red artist |
| Yesterday - Remastered 2009 | Yesterday (2009 - Remaster) | The Beatles | 125667 | Correct remaster year, artist and duration |
| Bohemian Rhapsody - Live Aid | Bohemian Rhapsody (Live Aid) | Queen | 147840 | Correct live version, artist and duration |
| Billie Jean | Billie Jean (Single Version) | Michael Jackson | 294653 | Plausible catalog match within 52 ms, edition equivalence remains uncertain |

## Actual timing samples

Values are line start milliseconds as `lrc.red / Spicy`. The evidence also records end times and text hashes. Rows with different text or counts are excluded from positional timing comparisons because matching line numbers do not establish matching lyrics.

| Song | First line | Middle line | Last line |
| --- | --- | --- | --- |
| ew | 35150 / 35130 | 59087 / 59107 | 90806 / 90786 |
| 후 (puff) | 27822 / 27802 | 65443 / 65435 | 103703 / 103683 |
| Rewind | 20370 / 20350 | 112353 / 112373 | 190620 / 190600 |
| Dynamite | 200 / 220 | 84596 / 84576 | 189414 / 189433 |
| First Love | 21574 / 21554 | 133682 / 133702 | 221730 / 221750 |
| Yesterday - Remastered 2009 | 5423 / 4946 | 59711 / 59219 | 114977 / 114467 |
| Bohemian Rhapsody - Live Aid | 23144 / 23164 | 64606 / 64600 | 110940 / 110920 |

Yesterday's sampled start deltas are 477, 492 and 510 ms. Across all starts the maximum is 615 ms. Across starts and ends the maximum is 2053 ms. The raw TTML contains these timings, so this is not importer rounding. The text index lists the same 2009 ISRC, plus explicitly different editions including a 2015 remaster, a 2023 mix and mono. Selecting one of those to improve this comparison would not verify the requested edition.

Billie Jean differs in lyrics as well as grouping. For example, the lrc.red text omits the opening word in Spicy's line beginning “And don't go around”. Its first two line starts are 29143 and 33137 ms, versus 29226 and 33289 ms. The second already differs by 152 ms. A diagnostic fetch of alternative ISRC USSM18200001 also returned 56 lines, with first starts 28763 and 32757 ms, and did not restore parity. USSM18200612 declares `sync: none`. These diagnostic alternatives were not substituted into the final result. No constant timing adjustment or lyric replacement was applied.

## Reviewed fixes and regression coverage

The previous run's work was retained after review and testing. Both TTML importers accept `lrc:timing` and `itunes:timing`, with either quote style. An explicit Line declaration overrides timed nested spans. Word declarations retain syllable timing, joins and background vocals. The new TTML suite passes for both importers. The live Rewind result remains line synced.

The lookup now corroborates a localized artist through Deezer artist search and requires the same numeric artist ID on the track candidate. The live baseline returned no lyrics for Dynamite and First Love despite correct Deezer hits. The final requests resolve their original recordings and satisfy the text and timing checks above. A mismatching corroboration ID is rejected in regression tests.

The reviewed candidate flow retains line results while checking other accepted ISRCs and the text fallback for word timing. Matching enforces the duration bound, separates live, remix or mix, acoustic, instrumental, demo, mono and extended versions, and rejects explicitly incompatible remaster years. Compatible remaster suffix styles still match. Recording metadata duration is checked before downloading TTML.

Additional fixes deduplicate catalog ISRCs before applying the three-candidate limit, avoid repeating catalog searches after a valid cached line result, and allow catalog recovery after a supplied ISRC fails. Regression tests cover each behavior, text fallback upgrades, rejected artists and durations, and preservation of supplied TTML timings. These defensive cases use test fixtures. They are not presented as additional live-song discoveries.

The affected live subset was rerun: Rewind, Dynamite, First Love, Yesterday, the Queen live recording and Billie Jean. Spicy responses were reused for those reruns to avoid redundant API calls. The unaffected ew, puff, アイドル and DtMF rows retain their original live observations. Desktop lookup requests were exercised live. Both desktop and mobile matching and parsing paths were exercised by the regression tests.

## Validation and reproduction

All required checks passed:

- ExpoLyrics `npm run typecheck`
- ExpoLyrics `npm run lint`, with two warnings in unrelated existing files
- ExpoLyrics `npm test`
- DesktopBridge `npm run lint`
- DesktopBridge `npm test`, 109 passing tests

The 37 focused lrc.red tests are included in the desktop total. Expo lint warnings are a useless constructor in `components/lyrics/spicy-upstream-support.ts` and a require import in `components/onboarding/onboarding-screen.tsx`.

The opt-in [live runner](../DesktopBridge/scripts/compare-lrc-red-live.cjs) saves raw responses outside the repository. From the repository root:

```sh
node DesktopBridge/scripts/compare-lrc-red-live.cjs baseline
node DesktopBridge/scripts/compare-lrc-red-live.cjs final 5QDLhrAOJJdNAmCTJ8xMyW 39HrUxcvKF3jtLz7fUDWXc
```

The second command reruns only the two localized-name songs against the current production lookup. Set `LRC_RED_AUDIT_DIR` to choose the capture directory. A baseline run is required first to capture playback metadata and the Spicy comparison responses. This sample does not prove general parity or cover static Spicy payloads. The two remaining upstream failures require corrected provider data or a separately verified source selection policy.

No native changes, SDK changes or version bump were made. A significant future change pushed to main should bump the version across ExpoLyrics app config, mobile and DesktopBridge package files and lockfiles. Nothing is pushed by this verification.
