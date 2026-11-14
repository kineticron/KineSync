# Active performance and delivery overrides

The user's active-run overrides supersede earlier phone checkpoint proposals.
No intermediate IPA delivery or per-effect phone test is required or requested.
Continue host implementation and actual production-Skia visual comparisons until
near-complete parity. Coordinator may run necessary native simulator captures
under existing approval; this worker does not push, dispatch CI or operate Metro.
One final IPA delivery follows near-complete parity and passing host gates.
Final physical-device encode/present/scanout performance remains UNVERIFIED until
that final user test. Host software rendering never establishes phone120fps.

The uncommitted eager typography draft is being revised before acceptance:

- One shared two-strength blur envelope; full-resolution sharp text and half-size
  blur, unchanged premultiplied transparency, no live completion wait, at most two
  application GPU frames. Preserve existing paused/unchanged redraw suppression.
- Detailed timed glyph fragments only for simultaneous active leads and next two
  rows. Visible inactive rows use a cached plain paragraph/scene, without timed
  glyph slice construction. New rows are prepared on demand; immutable geometry
  is reused, with bounded row/viewport/style caches and explicit source/font keys.
- Reuse scene/buffers; measure steady-state scene allocations separately from
  headless driver/readback allocations. No rejected active-line picture cache or
  subpixel epsilon gating is introduced.
- Each effect is an independent measurement gate before combination. Compare
  identical inputs, host profile, adapter, dimensions, sampling and work scope;
  report scene/encode/render CPU time, allocations and throughput honestly.
  Headless submit+wait/readback throughput is not native present-call throughput.
  Keep raw samples and accepted/rejected decisions; unexplained regressions block
  combining effects. No phone-check dependency is imposed on implementation.

Host build storage: CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0 and
CARGO_PROFILE_TEST_DEBUG=0. These are command environments only, not changes to
phone optimization or device cache settings. Existing generated release outputs
and other worktrees/services remain untouched.
