# Hidden-panel cadence investigation

The old strip reports native present calls per wall second, not physical scanout.
Render-on-change deliberately stops the display link on a hold and rearms ahead
of the next cue. A window containing holds can therefore show less than 120
without dropping continuously animated frames. This report alone cannot
distinguish intentional holds from continuous-animation misses on the phone.

There are also two plausible continuous-animation costs. The display link
previously permitted a minimum cadence of 30 Hz despite preferring the screen
maximum. Hiding the in-flow diagnostics increases the drawable area, so the
unconditional full-size Gaussian effect work costs more. Neither fact proves
that the reported 90 presents per second was a hardware throughput problem.

While active, the link now requests the screen maximum for minimum, maximum and
preferred cadence, capped at 120. Idle scheduling is unchanged. iOS can still
override the requested cadence for system policy and power conditions.

The compact strip names presents/s rather than FPS and shows the most recent
callback interval, busy-skipped callbacks in the sample window and estimated
missing callback intervals in that window. Callback gaps are not measured
dropped display frames. The strip is not GPU timing. Idle gaps between link
lifetimes do not contribute to the missing-interval estimate.

# Safe filter work elimination

The compositor always runs, preserving the edge fade, linear conversion and
appearance channels. Gaussian work only runs when a composite branch can sample
it. Fully protected or blur-disabled frames without glow skip all five filter
passes. A frame with at most 160 scaled pixels outside the protected band skips
only the far horizontal and vertical passes. Glow retains both bases even when
distance blur is disabled. Texture dimensions, kernels and weights are unchanged.
This is a conservative viewport test, not an ink-bounds approximation.

# Relative host evidence

Command from repository root

    cargo +1.97.0 run --release --manifest-path native/lyrics-renderer/Cargo.toml --example filter-bench

The synthetic 600x900 fixture uses repeated white rectangles. It exercises the
production appearance GPU pipeline with two warmup frames and ten measured
frames per case. Times below are median CPU wall time including the profiling
wait, on Vulkan llvmpipe LLVM 20.1.2. They are not iPhone Metal or GPU frame times.
System load can move these values substantially.

Sharp, blur disabled, 22.607 ms before and 10.613 ms after.
Fully protected, 23.244 ms before and 7.866 ms after.
Near-only extent, 22.287 ms before and 19.052 ms after.
Far-blur extent, 25.162 ms before and 23.848 ms after.
Glow, 27.303 ms before and 23.788 ms after.

Far and glow execute unchanged work and their timing difference is noise, not
an optimization claim. Final RGBA bytes had identical FNV-1a hashes before and
after in every case, respectively 71414d810279aa85, 71414d810279aa85,
1bb1ddf7d76ef565, 36441ce34f3bd455 and bf95764e36dbcd5.

Device follow-up must compare a continuously filling word or scroll with both
panel states. Presents/s, callback interval, busy skips and callback gaps can
separate intentional holding from callback or submission pressure. A custom
development IPA is required for the Swift changes. No ABI version change.
