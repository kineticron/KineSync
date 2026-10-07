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

Renaming an entry or adding translations for playback does not rewrite its
archived original XML. Code that intentionally generates an updated document
can call `lyricsToTtml` with `preserveOriginal: false`; generated documents
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
