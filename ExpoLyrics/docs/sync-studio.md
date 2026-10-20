# Sync Studio

Sync lyrics word by word on the phone by tapping or swiping along with the
song, then save them to the vault or export a TTML for Spicy Lyrics.
Open it from the player menu (Lyrics → Sync Studio) or the Local vault screen.

## Flow

1. **Start**: the lyrics KineSync shows for the playing song (their line timing
   is kept), a vault entry, a TTML file, or pasted lyrics. In pasted lyrics a
   row written in brackets, `(yeah, yeah)`, is an ad-lib, and a row with
   `#INSTRUMENTAL` (or `[Instrumental]`, `♪`, `...`) is an instrumental break.
   Gaps of 3 s or more and empty/`♪` lines in existing lyrics show as
   instrumental rows too.
2. **Lines**: tap the pad as each line starts. "Singing stops" marks a pause.
   Ad-lib rows are skipped here. Hold a row and choose "Adjust timing" to
   type or nudge its start and end. "Hear it" plays exactly that span and
   pauses (no lead-in). A new start on a word-synced line moves the whole line.
3. **Words**: *Tap*, with three keys as in Spicy Lyrics' TTML tool:
   **Start** (F) starts the next word, **Commit** (G) ends the word being sung
   and starts the next one at once, **End** (H) ends the word being sung,
   leaving a gap before the next one. The line above the keys shows synced
   words green and the word being sung blue. The last word stays blue until
   you end it: Commit (or Start) ends it and starts the next line's first word
   at the same moment, so one tap per word carries through a verse. If that
   next line was already synced, one Undo brings its old timing back and keeps
   the line you just finished. The "Last G" chip above the keys switches this:
