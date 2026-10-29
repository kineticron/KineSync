# Mobile Spotify timing provenance and replay

This change instruments existing behavior. It applies no clock estimate, timestamp
rewrite, output-latency adjustment, fallback change, or smoothing change.

## Evidence and reconstruction limits

The October 28 investigation captured 286 position comparisons over 72 seconds
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

## Event-once results

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

Cluster clock wire fields 1/6/9/11 and player session field 23 are decoded only
while capture is active. A session means `PlayerState.session_id`, not an account
identity. Labels are per-capture counters, not persistent hashes; at most 64
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

Tests also characterize existing global timestamp suppression on a device/session
switch, absent/nonfinite/unsafe epochs, future scheduled-start ambiguity, stale
anchor pairs, pause/buffering/resume/backward seek, wall jumps, registration races,
foreground replay, binary/wrapped/gzip paths, privacy, expiry and buffer limits.
These assertions document existing failures; passing tests do not mean they are
fixed. Before changing timing behavior, collect the new provenance on the actual
phone/device and validate player/server timestamp semantics independently.
