# Mobile Spotify timing provenance and replay

Instrumentation applies no clock estimate, timestamp rewrite, output-latency
adjustment, fallback change, or smoothing change. A subsequent scoped correctness
fix accepts known device/session handoffs across different source clocks and
protects them from stale registration snapshots; it does not calibrate timing.

## Evidence and reconstruction limits

The original October 28 investigation captured 286 position comparisons over 72 seconds
from actual Spotify Linux playback. The mobile detector ran in Node on the same
sandbox host as MPRIS, not on a physical phone. DesktopBridge's position minus
MPRIS had median -1 ms (p05 -4, p95 +2). This is position telemetry, not verified
lyric/audio alignment.

The original `live-comparison.cjs` recomputed `detectorPacket(latestSample, now)`
every 250 ms. Production instead constructs a packet on the sample callback,
ingests it into the playback store, and advances the store's monotonic anchor.
Metadata enrichment can republish the latest sample later. Consequently, the
original harness's stable -1,519 ms playing median is not a measurement of the
production store after resume or seek.

`scripts/fixtures/spotify-timing-live.json` retains every numerical comparison and
all five extracted mobile events, with one common epoch removed. It excludes
track/title/artist/device/account identifiers, credentials, endpoints and raw
payloads. Player-state envelopes and flags are reconstructed from extracted
`positionMs`, `positionTimestampMs`, `playing`, and callback `at` values. The
capture did not preserve raw Dealer schema/flags, exact native arrival time,
packet/store processing times, or metadata callbacks. Its event `at` is the sample
callback time, slightly later than the detector's WS callback receipt. Using it
as receipt is an explicit reconstruction assumption, not a recovered raw trace.
The observer URL was derived on the captured host and registration succeeded;
the URL itself was not captured from desktop network traffic.

## Measurement protocol and primary evidence

All primary position-baseline measurements must follow a **fresh explicit playback
start**, with the command, successful completion and subsequent state/track match
recorded. A phase name such as `initial`, `resumed` or `seek` is not proof of a fresh
start. Unknown and auto-advanced starts are excluded. After auto-advance, issue
and verify a new explicit start before collecting another primary baseline.
Track-change/transient behavior is a separate case from settled fresh-start
observations. No measurement establishes a universal numerical delay.

Audit of the original `live-comparison.cjs` found only Pause at 18 seconds, Play at
23 seconds (resume), seek at 38 seconds, and a transport switch at 53 seconds.
It issues no explicit playback start before observation. All five original
anchors therefore have **unknown start provenance** for fresh-baseline purposes,
including pause/resume/seek. The original run's primary baseline is **NOT
ESTABLISHED**. Its retained tables below are secondary exploratory telemetry.

A separate tester subsequently provided `independent-before/event-once-results.json`
and the audited `live-event-once.cjs`: 543 rows and 14 mobile callbacks over about
140 seconds. This harness records successful explicit MPRIS **Next** commands at
1.5, 25 and 49 seconds after harness startup, with observed title changes and
positions near track start. These are commanded fresh starts; no inference is
made from phase labels alone. Private titles are replaced with temporary track
numbers in `scripts/fixtures/spotify-timing-explicit-start.json`. Title matching
is weaker than an authoritative URI match; the source artifact did not retain
URIs. The initial already-playing segment is still unknown. Pause/resume, seek,
and the later automatic track advance are excluded from primary aggregates.

The callback invokes `detectorPacket` once and immediately ingests it into a
separate real mobile playback store. Rows advance that store with local
`performance.now()`. The JSON summary misleadingly still aggregates the repeated
source projection (`mobileMinusMprisMs`, overall median -1513 ms), so it is **not**
the primary store result. Recomputed from the actual `mobileStoreMinusMprisMs`
row field, after three seconds and requiring matching tracks/all sources playing:

| Explicit commanded start | Primary rows | Measured event-once store minus MPRIS median | Repeated projection median | DesktopBridge minus MPRIS median |
| --- | ---: | ---: | ---: | ---: |
| Next 1 | 82 | -173.858 ms | -1515 ms | -1 ms |
| Next 2 | 84 | -124.058 ms | -1494 ms | -1 ms |
| Next 3 | 84 | -193.883 ms | -1522 ms | -1 ms |

