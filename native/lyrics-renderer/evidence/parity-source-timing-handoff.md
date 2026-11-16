# Source timing checkpoint after explicit resume

Preserves c08dfd2 ABI4 typography, cached font ownership and rendering pipeline.
The existing dirty `src/lib.rs`, `src/style_timing.rs` and `test/style-timing.json`
were completed without reset/discard. The last stored timing tests and strict
Clippy logs were already passing; the earlier compiler ambiguity in Bezier float
inference had been fixed. This resumed batch added fail-closed coverage counts,
reviewed the math, and freshly verified the compact checkpoint.

`style_timing.rs` ports the actual production Spicy spline coefficients, word/
letter underdamped springs, reveal progress and emphasis timing; AMLL critical/
underdamped spring branches, 32-sample emphasis/float interpolation and reversed
release clock. Coefficients come from the actual cubic-spline dependency, not a
fitted replacement. Goldens pin and rehash all four production/dependency source
files. They cover80 word frames,168 emphasis/float samples,7 clock samples and16
spring samples, including pause, backward seek, long jumps and variable dt.

[Verification](parity-source-timing-verification.json):5 tests pass. Maximum numeric
delta from actual source helpers is4.44e-16 Spicy and2.22e-16 AMLL. A warmed120-frame,
40-emphasized-letter updater test observes zero invoking-thread allocations;
state and letter buffers are allocated once. Strict all-target host and iOS
Clippy and fmt pass. Host incremental/debug output remains disabled; phone build
optimization is unchanged. Logs are `parity-source-timing-*.log`.

## Deliberately isolated until integration gates

These functions are **not called by live rendering yet**. Equation agreement is
not pixel parity, a new encode/throughput result or physical120fps evidence.
Scene/GPU/FFI/native-clock integrator and player viewport files remain unchanged
from c08dfd2; no new shader, blur pass, wait, frame queue, active-picture cache or
subpixel redraw gating was introduced. Source spring settling thresholds are
retained math, not a new rule for skipping frames. Existing ABI4 is unchanged.

Future integration must allocate state only when the near-active window changes,
keep immutable geometry separate from mutable timing state, and reset state on
source/word identity change. `WordState` owns an immutable spec; callers create a
new state when identity changes. Reusing cached geometry must not revive an old
track's release clock or animated state. Source emphasis/group metadata still
needs explicit validated transport before full letter-effect integration.

Each rendered effect requires its independent comparative host performance gate
before combination and actual-production-Skia numeric scores from the reviewed
parent/Gemini tooling. No comparison JS/Python/CLI was edited or unreviewed work
merged. Deterministic full-native capture, auxiliary rows/interludes/attribution,
style scroll and final native font/fallback proof remain incomplete. No tool PASS
is called parity. No intermediate phone test or IPA is requested; one final IPA
follows near-complete parity and passing host gates.

## Budget boundary and next batch

Coordinator supplied LIVE2026-11-14 02:40 PT: primary used0%, weekly used76%,
remaining24%, explicitly authorizing this resumed batch. This worker's tool catalog
still exposes no account/rateLimits/read; it does not invent a newer live reading.
The latest user guard supersedes the earlier <15 rule: halt at a new batch if
remaining <=15%; resume requires >15% and approval. The next batch needs the
coordinator's live boundary check. No reset credit, high/Ultra, alternate provider,
parallel Codex, new thread, push, CI or Metro operation was used.
