//! Supplement CoreText's single-family fallback with drawable iOS system families.
use parley::{FontContext, fontique::FallbackKey};

// Fontique already discovers these through CoreText URLs, including TTC indexes.
// Names are candidates, never promises that downloadable fonts are installed.
const JAPANESE: &[&str] = &["Hiragino Sans", "Hiragino Kaku Gothic ProN"];
const CHINESE: &[&str] = &[
    "PingFang SC",
    "PingFang TC",
    "PingFang HK",
    "Heiti SC",
    "Heiti TC",
];
const KOREAN: &[&str] = &["Apple SD Gothic Neo"];

pub(crate) fn configure(context: &mut FontContext) {
    use parley::fontique::Script;
    // The app currently shapes without a locale. Preserve the CoreText choice
    // first, then let Parley try more families for uncovered clusters. Fontique
    // also adds this default Han list to locale-specific and punctuation queries.
    extend(
        context,
        Script::from_bytes(*b"Hani").into(),
        JAPANESE.iter().chain(CHINESE).chain(KOREAN).copied(),
    );
    extend(
        context,
        Script::from_bytes(*b"Hang").into(),
        KOREAN.iter().copied(),
    );
}

fn extend(context: &mut FontContext, key: FallbackKey, names: impl Iterator<Item = &'static str>) {
    let mut families: Vec<_> = context.collection.fallback_families(key).collect();
    families.extend(names.filter_map(|name| context.collection.family_id(name)));
    let mut unique = Vec::new();
    for id in families {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    // Fontique's CoreText scan has already rejected hvgl faces. Do not open
    // every font again or reject a family based on one sample/weight. Parley's
    // cluster matching tries subsequent families when a face lacks coverage.
    // An empty override would suppress the platform fallback entirely.
    if !unique.is_empty() {
        context.collection.set_fallbacks(key, unique.into_iter());
    }
}

#[cfg(test)]
fn drawable(
    font: &skrifa::FontRef<'_>,
    glyph: skrifa::GlyphId,
    coords: &[skrifa::instance::NormalizedCoord],
) -> bool {
    use skrifa::MetadataProvider;
    if glyph.to_u32() == 0 {
        return false;
    }
    let outlines = font.outline_glyphs();
    let Some(outline) = outlines.get(glyph) else {
        return false;
    };
    let mut path: Vec<skrifa::outline::pen::PathElement> = Vec::new();
    outline
        .draw(
            skrifa::outline::DrawSettings::unhinted(skrifa::instance::Size::new(32.0), coords),
            &mut path,
        )
        .is_ok()
        && path.len() > 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use parley::fontique::{Collection, CollectionOptions, FontInfoOverride, Script};
    use skrifa::FontRef;

    fn isolated() -> FontContext {
        FontContext {
            collection: Collection::new(CollectionOptions {
                system_fonts: false,
                ..Default::default()
            }),
            source_cache: Default::default(),
        }
    }

    fn assert_shaped_outlines(context: &mut FontContext, text: &str, weight: f32) -> Vec<u32> {
        let layout = crate::scene::shape(
            text,
            context,
            &mut parley::LayoutContext::new(),
            32.0,
            40.0,
            weight,
            "'SF Pro Display', sans-serif",
            &[],
            0.0,
        );
        let mut indexes = Vec::new();
        let mut glyph_count = 0;
        for line in layout.lines() {
            for run in line.runs() {
                let data = run.font();
                let font = FontRef::from_index(data.data.as_ref(), data.index).unwrap();
                indexes.push(data.index);
                for cluster in run.visual_clusters() {
                    for glyph in cluster.glyphs() {
                        assert!(
                            drawable(
                                &font,
                                skrifa::GlyphId::new(glyph.id),
                                run.normalized_coords()
                            ),
                            "missing/undrawable glyph {} in {text:?}, weight {weight}, face {}",
                            glyph.id,
                            data.index
                        );
                        glyph_count += 1;
                    }
                }
            }
        }
        assert!(
            glyph_count >= text.chars().count(),
            "empty or incomplete shaping for {text:?}"
        );
        indexes
    }

    #[test]
    fn cjk_fallback_shapes_and_draws_collection_faces() {
        let mut context = isolated();
        let registered = context.collection.register_fonts(
            include_bytes!("../tests/fonts/cjk-subset.ttc")
                .as_slice()
                .to_vec()
                .into(),
            Some(FontInfoOverride {
                family_name: Some("Hiragino Sans"),
                ..Default::default()
            }),
        );
        // Host aliases exercise the production candidate list, not Apple fonts.
        context.collection.register_fonts(
            include_bytes!("../tests/fonts/cjk-subset.ttc")
                .as_slice()
                .to_vec()
                .into(),
            Some(FontInfoOverride {
                family_name: Some("Apple SD Gothic Neo"),
                ..Default::default()
            }),
        );
        assert_eq!(registered.len(), 1);
        assert_eq!(registered[0].1.len(), 2);
        for bytes in [
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf")
                .as_slice(),
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf").as_slice(),
        ] {
            context
                .collection
                .register_fonts(bytes.to_vec().into(), None);
        }
        // Reproduce an empty Han fallback even with a usable font discovered.
        assert_eq!(
            context
                .collection
                .fallback_families(Script::from_bytes(*b"Hani"))
                .count(),
            0
        );
        let before = crate::scene::shape(
            "革命道中",
            &mut context,
            &mut parley::LayoutContext::new(),
            32.0,
            40.0,
            400.0,
            "'SF Pro Display', sans-serif",
            &[],
            0.0,
        );
        assert!(
            before
                .lines()
                .flat_map(|l| l.runs())
                .flat_map(|r| r.visual_clusters())
                .flat_map(|c| c.glyphs())
                .any(|g| g.id == 0),
            "baseline must reproduce tofu"
        );
        // An existing first family can lack Han coverage. It must stay first,
        // and Parley must still reach the supplementary family for that cluster.
        let primary = context.collection.family_id("SF Pro Display").unwrap();
        let han = Script::from_bytes(*b"Hani");
        context.collection.set_fallbacks(han, [primary].into_iter());
        configure(&mut context);
        let once: Vec<_> = context.collection.fallback_families(han).collect();
        assert_eq!(once.len(), 3);
        assert_eq!(once[0], primary);
        configure(&mut context);
        assert_eq!(
            once,
            context
                .collection
                .fallback_families(han)
                .collect::<Vec<_>>()
        );
        for weight in [400.0, 700.0] {
            for text in ["革命道中君夢中愛", "汉语爱漢語愛", "한국어"] {
                let indexes = assert_shaped_outlines(&mut context, text, weight);
                assert!(indexes.iter().all(|&i| i == u32::from(weight == 700.0)));
            }
        }
    }

    #[test]
    fn absent_candidates_preserve_existing_fallbacks() {
        let mut context = isolated();
        context.collection.register_fonts(
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf")
                .as_slice()
                .to_vec()
                .into(),
            None,
        );
        let key = Script::from_bytes(*b"Hani");
        extend(&mut context, key.into(), ["Absent"].into_iter());
        assert_eq!(context.collection.fallback_families(key).count(), 0);
        configure(&mut context);
        assert_eq!(context.collection.fallback_families(key).count(), 0);
    }

    #[test]
    fn nonzero_cmap_is_insufficient_without_drawable_outlines() {
        use skrifa::MetadataProvider;
        for tag in [*b"TEST", *b"hvgl"] {
            let mut bytes = include_bytes!("../tests/fonts/cjk-subset.ttc").to_vec();
            // Synthetic unsupported faces: leave the real CJK cmap intact and
            // hide CFF outlines. The hvgl case also exercises Fontique's gate.
            for index in 0..2 {
                let start = 12 + index * 4;
                let base = u32::from_be_bytes(bytes[start..start + 4].try_into().unwrap()) as usize;
                let count =
                    u16::from_be_bytes(bytes[base + 4..base + 6].try_into().unwrap()) as usize;
                let table = (0..count)
                    .map(|i| base + 12 + i * 16)
                    .find(|&i| &bytes[i..i + 4] == b"CFF ")
                    .unwrap();
                bytes[table..table + 4].copy_from_slice(&tag);
                // SFNT directory lookup requires tags in sorted order.
                let directory = &mut bytes[base + 12..base + 12 + count * 16];
                let mut records: Vec<_> = directory.chunks_exact(16).map(<[u8]>::to_vec).collect();
                records.sort_by(|a, b| a[..4].cmp(&b[..4]));
                for (slot, record) in directory.chunks_exact_mut(16).zip(records) {
                    slot.copy_from_slice(&record);
                }
            }
            let font = FontRef::from_index(&bytes, 1).unwrap();
            let glyph = font.charmap().map('漢').unwrap();
            assert_ne!(glyph.to_u32(), 0);
            assert!(!drawable(&font, glyph, &[]));
            if tag == *b"hvgl" {
                assert!(
                    isolated()
                        .collection
                        .register_fonts(bytes.into(), None)
                        .is_empty()
                );
            }
        }
    }

    // This is deliberately target-only and uses real CoreText discovery, not
    // the Noto fixture. Run via an iOS test runner on the device under review.
    #[cfg(target_os = "ios")]
    #[test]
    fn ios_system_fallback_shapes_drawable_cjk() {
        let mut fonts = crate::typography::Fonts::default();
        fonts
            .register(
                include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"),
                include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"),
            )
            .unwrap();
        for weight in [400.0, 700.0] {
            // Chinese is intentionally required here: failures expose an
            // installation/coverage limit rather than silently skipping it.
            for text in ["革命道中君夢中愛", "汉语爱漢語愛", "한국어"] {
                assert_shaped_outlines(&mut fonts.context, text, weight);
            }
        }
    }
}
