//! Host-only cold preparation probe. No GPU, frame-rate or phone claims.
use crate::{allocation_probe, live::TrackPacket, scene::TrackScene, typography::Fonts};
use std::time::Instant;

#[test]
#[ignore = "cold preparation time/heap probe; run serially in release"]
fn cold_spicy_overscan_and_seek_profile() {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("../test/appearance-track.json")).unwrap();
    let packet = data["packets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["fixture_line"] == 11 && p["style"] == "spicy" && p["landscape"] == false)
        .unwrap();
    let source = TrackPacket::parse(&serde_json::to_vec(&packet["packet"]).unwrap()).unwrap();
    let settings = source.settings.clone().unwrap();
    let line = source.into_lines().remove(0);
    let period = line.background_end - line.start + 1000.0;
    let lines: Vec<_> = (0..200)
        .map(|i| {
            let mut next = line.clone();
            let delta = i as f64 * period - line.start;
            next.start += delta;
            next.end += delta;
            next.background_end += delta;
            for atom in &mut next.atoms {
                atom.start += delta;
                atom.end += delta;
            }
            for voice in next.paint.iter_mut().chain(next.backgrounds.iter_mut()) {
                voice.start += delta;
                voice.end += delta;
                for word in &mut voice.words {
                    word.start += delta;
                    word.end += delta;
                    if let Some(group) = word.appearance.as_mut().and_then(|a| a.emphasis.as_mut())
                    {
                        group.start += delta;
                        group.end += delta;
                    }
                }
            }
            next
        })
        .collect();
    let mut reports = Vec::new();
    for sample in 0..10 {
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
        let mut owner = None;
        for (name, time) in [
            ("construct", 0.0),
            ("cold_prepare", 500.0),
            ("cold_viewport_100", -1.0),
            ("playback_seek_100", period * 100.0 + 500.0),
            ("seek_back_0", 500.0),
        ] {
            let start = Instant::now();
            let heap = allocation_probe::profile(|| {
                if name == "construct" {
                    owner = Some(
                        TrackScene::with_fonts(
                            lines.clone(),
                            390,
                            640,
                            1.0,
                            Some(&settings),
                            &mut fonts,
                        )
                        .unwrap(),
                    );
                } else {
                    let track = owner.as_mut().unwrap();
                    if time < 0.0 {
                        track.prepare_viewport(track.row_top(100)).unwrap();
                    } else {
                        track.prepare(time).unwrap();
                    }
                }
            });
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let track = owner.as_ref().unwrap();
            reports.push(serde_json::json!({"sample":sample,"operation":name,"elapsed_ms":elapsed_ms,"heap":heap,
                "plain_preparations":track.plain_preparations,"detailed_preparations":track.detailed_preparations,
                "resident_layout_rows":track.cached.iter().filter(|r| r.layout_ready()).count()}));
        }
    }
    let path = std::env::var("RUST_COLD_REPORT")
        .unwrap_or_else(|_| "/tmp/rust-cold-preparation.json".into());
    std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({"scope":"Linux host CPU, 200 copies of actual Spicy fixture 11; fresh font context each sample; input parsing/font registration excluded; construct includes input clone; heap delta is thread-local requested bytes (not RSS); realloc counts as one request; negative deltas include retirement of prior buffers; no phone claim", "build":if cfg!(debug_assertions) {"debug"} else {"release"},"samples":reports})).unwrap()).unwrap();
}