on "End", Commit on the last word acts as End and the next line waits for
its own first tap (Start still carries on). End ends
   it and moves on when there is a pause (with nothing started on the new
   line, End re-ends the line before). To fix one word, tap it in the line
   above the keys (it turns gold): Start re-times its start, then Commit or End
   sets its end (Commit also moves the next word's start to meet it). Tap it
   again to let go. Or *Slide* (like Musixmatch),
   where you hold the bar under the line and slide right. A highlighter
   lights the line letter by letter, and each word is synced the moment its
   last letter lights. The whole bar always spans the whole line, measured
   from where your finger lands, so long lines and wrapped lines take one
   slide. The shaded first stretch of the bar syncs nothing, so you
   can get moving before a short first word ("I"). Sliding back un-syncs a
   word once every one of its letters goes dark. Sliding forward re-times it.
   Letting go before the last word replays the line from 0.5 s before it. Once the last word is synced it moves to the next line at
   once. The "Rewind 0.5 s / Keep playing" toggle chooses whether moving on
   jumps to 0.5 s before the next line or lets the song continue.
4. **Preview** in KineSync's own renderer, nudge everything earlier/later,
   then **Save** (KineSync plays your sync for that song from then on) or
   **Export** a TTML.

Leaving the editor on purpose (the back arrow or Android back) with changes
since you opened the song, or since you last saved it to the vault, asks
"Keep your changes?": Keep, Discard (back to the version you opened, or the
one in the vault, a new song leaves "Continue") or Cancel. So you can try
buttons without changing your sync. If the app is closed or restarted any
other way, nothing is lost: each finished edit (a synced line, a nudge, a menu action, undo) is saved on
the device straight away. Nothing is written during a slide. Backing out
never loses work: "Continue" lists up to five songs in progress (newest first, each with its progress and when it was last edited) and reopens the latest version of any of them. A sixth song replaces the oldest. Back from the preview returns to
the editor, scrolled to the line playing. While the song plays, the editor
lights each word (main lines and ad-libs) as it is sung. The "Lead-in" chip
sets how early (0–2 s) a tapped line starts playing. In the Words stage an
instrumental break can be re-tapped too.

In the preview, the line playing can be nudged ±50 ms, its first word alone
±50 ms (slide syncs often catch it late), or marked to fix: marked lines show
red in the editor until they are synced again.

Tap mode has a "Restart line" button that clears the line and replays it
from 0.5 s before, and "Syllables" (also in the line menu as "Split
syllables"): pick a word, move the cursor with the arrows or tap a letter, and
press "Split here" to make some·thing. "Remove all splits" makes the picked word whole again (from its first
syllable's start to its last one's end), to undo a guess or start that word over. Each part is then synced on its own by
tap or slide, shows with a "·" between parts, and is exported as one word
(Spicy's syllable spans, no space between them). Splitting a synced word
shares its time between the parts by letter count. "Split similar lines" gives
every line with exactly the same words (main lines with main lines, ad-libs
with ad-libs) the same splits. Lines already split differently are left alone
unless you tick "Include lines already split differently".

"Guess this line" and "Whole song" (in the Syllables menu) split words for
you, offline, in the language picked under "Guess in" (remembered). Each
language only touches words in its own script, so a mixed song is done one
language at a time (for example Hindi, then English). Languages:
- English: the US English TeX hyphenation patterns (the `hyphen` package,
  ISC) for dependable breaks, then spelling rules up to the syllable count
  from the `syllable` package (MIT): sing·ing, some·bo·dy.
- Spanish, Portuguese, French, Italian, German, Indonesian/Malay, Turkish,
  Polish and Russian: each language's TeX hyphenation patterns, which follow
  syllables closely there, plus a lone first vowel as its own syllable
  (co·ra·zón, a·mor, a·mo·re, zu·sam·men, на·все·гда).
- Hindi (Devanagari) and Punjabi (Gurmukhi): breaks between aksharas, except
  where the inherent "a" is not said: दिल and ਦਿਲ stay whole, समझना becomes
  स·मझ·ना, ਮਿਲਣਾ becomes ਮਿਲ·ਣਾ.
- Korean: every Hangul block is a syllable (사·랑·해).
Romanized lyrics (Hindi or Punjabi written in English letters) are Latin
script, so pick the language whose rules fit best and expect some fixing.
Words you already split are never changed, synced words keep their timing,
and Undo takes a guess back. Hold a row and choose "Adjust words" to fix single
words: tap a word, correct its spelling (timing kept), nudge its start or end
by 0.25 s or 0.10 s, or tap a time to type an exact one (1:23.45). A spelling fix is saved on Enter, on
leaving the field, or with Done. If the same line appears elsewhere, you are
asked whether to fix it in all of them. "Select
several" picks more than one word of the line to move them together. The link
button next to it ties a word's start and end: on, changing either moves the
whole word (it keeps its length). Off, they move separately (with several
words picked, separate Starts and Ends rows move just those edges). "Hear it"
plays exactly the picked words and pauses (no lead-in, Spotify may run a
moment past the end because it pauses a little late).
"Apply timing to all similar lines" copies a word-synced line's rhythm to every
other line with exactly the same words (main lines match main lines, ad-libs
match ad-libs, however they are split). Each keeps its own start and also gets
this line's syllable splits. Lines already synced word by word are
left alone unless you tick "Include lines that are already synced". "Select multiple lines" closes the sheet and lets you pick synced lines
right in the lyrics list (tap to tick, lines that cannot lend timing are
dimmed). The bar at the bottom shows what will change and applies them all
at once. Each still only reaches lines of its own kind, main lines or
ad-libs, and picked lines are never overwritten. Back cancels picking. A main line's end always covers its ad-lib, so the
player never treats the end of the main words as an instrumental gap.

Duets: hold a main line and choose "Duet: sung by the other singer" (or
"Back to the main singer"). "Mark several lines as duet…" picks lines right in
the list (tap each, or hold a line to pick every line from the last one picked
to it), then Duet or Main singer. Duet lines show "DUET" and sit on the right.
Their ad-libs go with them, a line added below a duet line is sung by the
same singer, and the TTML marks them as the second singer (`ttm:agent="v2"`).

Hold a row to edit its text, make it an ad-lib, add a line, ad-lib or
instrumental break below, turn some of its words into an ad-lib (tap the
first and last word, bracketed words are pre-selected, every word keeps its
timing, including the main-line words on both sides of a mid-line ad-lib),
nudge it, redo its words or delete it. Undo/redo cover every edit. The draft
is kept on the device.

## Timing

Taps use the song position KineSync follows (Spotify via the detector or
the desktop bridge). Settings has a tap delay
correction, the rewind length, and an option to play an audio file of the
song instead, which gives exact positions and a speed setting from 0.25× to 1.5× (tap the speed button by the file name to show or hide the slider, 0.05 steps, 1× resets). The file is
played with `expo-video`, which KineSync already ships.

## Output

An instrumental row is not a lyric line: it ends the line before it at its
start, which leaves the gap the player shows as "…" (3 s or longer).
Ad-lib rows become the background vocals (`ttm:role="x-bg"`) of the main
line above them, so they may overlap it. An ad-lib that opens the song belongs
to the first line, which then starts when the ad-lib does. The TTML has word spans
(`itunes:timing="Word"`), title, artist, and `<amll:meta key="spotifyId">`
when the Spotify track ID is known. Rows that were never synced are left out.

Code: `lib/sync-studio/` (engine, swipe hit-testing, playback, storage) and
`components/sync-studio/`. Checks: `node scripts/check-sync-studio.mjs`.
