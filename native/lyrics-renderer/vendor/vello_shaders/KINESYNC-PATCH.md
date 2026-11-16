# Local Vello shader safety patch

Source is the crates.io vello_shaders 0.12.0 package, unchanged except for six prefix-sum reads in shader/tile_alloc.wgsl, shader/backdrop_dyn.wgsl, shader/coarse.wgsl and shader/fine.wgsl. Registry bookkeeping and the unused package lockfile are omitted. The original registry package SHA256 is 8af58dc04b4e7b87a9688fa12443a49d5916814fe78fa64d93f5b2d3f3e5bcac. Its upstream VCS commit is b7e8f523b45c07a5edb806bb7241ef5afe34a882 at research/vello_shaders. KINESYNC-PROVENANCE.json pins original and patched hashes for every upstream file. The six modified lookups are tile_alloc tile_subix, backdrop_dyn seq_ix, coarse part_prefix and seq_ix, and fine sub_ix in both MSAA fill rules. Upstream licenses are retained.

WGSL select evaluates both value operands. The previous discarded operand read a workgroup array at index 0u - 1u for zero-index lanes while Vello compiles shaders without runtime bounds checks. Explicit conditional reads prevent that underflow. The coarse partition lookup retains its nonzero part_start_ix fallback.

Upstream diagnosis https://github.com/linebender/vello/issues/1816
Upstream proposal and conditional-branch review https://github.com/linebender/vello/pull/1817

This is a candidate fix for our Pixel 8a Vulkan device loss, not device verification. Keep rendering on the GPU with the same appearance and queue behavior. The correction applies to all backends because the invalid access is undefined on every backend. No CPU fallback or global validation-disable change is used.

Cargo patches this crate locally and its build.rs regenerates the embedded shader variants. Tests inspect the resolved generated shaders, not only source files. Remove this vendor directory and patch once the pinned upstream release incorporates an equivalent fix, retaining regression coverage.
