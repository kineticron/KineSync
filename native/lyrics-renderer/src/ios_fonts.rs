//! Supplement CoreText's single-family fallback with drawable iOS families,
//! including a bundled full Noto Sans CJK SC fallback registered by the shim.
use parley::{FontContext, fontique::FallbackKey};

// Fontique already discovers these through CoreText URLs, including TTC indexes.
// Names are candidates, never promises that downloadable fonts are installed.
// This list alone is not proof that the reporting device can draw the song.
const JAPANESE: &[&str] = &["Hiragino Sans", "Hiragino Kaku Gothic ProN"];
// Simplified-only Han (for example 摆 U+6446, 长 U+957F, 揽 U+63FD, 诚 U+8BDA
// and 钱 U+94B1) is absent from the Japanese faces above. PingFang is hvgl,
// which Fontique intentionally excludes because Skrifa cannot draw it. The
// remaining names are bundled Noto plus Chinese candidates listed by Apple.
// Whether a family is installed and drawable is decided at runtime by CoreText
// and Fontique, not by this list. They stay after the Japanese faces so Japanese clusters keep
// Japanese forms, and after the platform list so an existing CoreText choice
// still wins.
const CHINESE: &[&str] = &[
    // Bundled full Noto Sans CJK SC Regular and Bold. Swift registers both
    // process scoped before kr_create so Fontique discovers them here.
    "Noto Sans CJK SC",
    "Hiragino Sans GB",
    "Hiragino Sans CNS",
    "PingFang SC",
    "PingFang TC",
    "PingFang HK",
    "Heiti SC",
    "Heiti TC",
    "Songti SC",
    "Songti TC",
    "Kaiti SC",
    "Kaiti TC",
    "Yuanti SC",
    "Yuanti TC",
    "Lantinghei SC",
    "Lantinghei TC",
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
    use skrifa::{FontRef, MetadataProvider, string::StringId};

    // Sanitized unique CJK, Hangul and kana from every syllable in the reported
    // Spicy payload. The song contains no Extension B codepoints.
    const SONG_MAIN: &str = "一万三上下不东丢两为之乐九了事些交人从仔仙们价会你佬供做先八六兴冠几出切利到勤包北千升南即友可台右合吉后吗哼啊喜嗯四回因多大天太奖好如妈宗家对小少尾左应开张彩情意憋我手才找把拜挂接摆摸收散斋方旨旺明易是朋条来标桌欢步气水河海清滚灯炉点牌物玉白百的皇盲直码示社祥程等紫结给聊聚胆能脖艺花若莫菜蕹虔表袖西诚说谓财运这道那酬里钱长阳阴难非面顶顺颁风馈香高鹏黄黑";
    const SONG_BACKGROUND: &str =
        "揽佬가공그까꾸꿈나는니떤레록리멍무봐상시아앉어얼에요을이일종집토하할";

    #[test]
    fn actual_song_corpus_is_bmp_and_exercises_simplified_only_han() {
        let all = || SONG_MAIN.chars().chain(SONG_BACKGROUND.chars());
        assert!(all().all(|ch| ch as u32 <= 0xFFFF));
        // These are the reported tofu characters and their neighbors. They are
        // Simplified forms, not the traditional or Japanese forms in Hiragino.
        for ch in ['摆', '长', '揽', '诚', '钱'] {
            assert!(all().any(|value| value == ch));
        }
        assert!(
            SONG_BACKGROUND
                .chars()
                .any(|ch| ('\u{AC00}'..='\u{D7A3}').contains(&ch))
        );
    }

    #[test]
    fn chinese_outline_candidates_follow_japanese_and_are_deduplicated() {
        assert!(CHINESE.contains(&"Songti SC"));
        assert!(CHINESE.contains(&"Hiragino Sans GB"));
        // Japanese faces must stay ahead of Chinese faces so Japanese clusters
        // keep Japanese glyph forms when both families cover them.
        assert!(JAPANESE.iter().all(|name| !CHINESE.contains(name)));
        for names in [JAPANESE, CHINESE, KOREAN] {
            let mut sorted = names.to_vec();
            sorted.sort_unstable();
            let count = sorted.len();
            sorted.dedup();
            assert_eq!(sorted.len(), count, "duplicate candidate in {names:?}");
        }
    }

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
                // Parley and Skrifa use distinct F2Dot14 coordinate types.
                // Preserve the run's exact bits, including variable axis values.
                let coords: Vec<_> = run
                    .normalized_coords()
                    .iter()
                    .map(|coord| skrifa::instance::NormalizedCoord::from_bits(coord.to_bits()))
                    .collect();
                indexes.push(data.index);
                for cluster in run.visual_clusters() {
                    for glyph in cluster.glyphs() {
                        assert!(
                            drawable(&font, skrifa::GlyphId::new(glyph.id), &coords),
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

    /// Embedded family, subfamily, fixture-byte identity and face index for
    /// every shaped run. The aliased fixture keeps its embedded test name, so
    /// preference checks must compare the selected bytes or index as well.
    fn shaped_face_names(
        context: &mut FontContext,
        text: &str,
        weight: f32,
    ) -> Vec<(String, String, bool, u32)> {
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
        let fixture = include_bytes!("../tests/fonts/cjk-subset.ttc").as_slice();
        let mut faces = Vec::new();
        for line in layout.lines() {
            for run in line.runs() {
                let data = run.font();
                let font = FontRef::from_index(data.data.as_ref(), data.index).unwrap();
                let name = |id| {
                    font.localized_strings(id)
                        .english_or_first()
                        .map(|s| s.to_string())
                        .unwrap_or_default()
                };
                faces.push((
                    name(StringId::FAMILY_NAME),
                    name(StringId::SUBFAMILY_NAME),
                    data.data.as_ref() == fixture,
                    data.index,
                ));
            }
        }
        faces
    }

    fn register_sf_pro(context: &mut FontContext) {
        for bytes in [
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf")
                .as_slice(),
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf").as_slice(),
        ] {
            context
                .collection
                .register_fonts(bytes.to_vec().into(), None);
        }
    }

    #[test]
    fn bundled_noto_sc_draws_actual_song_and_keeps_jp_kr_preferred() {
        let mut context = isolated();
        // Alias the test collection to the production Japanese and Korean
        // candidates. These faces intentionally lack Simplified-only Han.
        for family in ["Hiragino Sans", "Apple SD Gothic Neo"] {
            context.collection.register_fonts(
                include_bytes!("../tests/fonts/cjk-subset.ttc")
                    .as_slice()
                    .to_vec()
                    .into(),
                Some(FontInfoOverride {
                    family_name: Some(family),
                    ..Default::default()
                }),
            );
        }
        register_sf_pro(&mut context);
        for style in ["Regular", "Bold"] {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../ExpoLyrics/modules/kinesync-rust-lyrics/ios/Fonts/NotoSansCJKsc-",
            );
            let bytes = std::fs::read(format!("{path}{style}.otf"))
                .expect("bundled Noto Sans CJK SC face is checked in");
            assert!(
                !context
                    .collection
                    .register_fonts(bytes.into(), None)
                    .is_empty(),
                "bundled {style} face must register"
            );
        }
        let primary = context.collection.family_id("SF Pro Display").unwrap();
        let han = Script::from_bytes(*b"Hani");
        context.collection.set_fallbacks(han, [primary].into_iter());
        configure(&mut context);
        for weight in [400.0, 700.0] {
            let simplified = shaped_face_names(&mut context, "摆长揽诚钱", weight);
            assert!(
                simplified
                    .iter()
                    .any(|(family, _, _, _)| family == "Noto Sans CJK SC"),
                "Simplified-only Han must reach bundled Noto at {weight}: {simplified:?}"
            );
            if weight == 700.0 {
                assert!(
                    simplified.iter().any(|(family, style, _, _)| {
                        family == "Noto Sans CJK SC" && style == "Bold"
                    }),
                    "weight 700 must use the bundled Noto Bold face: {simplified:?}"
                );
            }
            assert_shaped_outlines(&mut context, SONG_MAIN, weight);
            assert_shaped_outlines(&mut context, SONG_BACKGROUND, weight);
            // Japanese and Korean must stay on the earlier preferred families.
            let japanese = shaped_face_names(&mut context, "革命道中君夢中愛", weight);
            assert!(
                japanese
                    .iter()
                    .all(|(_, _, fixture, index)| *fixture && *index <= 1),
                "Japanese must stay on the earlier fixture faces: {japanese:?}"
            );
            let korean = shaped_face_names(&mut context, "한국어", weight);
            assert!(
                korean
                    .iter()
                    .all(|(_, _, fixture, index)| *fixture && *index <= 1),
                "Korean must stay on the earlier fixture faces: {korean:?}"
            );
        }
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
            // The reported song corpus is split into its main and intended
            // Korean plus Chinese background voices. Both must draw every
            // glyph at the actual Spicy weights.
            for text in [
                "革命道中君夢中愛",
                "汉语爱漢語愛",
                "한국어",
                SONG_MAIN,
                SONG_BACKGROUND,
            ] {
                assert_shaped_outlines(&mut fonts.context, text, weight);
            }
        }
    }
}