This establishes a **sandbox position-telemetry fresh-start baseline**, not an
independent source-clock calibration, phone baseline, audible presentation epoch,
or universal delay. The first start includes additional real state updates and
an early transient, with sampled store errors ranging roughly -1473 to -168 ms
inside the eligible phase; its median does not describe every transient.

The fixture preserves action evidence and all numerical comparisons; inputs are
reconstructed envelopes, not raw Dealer messages. Replaying event-once state
agrees with measured store errors within 3.394 ms (a 5 ms test tolerance), because
callback wall time was logged after ingest and exact packet/store monotonic
stamps were not retained. This tolerance is reconstruction error, not an absolute
clock/audio accuracy claim. The harness never performs catalog metadata
republication, so the earlier metadata-delay experiments remain hypothetical.
New instrumentation can capture those stages prospectively; neither artifact
contains them. Inspection of the private capture directory found credentials,
audio/transition metadata and a CDP session-discovery script, but **no retained
raw Dealer playback envelopes**. The discovery script captures request credentials
and websocket URLs, not websocket frame bodies. No raw fixture is invented.

Fresh-start results disprove a generalized 1.52-second production-store lag in
these commanded starts. A smaller 124–194 ms residual remains. The old unknown-start
initial residual, future timestamp semantics and real metadata callback effects
remain unresolved; none identifies a clock offset or authorizes a blind timestamp
rewrite. There is **no justified main timestamp-level correction** from these
observables. No fresh before/after timing improvement is claimed for the ordering
fix below; the live events do not exercise an older-clock device/session handoff.

The replay's primary-eligibility guard requires a successful explicit-start action,
observed track change, matching action/receipt chronology and a fresh-start case.
It rejects unknown provenance, failed/unmatched commands, phase labels without
action evidence, pause/resume, seek and automatic transitions. Synthetic track
changes are also tested separately through parser/detector/packet/store.

## Secondary exploratory event-once results (unknown start provenance)

Run `npm run test:spotify-detector` with supported Node (validated with 24.21.0).
The timing script bundles the actual parser, detector, packet and playback store;
only native storage/AppState, clocks, timers and transport are stubbed. Inputs
pass through the detector's real WS callback and acceptance logic. It reconstructs
all 286 original repeated-projection positions exactly, then compares event-once
store advancement against the recorded independent MPRIS numerical positions.

Negative error means behind MPRIS. All times below are relative, in milliseconds.
The range excludes command-to-state races: MPRIS can change before the matching
Dealer event. Stable medians require more than three seconds since both phase
start and event receipt; the second event has no such window.

| Event | Receipt | Source minus receipt | First sampled store error | In-phase store error range | Stable store median | Original repeated-projection phase median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial playing | 0 | -16609 | -1493 | -1499 to -1493 | -1498 | -1498 |
| Second playing anchor | 15055 | -29644 | -1419 | -1423 to -1419 | unavailable | unavailable |
| Pause | 17629 | +1398 | 0 | 0 to 0 | 0 | 0 |
| Resume | 22654 | +1387 | -133 | -134 to -127 | -133 | -1520 |
| Seek | 38037 | +1249 | -269 | -271 to -264 | -270 | -1519 |

Relay phase continues using the seek anchor and changes transport for the desktop
pairing path; it supplies no new mobile anchor. Original relay phase median is
-1519 ms, while the event-once store remains near -270 ms.

Metadata republication at hypothetical delays produces the following **replay
results**, not captured production metadata measurements:

| Delay after each eligible callback | Initial stable median | Second anchor in-phase range | Pause stable median | Resume stable median | Seek/relay stable median |
| --- | ---: | ---: | ---: | ---: | ---: |
| No republication | -1498 | -1423 to -1419 | 0 | -133 | -270 |
| 250 ms | -1498 | -1423 to -1419 | 0 | -383 | -520 |
| 1000 ms | -1498 | -1423 to -1419 | 0 | -1133 | -1270 |
| 1500 ms | -1498 | -1423 to -1419 | 0 | -1520 | -1519 |
| 2000 ms | -1498 | -1423 to -1419 | 0 | -1520 | -1519 |
| 5000 ms | -1498 | not applied before next event | 0 | -1520 | -1519 |

