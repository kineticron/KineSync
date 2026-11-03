# TTML preservation

Imported TTML is stored with the parsed lyrics in `metadata.ttml.content` on
mobile and desktop. The original XML also survives desktop-to-mobile vault
transfer. Exporting an imported vault entry returns that original document
verbatim, retaining every namespace, attribute, metadata element, agent,
paragraph/span structure, comment, and whitespace sequence. This archives
elements the player does not interpret or display.

The parser also exposes AMLL song/artist/album metadata and songwriter credits
for the vault and playback. Generated TTML preserves opposite alignment,
background translations, and background timings extending beyond lead lines.
Desktop compact storage retains background translations alongside lead
translations and alignment.

lrc.red `head/metadata/sourceMetadata/translations` subtitles are joined by
`text@for` and paragraph `lrc:key`, never by position. Both importers share the
namespace-aware metadata reader. This reader does not resolve DTDs or external
entities. Malformed optional metadata does not replace the existing lyric parser.
Inline lead/background translations take precedence. The existing native AMLL
and Spicy translation fields display the selected subtitle without layout changes.

The default target is English. Service requests select their configured target
language, including when using a cached source packet. Exact language tags rank
first, then non-automatic tracks among equally matching languages, then source
order. Chinese script variants are kept distinct. A missing target track leaves
source translations absent, allowing the existing explicit AI translation path.
Only previously applied metadata text is replaced on language changes. Inline
and subsequently enriched translations remain authoritative. Explicit AI requests
retain their existing override behavior. A selected partial track is not mixed
with other tracks. Conflicting duplicate text keys and duplicate paragraph keys
are skipped. Identical duplicate text entries are harmless.

Packets retain alternate tracks, language/type/automatic provenance, selection,
and applied-key records under `metadata.ttml`, plus `ttmlKey` on keyed lines.
The archived XML always retains the full source. Desktop compact storage retains
paragraph keys, selected subtitle text, alternate tracks and provenance. Mobile
SQLite retains the same fields. Completed enrichment metadata also survives the
desktop round trip so source-track selection cannot supersede explicit AI output.
Romanization and broader TTML timing/namespace parser changes are outside this
feature. Existing cached/imported entries need a source refresh or reimport to
populate the new structured metadata.

Renaming an entry or adding translations for playback does not rewrite its
archived original XML. Code that intentionally generates an updated document
can call `lyricsToTtml` with `preserveOriginal: false`. Generated documents
contain supported lyric fields, not every arbitrary XML extension. The
archived source remains available in metadata.

Entries imported before this change must be imported again from their original
TTML to recover discarded XML metadata. Regenerating an old entry cannot recover
information the previous importer did not store.

The regression suite checks exact XML export, generated lyric round trips,
desktop save/reload, mobile save/reload, and desktop-to-mobile metadata transfer:

```sh
cd ExpoLyrics
npm run test:vault
```

The complete `GeronimoDPRLive.ttml` reference was checked through both importers
and exporters: 123 lyric lines, 27 opposite-aligned lines, 14 background-vocal
lines, album and songwriter metadata, and unchanged regenerated lyric fields.
