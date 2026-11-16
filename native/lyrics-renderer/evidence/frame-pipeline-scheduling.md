# Frame preparation, traversal, and idle scheduling

Follow-up implementation items 2, 3, and 4 after diagnostics commit `7d683ee`. Each item has its own commit. No push was attempted.

## Item 2, preparation before acquisition

Commit `5d1e977` moves cold row and manual viewport preparation before acquiring a drawable. The clock is refreshed after acquisition. An immutable preparation key checks whether a stall crossed a geometry or retention boundary. A stale drawable is released before preparing again. At most two acquisition attempts run in a worker operation, then the existing unavailable-drawable retry can supply a fresh opportunity. Animation is sampled only after accepting a prepared drawable. Scene CPU metrics include preparation but exclude acquisition waits.

Tests cover retirement before retry, current-window receipt equivalence, paused playback, and unavailable drawables with manual viewport preparation. Rust fmt, clippy, and tests passed, with 73 ordinary tests passing. Expo typecheck and tests passed. The explicitly enabled cold-to-detailed GPU pixel regression passed on Vulkan llvmpipe.

## Item 3, traversal bounds

Commit `77dfd03` tracks resident geometry during preparation and eviction. Painters perform a conservative prefix search, then traverse resident rows within the result. Bounds include the tallest measured row, row offset extrema, interlude displacement, and effect padding. The historical final culling predicate stays unchanged. Dot and footer painters keep their separate placement logic.

Appearance preparation traverses resident rows. Advancement and animation queries traverse retained owners, preserving outgoing and offscreen animation history. This does not replace overlap-safe playback-window lookup or change the source timing model.

A full-scan oracle checks a 1,000-row track, tall subtitles, distant manual destinations, signed row offsets, DPR, both styles, and interlude boundaries. Rust fmt, clippy, and tests passed, with 74 ordinary tests passing. Expo typecheck and tests passed. The explicitly enabled cold-to-detailed GPU pixel regression passed.

## Item 4, scheduling contract

ABI 9 adds `next_cue_native_ms` and `visible_changes` to the now 168-byte metrics structure. The existing `animating` field requests continuous frames whenever visible activity or retained animation history still needs updates. The header, Rust implementation and layout tests, Swift guard, and JS guard agree on ABI 9.

Cues are sorted and deduplicated once per layout. Lookup uses binary search and supports overlapping or unsorted source rows. Events include source voice/word boundaries, priming, strict post-end changes, and retention boundaries. Native deadlines use the current playback rate. Paused or zero-rate playback has no timed wakeup.

Swift invalidates the display link when there is neither dirty input nor continuous work. One cancellable cue wakeup rearms it one display interval early. The next callback supplies a fresh target timestamp. Session, input revision, cue identity, visibility, playback, and rate guards reject stale work even if a cancelled callback executes. Anchors, gestures, resize, track replacement, and lifecycle changes invalidate old deadlines.

The ABI 9 render call also takes `resume_step_ms`. It is zero during ordinary rendering and one display interval after a scheduled idle interval. This keeps a newly changing spring target from integrating the entire sleep as one animation step. Settled AMLL analytic scroll history ages through the omitted interval before retargeting. Existing background and paused-link reactivation behavior stays separate from scheduled playback idling.

Scheduling is deliberately conservative. Hidden active owners, outgoing tails, and stateful dots can continue requesting frames because their history affects later visible output. The visible-change flag reports conservative visual activity, not a pixel-difference measurement. No claim is made that every static-looking manual viewport sleeps.

Validation:

- Rust fmt, all-target clippy with warnings denied, and tests passed, with 77 ordinary tests passing and 15 ignored by default.
- Continuous-versus-scheduled replay preserves scene streams and protection bounds through idle wakeups, ordinary and emphasized fills, scroll transitions, and final settling for both styles. It verifies that frames are actually omitted.
- The explicitly enabled replay pixel test passed with byte-identical Vulkan output at the tested cue, fill, and transition frames using matched renderer cache history.
- Dot cadence, overlap-safe cue lookup, strict boundaries, seek lookup, pause/rate-zero projection, and rate conversion tests passed.
- C11 header size and offset assertions passed on the host.
- Expo typecheck and tests passed. Gesture checks include executable tests of the Swift wake-delay and callback-guard expressions with controlled clocks, plus source wiring checks for lifecycle, cancellation, resume, and ABI consistency.

Host checks do not compile UIKit or prove device cadence, battery savings, or Metal parity. ABI 9 needs a rebuilt custom development IPA before use. An iOS build and device validation remain unperformed.