The script also emits per-event first/range/median results for every delay.
Republication is applied only if it precedes the next callback; production uses
the latest sample, not a queued obsolete sample. The real component's catalog
cache means enrichment is not necessarily requested at each pause/resume/seek;
the delayed republications deliberately exercise possible timing, not observed
frequency. Delays of 250/1000 ms are before both future playing epochs;
1500/2000/5000 ms are after them. A clock-valid old anchor does not lose time on
enrichment; the future-anchor case does because the original source is projected
again. No metadata behavior is changed in this instrumentation step.

## Causal conclusion

`projectedPosition` adds `max(0, localWall - sourceTimestamp)` while playing. Equal
clocks and an old anchor already compensate delivery age exactly once. A future
anchor adds zero at callback time; `detectorPacket` then assigns local wall time
to `timestamp` and `capturedAtMs`. The store sees no upstream age and immediately
advances monotonically. Repeatedly projecting the source instead keeps clamping
until its future epoch, producing a different timeline. Re-enrichment can reset
the store toward that timeline. The 80 ms store deadband also matters for small
ordinary corrections; its diagnostic snapshot interval is 1000 ms, while visible
lyrics/timelines interpolate independently.

The initial old anchors retain a roughly 1.5-second discrepancy in the event-once
path. Staleness alone with a consistent timestamp/position pair is compensated;
a stale position paired with a newer timestamp, a producer clock discrepancy,
or different position semantics could each explain residual error. Future source
anchors are strong provenance evidence, but do not distinguish skew from a valid
scheduled start. Neither this capture nor the server field name establishes a
player/server clock mapping. This change intentionally does not calibrate clocks.
HTTP Date's second precision cannot justify a millisecond correction.

The separate audio transition capture suggests 280–290 ms **extra resume delay
relative to pause**. Unknown capture epoch/buffering and absent aligned vocal or
TTML reference prevent an absolute audio/lyric claim. It does not establish that
the 1.52-second position discrepancy is audio latency.

## Using the opt-in capture

Open Spotify diagnostics, choose **Start capture**, reproduce the issue, reopen
and choose **Share capture**. Opening the dialog does not start collection or
share anything. **Clear** discards retained records. Capture is memory-only and
off by default; no files, uploads, polling, extra requests or persistent setting
are introduced. Records stop after 60 seconds of local monotonic time or are
restricted to the latest 256 records. Expiration is checked lazily on the next
capture operation/export; there is no new timer. App termination loses the data.

Exports contain an immutable source anchor and separate receipt, parse and
stage-processing wall/monotonic stamps, normalized packet/store source clocks,
store rejection reasons, selected raw numeric position and player
timestamp, sanitized schema path, cluster clocks when present, playback flags
at packet/store stages, local connection generation and temporary device,
playback-session and connection labels. Source monotonic time is explicitly
unavailable. Missing, malformed and nonfinite numeric values receive labels;
unsafe finite JS numbers remain approximate evidence, not validated epochs.
Schema paths replace dynamic keys and array indexes with `*`.

Cluster clock wire fields 1/6/9/11 are decoded only while capture is active.
Player session field 23 is always decoded for scoped ordering; only its temporary
label enters an opt-in export. A session means `PlayerState.session_id`, not an
account identity. Labels are per-capture counters, not persistent hashes; at most 64
alias mappings are retained, so an evicted identity can receive a new label.
No device names, titles, track IDs, raw connection/session/account IDs, URLs,
headers, tokens, cookies, arbitrary strings or raw payloads enter the export.
The packet-to-provenance association uses a WeakMap; wire packets are unchanged.

The frozen provenance keeps original receipt through registration buffering,
metadata spread/republication and foreground replay. Legacy `Sample.receivedAt`
behavior, including the foreground fallback relabel, remains unchanged; the
immutable diagnostic receipt is the original observation. Parsing a cached
sample never manufactures a new original receipt. Starting capture cannot
retroactively annotate an already-cached sample; wait for a fresh state event.
Clearing or restarting capture makes old anchors ineligible for recording.

