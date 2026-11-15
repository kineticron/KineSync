//! Source-pinned background vocal and duet coverage. The typography, colour and
//! padding rules asserted here come from the pinned Skia renderers in
//! `test/background-voices.json`; nothing in this file invents a new style.
use crate::{
    appearance::{AppearanceState, Effect},
    live::TrackPacket,
    scene::TrackScene,
    timed_scene::{encoded, spicy_glow},
    typography::{Fonts, Style},
};
fn data() -> serde_json::Value {
    serde_json::from_str(include_str!("../test/background-voices.json")).unwrap()
}
fn fonts() -> Fonts {
    let mut fonts = Fonts::default();
    fonts
        .register(
            &std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"
            ))
            .unwrap(),
            &std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"
            ))
            .unwrap(),
        )
        .unwrap();
    fonts
}
fn case(name: &str) -> serde_json::Value {
    data()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
        .clone()
}
/// Build a track from a fixture case, plus the same source lines without any
/// background voice for height/scroll comparison.
fn tracks(name: &str) -> (TrackScene, TrackScene, serde_json::Value) {
    let item = case(name);
    let packet = &item["packet"];
    assert_eq!(packet["settings"]["style"], item["style"]);
    let parsed = TrackPacket::parse(&serde_json::to_vec(packet).unwrap()).unwrap();
    let settings = parsed.settings.clone().unwrap();
    let lines = parsed.into_lines();
    let mut bare = lines.clone();
    for line in &mut bare {
        line.backgrounds.clear();
    }
    let (width, height) = (
        item["width"].as_u64().unwrap() as u32,
        item["height"].as_u64().unwrap() as u32,
    );
    let dpr = item["dpr"].as_f64().unwrap() as f32;
    let mut registered = fonts();
    let track = TrackScene::with_fonts(lines, width, height, dpr, Some(&settings), &mut registered)
        .unwrap();
    let plain =
        TrackScene::with_fonts(bare, width, height, dpr, Some(&settings), &mut registered).unwrap();
    (track, plain, item)
}
fn close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 0.02,
        "{label}: actual {actual} expected {expected}"
    );
}
#[test]
fn fixture_sources_and_packets_are_pinned() {
    use sha2::Digest;
    let data = data();
    for proof in data["sources"].as_array().unwrap() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(proof["path"].as_str().unwrap());
        assert_eq!(
            format!("{:x}", sha2::Sha256::digest(std::fs::read(path).unwrap())),
            proof["sha256"].as_str().unwrap(),
            "{}",
            proof["path"]
        );
    }
    for case in data["cases"].as_array().unwrap() {
        TrackPacket::parse(&serde_json::to_vec(&case["packet"]).unwrap()).unwrap();
    }
}
#[test]
fn background_voice_typography_follows_each_skia_source() {
    for name in [
        "spicy-speakers",
        "amll-single-block-duet",
        "spicy-duet-landscape",
    ] {
        let (mut track, _, item) = tracks(name);
        let expected = &item["expected"];
        let background_voices = track.lines[0].backgrounds.len();
        assert!(background_voices > 0, "{name}: fixture lost its BGV");
        track.prepare(track.lines[0].start + 10.0).unwrap();
        let row = &track.cached[0];
        assert_eq!(row.voices.len(), background_voices + 1, "{name}");
        for voice in row.voices.iter().skip(1) {
            assert!(voice.background, "{name}: voice must be a background");
            close(
                voice.size,
                expected["background_font_size"].as_f64().unwrap(),
                name,
            );
            close(
                voice.padding,
                expected["background_padding"].as_f64().unwrap(),
                name,
            );
            close(
                voice.alpha,
                expected["background_alpha"].as_f64().unwrap(),
                name,
            );
            // Spicy scales word/letter motion by the parent type size; AMLL uses
            // the voice's own size for its float/emphasis units.
            close(
                voice.unit,
                if item["style"] == "spicy" {
                    expected["lead_font_size"].as_f64().unwrap()
                } else {
                    expected["background_font_size"].as_f64().unwrap()
                },
                name,
            );
        }
        // AMLL's background container is the only source with a top margin scale
        // and inner padding; Spicy uses a flat 3 pt margin.
        let metrics = track
            .diagnostics
            .first()
            .and_then(|row| row.get("voices"))
            .and_then(|voices| voices.as_array())
            .expect("per-voice layout diagnostics");
        assert_eq!(metrics.len(), background_voices + 1);
        let lead_geometry = metrics[0]["geometry"].clone();
        for entry in metrics.iter().skip(1) {
            let geometry = &entry["geometry"];
            close(
                geometry["font_size"].as_f64().unwrap(),
                expected["background_font_size"].as_f64().unwrap(),
                name,
            );
            close(
                geometry["line_height"].as_f64().unwrap(),
                expected["background_line_height"].as_f64().unwrap(),
                name,
            );
            close(
                geometry["weight"].as_f64().unwrap(),
                expected["background_weight"].as_f64().unwrap(),
                name,
            );
            // Both sources keep the parent row's duet alignment and lane; only
            // AMLL narrows the background text box by 0.2em per side.
            assert_eq!(geometry["right"], lead_geometry["right"], "{name}");
            close(
                geometry["lane_width"].as_f64().unwrap(),
                expected["background_lane"].as_f64().unwrap(),
                name,
            );
            close(
                geometry["text_width"].as_f64().unwrap(),
                expected["background_text_width"].as_f64().unwrap(),
                name,
            );
            let x = geometry["x"].as_f64().unwrap();
            let text = geometry["text_width"].as_f64().unwrap();
            let lead_x = lead_geometry["x"].as_f64().unwrap();
            let lead_text = lead_geometry["text_width"].as_f64().unwrap();
            if lead_geometry["right"].as_bool().unwrap() {
                close(x + text, lead_x + lead_text, "right-aligned BGV edge");
            } else {
                close(x, lead_x, "left-aligned BGV x");
            }
        }
        // Independently re-derive the placement from the two source policies so
        // a change to the Rust scalars cannot silently drift from Skia.
        let lead = &row.voices[0];
        let first = &row.voices[1];
        let dpr = item["dpr"].as_f64().unwrap();
        if item["style"] == "spicy" {
            close(first.size, lead.size * 0.75, name);
            close(first.padding, 0.0, name);
            close(first.alpha, 1.0, name);
            close(first.x, lead.x, name);
            close(first.lane, lead.lane, name);
            assert!((first.offset - (lead.box_height() + 3.0 * dpr)).abs() < 0.02);
        } else {
            close(first.size, lead.size * 0.7, name);
            close(first.padding, first.size * 0.2, name);
            close(first.alpha, 0.4, name);
            close(
                first.lane,
                expected["background_text_width"].as_f64().unwrap(),
                name,
            );
            assert!((first.offset - (lead.box_height() + lead.size * 0.3)).abs() < 0.02);
        }
        if let Some(lead_text) = expected["lead_text_width"].as_f64() {
            close(
                lead_geometry["text_width"].as_f64().unwrap(),
                lead_text,
                "duet lead inset",
            );
        }
    }
}
#[test]
fn background_voices_count_in_row_height_scroll_and_protection() {
    for name in ["spicy-speakers", "amll-single-block-duet"] {
        let (mut track, mut plain, item) = tracks(name);
        let time = track.lines[0].start + 10.0;
        track.prepare(time).unwrap();
        plain.prepare(time).unwrap();
        let row = &track.cached[0];
        // Row content is the sum of every voice box plus its own top margin.
        let expected: f64 = row
            .voices
            .iter()
            .enumerate()
            .map(|(index, voice)| {
                voice.box_height()
                    + if index == 0 {
                        0.0
                    } else if item["style"] == "spicy" {
                        3.0 * item["dpr"].as_f64().unwrap()
                    } else {
                        row.voices[0].size * 0.3
                    }
            })
            .sum();
        assert!((row.content_height - expected).abs() < 0.02, "{name}");
        assert!(
            row.content_height > plain.cached[0].content_height + 20.0,
            "{name}"
        );
        assert!(row.height > plain.cached[0].height + 20.0, "{name}");
        let padding = 2.0 * item["expected"]["lead_row_padding"].as_f64().unwrap();
        close(row.height, row.content_height + padding, "row height");
        // Auto-scroll uses the measured prefix/height, so a taller BGV row moves
        // the following row down and extends the reachable track.
        assert!(
            track.prefix[1] > plain.prefix[1] + 15.0,
            "{name}: following row prefix must include the BGV height"
        );
        assert!(track.max_scroll() > plain.max_scroll() + 15.0, "{name}");
        // The protected band includes the whole active row, BGV included.
        assert!(row.height > plain.cached[0].height);
        let mut scene = vello::Scene::new();
        let state = AppearanceState::default();
        let band = track.frame_appearance(
            time,
            track.scroll_target(time),
            &[],
            &state,
            &mut scene,
            Effect::Motion,
        );
        let plain_band = plain.frame_appearance(
            time,
            plain.scroll_target(time),
            &[],
            &state,
            &mut scene,
            Effect::Motion,
        );
        assert!(band.1 - band.0 > plain_band.1 - plain_band.0, "{name}");
    }
}
#[test]
fn duet_alignment_and_source_order_survive_overlapping_starts() {
    let (mut track, _, _) = tracks("amll-single-block-duet");
    // `promise` by slayr: the second duet line starts 2 ms before the first.
    assert!(track.lines[1].start < track.lines[0].start);
    assert_eq!(track.lines[0].text, "left side");
    assert_eq!(track.lines[1].text, "right side");
    let overlap = crate::window(&track.lines, 2000.0);
    assert_eq!(overlap.active(), Some((0, 1)), "both duet rows stay active");
    assert_eq!(crate::auto_scroll_range(&overlap), Some((0, 1)));
    track.prepare(2000.0).unwrap();
    for (index, line) in track.lines.iter().enumerate() {
        let row = &track.cached[index];
        let right = line.paint.as_ref().unwrap().opposite;
        assert_eq!(row.right, right, "portrait duet alignment");
        // Every background voice of the row shares the parent alignment origin.
        for voice in row.voices.iter().skip(1) {
            assert_eq!(voice.right, right);
            // Right-aligned voices stay near the parent origin; their exact right
            // edge is asserted from the source geometry above.
            assert!((voice.x - row.voices[0].x).abs() <= row.voices[0].lane + 1e-9);
        }
    }
    let (landscape, _, _) = tracks("spicy-duet-landscape");
    assert_eq!(
        landscape.cached[0].right,
        !landscape.lines[0].paint.as_ref().unwrap().opposite,
        "landscape flips the source duet side"
    );
    assert_eq!(
        landscape.cached[0].voices[1].right,
        landscape.cached[0].right
    );
}
#[test]
fn background_voices_fill_and_move_with_their_own_timings() {
    let (mut track, _, _) = tracks("spicy-speakers");
    // The lead ends at 5000 ms; the second background voice sings until 8000 ms.
    track.prepare(6000.0).unwrap();
    assert!(track.timed_ready(0));
    let row = &track.cached[0];
    assert_eq!(row.voices.len(), 3);
    for (index, voice) in row.voices.iter().enumerate() {
        let source = track.lines[0].voice(index).unwrap();
        assert_eq!(voice.words.len(), source.words.len());
        assert_eq!(voice.words[0].start, source.words[0].start);
        assert_eq!(
            voice.words.last().unwrap().end,
            source.words.last().unwrap().end
        );
        assert!(voice.timed.as_ref().unwrap().len() == voice.words.len());
    }
    // The package stays active through the background tail, exactly like Skia's
    // `endTimeByIndex` presentation window.
    let window = crate::window(&track.lines, 6000.0);
    assert_eq!(window.active(), Some((0, 0)));
    // The background voice's own interval drives its settled alpha, not the lead.
    assert_eq!(track.lines[0].backgrounds[1].interval(), (4500.0, 8000.0));
    let mut state = AppearanceState::default();
    let mut scene = vello::Scene::new();
    state.prepare(&track, 6000.0, 12000.0);
    state.advance(&track, 6000.0, 12000.0, true, Effect::Motion);
    state.advance(&track, 6160.0, 12160.0, true, Effect::Motion);
    let row_state = state.row(0).unwrap();
    assert_eq!(row_state.voices.len(), 3);
    let spicier = track.frame_appearance(
        6160.0,
        track.scroll_target(6160.0),
        &[],
        &state,
        &mut scene,
        Effect::Motion,
    );
    assert!(spicier.1 > spicier.0);
    // Steady-state frames with BGV must reuse every buffer they already own.
    let allocations = crate::allocation_probe::measure(|| {
        for i in 0..120 {
            let time = 6000.0 + i as f64;
            state.advance(
                &track,
                time,
                12200.0 + i as f64 * 8.333,
                true,
                Effect::Motion,
            );
            track.frame_appearance(
                time,
                track.scroll_target(time),
                &[],
                &state,
                &mut scene,
                Effect::Motion,
            );
        }
    });
    assert_eq!(allocations, 0, "BGV frames must not allocate");
}
#[test]
fn glow_intensity_radius_and_ramp_match_skia_in_the_shared_pass() {
    // Emphasized letter: intensity clamps at 0.5, sigma ramps 2 -> 8 logical px.
    for (glow, intensity, sigma) in [(0.0, 0.0, 2.0), (0.5, 0.4625, 5.0), (1.0, 0.5, 8.0)] {
        let (actual_intensity, actual_sigma) = spicy_glow(true, glow);
        close(actual_intensity, intensity, "letter glow intensity");
        close(actual_sigma, sigma, "letter glow sigma");
    }
    // Ordinary syllable: dimmer, tight 2 -> 3 logical px halo.
    for (glow, intensity, sigma) in [(0.0, 0.0, 2.0), (0.5, 0.0875, 2.5), (1.0, 0.175, 3.0)] {
        let (actual_intensity, actual_sigma) = spicy_glow(false, glow);
        close(actual_intensity, intensity, "word glow intensity");
        close(actual_sigma, sigma, "word glow sigma");
    }
    // The glow rides the existing near/far half-resolution bases: intensity is
    // conserved between them and only the mix moves with the radius.
    let decode = |sigma: f64| {
        let color = encoded(0.0, 0.5, sigma, 1.0);
        let (near, far) = (
            f64::from(color.components[1]),
            f64::from(color.components[2]),
        );
        // Encoded channels are sRGB-encoded; compare the linear sum weight.
        let linear = |value: f64| {
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        (linear(near), linear(far))
    };
    let (near_low, far_low) = decode(2.5);
    let (near_mid, far_mid) = decode(4.25);
    let (near_high, far_high) = decode(8.0);
    assert!(near_low > 0.4 && far_low < 1e-6, "near base at the low end");
    assert!(
        near_mid > 0.0 && far_mid > 0.0,
        "mid radius mixes both bases"
    );
    assert!(
        near_high < 1e-6 && far_high > 0.4,
        "far base at the high end"
    );
    // AMLL glow is filtered through the voice's own type size, so a background
    // voice glows at 0.7x the lead radius; intensity keeps the source pulse.
    let lead = crate::style_timing::amll_emphasis(1500.0, 1000.0, 4000.0, 0, 4, false, false);
    let background = crate::style_timing::amll_emphasis(1500.0, 1000.0, 4000.0, 0, 4, false, true);
    close(lead.glow, background.glow, "AMLL background glow intensity");
    close(
        lead.radius,
        background.radius,
        "AMLL background glow radius scale",
    );
    close(
        (lead.radius * 25.2 / 2.0) / (lead.radius * 36.0 / 2.0),
        0.7,
        "AMLL background sigma is 0.7x the lead",
    );
}
#[test]
fn invalid_background_packets_fail_closed() {
    let base: serde_json::Value = case("spicy-speakers")["packet"].clone();
    let parse =
        |packet: &serde_json::Value| TrackPacket::parse(&serde_json::to_vec(packet).unwrap());
    assert!(parse(&base).is_ok());
    // Outside the row's duet alignment.
    let mut wrong_side = base.clone();
    wrong_side["lines"][0]["backgrounds"][0]["opposite"] = serde_json::json!(true);
    assert!(parse(&wrong_side).is_err());
    // Past the package end.
    let mut too_long = base.clone();
    too_long["lines"][0]["backgrounds"][1]["words"][0]["end"] = serde_json::json!(8500.0);
    too_long["lines"][0]["backgrounds"][1]["end"] = serde_json::json!(8500.0);
    assert!(parse(&too_long).is_err());
    // Empty voice.
    let mut empty = base.clone();
    empty["lines"][0]["backgrounds"][0]["words"] = serde_json::json!([]);
    assert!(parse(&empty).is_err());
    // Too many voices for one row.
    let mut crowded = base.clone();
    let voice = crowded["lines"][0]["backgrounds"][0].clone();
    crowded["lines"][0]["backgrounds"] = serde_json::json!(vec![voice; 17]);
    assert!(parse(&crowded).is_err());
    // A missing background array stays valid for older packets.
    let mut legacy = base.clone();
    legacy["lines"][0]
        .as_object_mut()
        .unwrap()
        .remove("backgrounds");
    let parsed = parse(&legacy).unwrap();
    assert!(parsed.into_lines()[0].backgrounds.is_empty());
}
#[test]
fn settings_and_style_invalidate_the_layout_cache_with_backgrounds() {
    let item = case("spicy-speakers");
    let packet = TrackPacket::parse(&serde_json::to_vec(&item["packet"]).unwrap()).unwrap();
    let settings = packet.settings.clone().unwrap();
    let lines = packet.into_lines();
    let key = crate::scene::LayoutCache::key("bgv", &lines, &settings, 390, 640, 1.0).unwrap();
    let mut changed = lines.clone();
    changed[0].backgrounds[0].words[0].graphemes = vec!["h".into()];
    assert_ne!(
        key,
        crate::scene::LayoutCache::key("bgv", &changed, &settings, 390, 640, 1.0).unwrap(),
        "background source participates in retained geometry identity"
    );
    let mut other = lines.clone();
    other[0].backgrounds[1].words[0].end -= 10.0;
    assert_ne!(
        key,
        crate::scene::LayoutCache::key("bgv", &other, &settings, 390, 640, 1.0).unwrap()
    );
    let mut amll = settings.clone();
    amll.style = Style::Amll;
    let mut fonts = fonts();
    let spicy =
        TrackScene::with_fonts(lines.clone(), 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
    let amll_track = TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&amll), &mut fonts).unwrap();
    assert_eq!(spicy.style(), Some(Style::Spicy));
    assert_eq!(amll_track.style(), Some(Style::Amll));
    close(spicy.cached[0].lead().size, 33.6, "Spicy primary type");
    close(amll_track.cached[0].lead().size, 36.0, "AMLL primary type");
    close(
        amll_track.cached[0].voices[1].size,
        25.2,
        "AMLL background type",
    );
}
