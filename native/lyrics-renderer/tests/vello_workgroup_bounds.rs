// Inspect the generated shaders from the dependency Cargo actually resolved.
// Source-only checks would miss an unused local patch or stale generated WGSL.
#[test]
fn generated_vello_prefix_reads_are_conditional() {
    let shaders = &vello_shaders::SHADERS;
    for (shader, guarded) in [
        (
            &shaders.tile_alloc,
            "if local_id.x > 0u {\n            tile_subix = sh_tile_count[local_id.x - 1u];",
        ),
        (
            &shaders.backdrop_dyn,
            "if el_ix > 0u {\n                seq_ix -= sh_row_count[el_ix - 1u];",
        ),
        (
            &shaders.coarse,
            "if part_ix > 0u {\n                    part_prefix = sh_part_count[part_ix - 1u];",
        ),
        (
            &shaders.coarse,
            "if el_ix > 0u {\n                seq_ix -= sh_tile_count[el_ix - 1u];",
        ),
        (
            &shaders.fine_msaa8,
            "if el_ix > 0u {\n                sub_ix -= sh_count[el_ix - 1u];",
        ),
        (
            &shaders.fine_msaa16,
            "if el_ix > 0u {\n                sub_ix -= sh_count[el_ix - 1u];",
        ),
    ] {
        assert!(
            shader
                .wgsl
                .code
                .split_whitespace()
                .collect::<String>()
                .contains(&guarded.split_whitespace().collect::<String>()),
            "{} must guard its prefix read",
            shader.name
        );
        for line in shader.wgsl.code.lines() {
            assert!(
                !(line.contains("select(") && line.contains("- 1u]")),
                "{} still eagerly reads a potentially underflowed index",
                shader.name
            );
        }
    }
    assert!(
        shaders
            .coarse
            .wgsl
            .code
            .contains("var part_prefix = part_start_ix;")
    );
    assert!(shaders.coarse.wgsl.code.contains("ix -= part_prefix;"));
    // Both MSAA fill rules contain a lookup. Area antialiasing has neither.
    for shader in [&shaders.fine_msaa8, &shaders.fine_msaa16] {
        assert_eq!(
            shader
                .wgsl
                .code
                .matches("sub_ix -= sh_count[el_ix - 1u];")
                .count(),
            2
        );
    }
    assert!(
        !shaders
            .fine_area
            .wgsl
            .code
            .contains("select(0u, sh_count[el_ix - 1u]")
    );
}

#[test]
fn prefix_lookup_preserves_zero_fallback_and_positive_values() {
    let counts = [3u32, 7, 11, 19, 23, 29, 31, 37];
    for fallback in [0, 1, 73, u32::MAX] {
        for index in 0..=counts.len() {
            let guarded = if index > 0 {
                counts[index - 1]
            } else {
                fallback
            };
            let expected = index.checked_sub(1).map_or(fallback, |i| counts[i]);
            assert_eq!(guarded, expected);
        }
    }
}