Tests cover scoped timestamp ordering across device/session switches,
absent/nonfinite/unsafe epochs, future scheduled-start ambiguity, stale
anchor pairs, pause/buffering/resume/backward seek, wall jumps, registration races,
foreground replay, binary/wrapped/gzip paths, privacy, expiry and buffer limits.
These assertions document existing failures; passing tests do not mean they are
fixed. Before changing timing behavior, collect the new provenance on the actual
phone/device and validate player/server timestamp semantics independently.

## Scoped device/session ordering correction

Player timestamps cannot be globally ordered across devices or playback sessions.
A positive change between two known active device IDs or playback session IDs now
resets the timestamp watermark and duplicate fence. A session-only handoff with
otherwise equal state is accepted. Binary PlayerState field 23 (`session_id`) is
always decoded for ordering, even with diagnostics off; raw identities still do
not enter timing exports. A device-only switch discards the prior device's session
scope if the incoming session is missing.

Missing/empty identity fields inherit the known scope and do not prove a handoff;
they neither reset ordering nor bypass stale suppression. First discovering an
identity after anonymous state is similarly insufficient evidence of a new clock.
This conservative choice may reject an anonymous older-clock handoff until explicit
refresh or positive identity-change evidence appears. Timestamp-less updates do
not lower the watermark within an unchanged scope. Explicit refresh and logout
clear the source fences. Ordinary reconnect retains known source ordering, while
its new connection generation can confirm identical state once. Old socket
callbacks are ignored by the existing generation check.

After a Dealer state is accepted on a connection, an HTTP registration snapshot
with a conflicting known device/session cannot switch back, regardless of its
numerically larger source timestamp. Pending Dealer state is applied first.
Registration completion is additionally bound to its original connection ID,
so an aborted response that nevertheless resolves after ID replacement is ignored.
Same-source older registration updates remain rejected. A different-source HTTP
snapshot after live state is ambiguous and conservatively skipped until another
Dealer update or refresh; source timestamps cannot resolve that race. A late
Dealer identity switch can still be ambiguous without a server sequence/version;
this patch does not manufacture cross-device chronology.

Both diagnostics-off/on regressions exercise older-clock device-only/session-only
switches, equal-state duplicates, same-source stale and identity-less frames,
missing timestamps, refresh/logout, reconnect and connection replacement, plus
cross-device and cross-session registration races. These are synthetic regression
inputs through the actual implementation, not fabricated raw live frames.

## Transition resynchronization feasibility (design only)

The new tester run contains an actual automatic transition after an explicit
near-end seek. It records an old-track stopped callback and a new-track playing
callback about 2.35 seconds apart. Those are JS state observations, **not measured
audio presentation or detachment**. The earlier five-event run contained no track
change. Neither resume nor seek is labeled a track transition.

1. **First post-transition Dealer update:** a new authoritative position can repair
   a source/store mismatch, provided track/device/session and timestamp semantics
   are valid. Production already ingests such anchors, resets on track identity
   change and applies ordinary corrections outside its 80 ms deadband. The event
   can arrive late, be buffering/stale, or carry a future epoch; reanchoring cannot
   prove the output has begun presenting the corresponding audio.
2. **Short-term drift detection:** compare successive same-scope source anchors
   with the monotonically projected store, using receipt/processing provenance.
   This can reveal inconsistent source/store progression, dropped state or an
   explicit seek. Sparse callbacks (14 in about 140 seconds, including commands),
   decoding failures, unknown clocks and legitimate scheduled/buffering states
   prevent a guaranteed detection deadline or unique diagnosis. Repeatedly
   projecting the same source is not an independent drift measurement and can
   recreate the demonstrated harness artifact. No drift estimator is added.
3. **Resync on the next playback-state event:** this already supplies the next
   chance to correct the reported timeline; retaining provenance and fixing scoped
   ordering prevents a valid handoff from being lost. It offers no correction
   before the event arrives and cannot repair audio buffering that is absent from
   every reported position. No transition-specific resync policy is implemented.

Device presentation buffering, including remote Bluetooth, requires a calibrated
output/audio reference or trustworthy presentation timestamps. Dealer state,
DesktopBridge/MPRIS agreement, local RTT, HTTP Date and store residuals cannot
observe that presentation directly. Audio-relative calibration must remain
separate, per route/device and measured with uncertainty. All transition proposals
remain design-only; no fixed offset, universal delay or transition correction is
implemented.
