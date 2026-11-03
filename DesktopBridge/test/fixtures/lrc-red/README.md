These are the unmodified lrc.red TTML responses captured by the October 29,
2026 audit in `~/kinesync-lrcred` (see its `REPORT.md` and request manifests).
Tests are offline; no recording JSON is required to parse the TTML.

- Rewind, US5TA1500050: 54 English subtitle lines, line timing.
- seesaw, ZZA0P2622376: 42 English subtitle lines, word timing.
- ew, KRMIM2652961: 12 English subtitle lines, word timing.
- Ariana, USUM72601821: no subtitle track; 311 lead/26 background atoms.
- Bohemian Rhapsody, GBUM71805979: no subtitle track; Live Aid recording.

`baseline.json` records counts, duration, timing mode, and SHA-256 of the complete
JSON-serialized lyric array produced by the pre-change parser at `8f6a74c`.
The regression removes only the newly populated `translatedText` and `ttmlKey`
fields before hashing, checking every original lyric/timing/alignment field.
