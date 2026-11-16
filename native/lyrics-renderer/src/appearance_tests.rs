use crate::{
    appearance::{AppearanceState, Effect},
    gpu::Gpu,
    live::TrackPacket,
    scene::TrackScene,
    typography::{Fonts, Style},
};
use std::time::Instant;
fn inputs() -> serde_json::Value {
    serde_json::from_str(include_str!("../test/appearance-track.json")).unwrap()
}
fn track(index: u64, style: Style, landscape: bool) -> (TrackScene, f64) {
    let data = inputs();
    let item = data["packets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| {
            p["fixture_line"] == index
                && p["style"]
                    == if style == Style::Spicy {
                        "spicy"
                    } else {
                        "amll"
                    }
                && p["landscape"] == landscape
        })
        .unwrap();
    let packet = TrackPacket::parse(&serde_json::to_vec(&item["packet"]).unwrap()).unwrap();
    let settings = packet.settings.clone().unwrap();
    let lines = packet.into_lines();
    let voice = lines[0].paint.as_ref().unwrap();
    let word = voice
        .words
        .iter()
        .max_by(|a, b| (a.end - a.start).total_cmp(&(b.end - b.start)))
        .unwrap();
    let time = word.start
        + (word.end
            - word.start
            - if word.appearance.as_ref().unwrap().emphasized {
                250.0
            } else {
                0.0
            })
            * 0.45;
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
    let (w, h) = if landscape { (844, 390) } else { (390, 640) };
    (
        TrackScene::with_fonts(lines, w, h, 1.0, Some(&settings), &mut fonts).unwrap(),
        time,
    )
}
fn frame(
    track: &mut TrackScene,
    state: &mut AppearanceState,
    time: f64,
    wall: f64,
    scene: &mut vello::Scene,
    effect: Effect,
) -> (f32, f32) {
    track.prepare(time).unwrap();
    if effect == Effect::Baseline {
        return track.frame_prepared(time, track.scroll_target(time), scene);
    }
    state.prepare(track, time, wall);
    state.advance(track, time, wall, true, effect);
    track.frame_appearance(time, track.scroll_target(time), &[], state, scene, effect)
}
fn render(
    gpu: &mut Gpu,
    scene: &vello::Scene,
    band: (f32, f32),
    effect: Effect,
) -> crate::gpu::FrameStats {
    if effect == Effect::Baseline {
        gpu.render(scene, band, true).unwrap()
    } else {
        gpu.render_appearance(scene, band, true, effect.glow())
            .unwrap()
    }
}
#[test]
fn metadata_input_source_graph_and_source_space_group_are_valid() {
    use sha2::Digest;
    let data = inputs();
    assert_eq!(data["packets"].as_array().unwrap().len(), 8);
    for proof in data["sources"].as_array().unwrap() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(proof["path"].as_str().unwrap());
        assert_eq!(
            format!("{:x}", sha2::Sha256::digest(std::fs::read(p).unwrap())),
            proof["sha256"].as_str().unwrap()
        );
    }
    for p in data["packets"].as_array().unwrap() {
        TrackPacket::parse(&serde_json::to_vec(&p["packet"]).unwrap()).unwrap();
    }
    let mut invalid = data["packets"][0]["packet"].clone();
    invalid["schema"] = serde_json::json!(4);
    assert!(TrackPacket::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
    invalid = data["packets"][0]["packet"].clone();
    invalid["lines"][0]["paint"]["words"][0]["appearance"]["origin"] = serde_json::json!(2);
    assert!(TrackPacket::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
}
#[test]
fn mutable_timing_is_separate_pause_release_reset_and_zero_scene_allocations() {
    for style in [Style::Spicy, Style::Amll] {
        let (mut track, time) = track(if style == Style::Amll { 1 } else { 11 }, style, false);
        let mut state = AppearanceState::default();
        let mut scene = vello::Scene::new();
        frame(
            &mut track,
            &mut state,
            time,
            10000.0,
            &mut scene,
            Effect::Glow,
        );
        frame(
            &mut track,
            &mut state,
            time,
            10008.0,
            &mut scene,
            Effect::Glow,
        );
        let count = crate::allocation_probe::measure(|| {
            for i in 0..120 {
                frame(
                    &mut track,
                    &mut state,
                    time,
                    10016.0 + i as f64 * 8.333,
                    &mut scene,
                    Effect::Glow,
                );
            }
        });
        assert_eq!(count, 0, "timed scene must reuse all buffers");
        let position = track.lines[0].end + 1.0;
        track.prepare(position).unwrap();
        state.prepare(&track, position, 12000.0);
        state.advance(&track, position, 12000.0, false, Effect::Glow);
        let before = state.row(0).unwrap().clock.elapsed;
        state.advance(&track, position, 12016.0, false, Effect::Glow);
        assert!(state.row(0).unwrap().clock.elapsed > before);
        let mut fresh = AppearanceState::default();
        fresh.prepare(&track, time, 12000.0);
        assert!(!fresh.row(0).unwrap().clock.active);
        state.reset();
        assert!(state.row(0).is_none());
        assert!(!state.animating());
    }
}
#[test]
#[ignore = "actual GPU glyph readback; run for live appearance proof"]
fn actual_glyph_fill_motion_glow_alpha_proof() {
    let mut reports = Vec::new();
    std::fs::create_dir_all("/files").unwrap();
    for style in [Style::Spicy, Style::Amll] {
        let (mut track, time) = track(if style == Style::Amll { 1 } else { 11 }, style, false);
        let mut state = AppearanceState::default();
        let mut scene = vello::Scene::new();
        let mut gpu = pollster::block_on(Gpu::new(390, 640)).unwrap();
        let mut band = (0.0, 0.0);
        for i in 0..8 {
            band = frame(
                &mut track,
                &mut state,
                time,
                10000.0 + i as f64 * 8.333,
                &mut scene,
                Effect::Glow,
            );
        }
        let filled_band = track.frame_appearance(
            time,
            track.scroll_target(time),
            &[],
            &state,
            &mut scene,
            Effect::Fill,
        );
        gpu.render_appearance(&scene, filled_band, false, false)
            .unwrap();
        let fill = gpu.read_pixels().unwrap();
        track.frame_appearance(
            time,
            track.scroll_target(time),
            &[],
            &state,
            &mut scene,
            Effect::Motion,
        );
        gpu.render_appearance(&scene, band, false, false).unwrap();
        let sharp = gpu.read_pixels().unwrap();
        let motion_changed = fill
            .as_chunks::<4>()
            .0
            .iter()
            .zip(sharp.as_chunks::<4>().0)
            .filter(|(a, b)| a != b)
            .count();
        assert!(
            motion_changed > 0,
            "actual motion must change glyph coverage"
        );
        track.frame_appearance(
            time,
            track.scroll_target(time),
            &[],
            &state,
            &mut scene,
            Effect::Glow,
        );
        gpu.render_appearance(&scene, band, false, true).unwrap();
        let glow = gpu.read_pixels().unwrap();
        let halo = sharp
            .as_chunks::<4>()
            .0
            .iter()
            .zip(glow.as_chunks::<4>().0)
            .filter(|(a, b)| a[3] == 0 && b[3] > 0)
            .count();
        assert!(
            halo > 0,
            "actual glyph glow must extend outside sharp coverage"
        );
        for p in glow.as_chunks::<4>().0 {
            assert!(p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
        }
        assert_eq!(&glow[..4], &[0, 0, 0, 0]);
        let png = format!("/files/rust_parity_live_appearance_{style:?}.png");
        gpu.save(&png).unwrap();
        let next_time = time + 120.0;
        band = frame(
            &mut track,
            &mut state,
            next_time,
            10180.0,
            &mut scene,
            Effect::Motion,
        );
        gpu.render_appearance(&scene, band, false, false).unwrap();
        let next = gpu.read_pixels().unwrap();
        let time_changed = sharp
            .as_chunks::<4>()
            .0
            .iter()
            .zip(next.as_chunks::<4>().0)
            .filter(|(a, b)| a != b)
            .count();
        assert!(time_changed > 0);
        for p in next.as_chunks::<4>().0 {
            assert!(p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
        }
        assert_eq!(&next[..4], &[0, 0, 0, 0]);
        let live_png = format!("/files/rust_parity_live_motion_{style:?}.png");
        gpu.save(&live_png).unwrap();
        let mut replay = AppearanceState::default();
        for i in 0..8 {
            band = frame(
                &mut track,
                &mut replay,
                time,
                10000.0 + i as f64 * 8.333,
                &mut scene,
                Effect::Glow,
            );
        }
        gpu.render_appearance(&scene, band, false, true).unwrap();
        assert_eq!(
            gpu.read_pixels().unwrap(),
            glow,
            "identical timing history must replay exact pixels"
        );
        reports.push(serde_json::json!({"style":style,"time_ms":time,"halo_pixels":halo,"motion_changed_pixels":motion_changed,"time_changed_pixels":time_changed,"selected_faces":track.diagnostics,"prototype_glow_png":png,"live_motion_png":live_png,"premultiplied":true,"identical_history_repeat":true,"scope":"actual production glyphs + shared two-radius glow, no native Skia comparison acceptance"}));
    }
    std::fs::write(
        "/tmp/rust-parity-appearance-proof.json",
        serde_json::to_string_pretty(&reports).unwrap(),
    )
    .unwrap();
}
#[derive(serde::Serialize)]
struct Sample {
    scene_ms: f64,
    encode_ms: f64,
    wall_ms: f64,
    scene_allocations: usize,
    explicit_wait_readback_ms: f64,
    gpu_interval_including_queue_gaps_ms: Option<f64>,
}
fn quantile(samples: &[Sample], f: impl Fn(&Sample) -> f64, p: f64) -> f64 {
    let mut values: Vec<_> = samples.iter().map(f).collect();
    values.sort_by(f64::total_cmp);
    values[((p * values.len() as f64).ceil() as usize).saturating_sub(1)]
}
#[test]
fn live_policy_composites_glow_in_the_shared_half_resolution_pass() {
    use crate::appearance::{Effect, LIVE_EFFECT};
    // The enabled policy keeps motion and turns glyph emission compositing on.
    assert_eq!(LIVE_EFFECT, Effect::Glow);
    assert!(LIVE_EFFECT.motion());
    assert!(LIVE_EFFECT.glow());
    assert!(!Effect::Motion.glow() && !Effect::Fill.glow() && !Effect::Baseline.glow());
    // The engine sets band flag bit 4 from the live policy...
    assert!(include_str!("ffi.rs").contains("crate::appearance::LIVE_EFFECT.glow()"));
    assert!(include_str!("gpu.rs").contains("if glow { 4.0 } else { 0.0 }"));
    // ...and the composite reads the two existing half-resolution bases that the
    // blur ramp already owns, only inside the shared protected envelope.
    let composite = include_str!("composite.wgsl");
    assert!(composite.contains("(flags & 4u) != 0u"));
    assert!(composite.contains("reconstructed(near,gid.xy).g+reconstructed(far,gid.xy).b"));
    assert!(composite.contains("d <= 24.0 * band.w"));
    // No glow-specific pass, texture or bind group was introduced.
    assert_eq!(
        include_str!("composite.wgsl").matches("var near:").count(),
        1
    );
    assert_eq!(
        include_str!("downsample.wgsl")
            .matches("fn downsample")
            .count(),
        1
    );
    assert_eq!(include_str!("blur.wgsl").matches("fn blur").count(), 1);
}
#[test]
#[ignore = "interleaved per-effect host gate; software GPU proxy only"]
fn live_effect_interleaved_budget() {
    let mut reports = Vec::new();
    for landscape in [false, true] {
        let (w, h) = if landscape { (844, 390) } else { (390, 640) };
        let mut gpu = pollster::block_on(Gpu::new(w, h)).unwrap();
        for style in [Style::Spicy, Style::Amll] {
            for (before, after) in [
                (Effect::Baseline, Effect::Fill),
                (Effect::Fill, Effect::Motion),
                (Effect::Motion, Effect::Glow),
            ] {
                let fixture = if style == Style::Amll { 1 } else { 11 };
                let (mut a, time) = track(fixture, style, landscape);
                let (mut b, _) = track(fixture, style, landscape);
                let mut sa = AppearanceState::default();
                let mut sb = AppearanceState::default();
                let mut scene = vello::Scene::new();
                for i in 0..8 {
                    for (track, state, effect) in
                        [(&mut a, &mut sa, before), (&mut b, &mut sb, after)]
                    {
                        let band = frame(
                            track,
                            state,
                            time,
                            10000.0 + i as f64 * 8.333,
                            &mut scene,
                            effect,
                        );
                        render(&mut gpu, &scene, band, effect);
                    }
                }
                let mut old = Vec::new();
                let mut new = Vec::new();
                for i in 0..90 {
                    for slot in 0..2 {
                        let is_new = (i + slot) % 2 == 1;
                        let (track, state, effect) = if is_new {
                            (&mut b, &mut sb, after)
                        } else {
                            (&mut a, &mut sa, before)
                        };
                        let wall = 11000.0 + i as f64 * 8.333;
                        let position = time + i as f64 * 8.333;
                        let mut band = (0.0, 0.0);
                        let start = Instant::now();
                        let allocations = crate::allocation_probe::measure(|| {
                            band = frame(track, state, position, wall, &mut scene, effect);
                        });
                        let scene_ms = start.elapsed().as_secs_f64() * 1000.0;
                        let start = Instant::now();
                        let stats = render(&mut gpu, &scene, band, effect);
                        let value = Sample {
                            scene_ms,
                            encode_ms: stats.cpu_encode_ms,
                            wall_ms: start.elapsed().as_secs_f64() * 1000.0,
                            scene_allocations: allocations,
                            explicit_wait_readback_ms: stats.wait_readback_ms,
                            gpu_interval_including_queue_gaps_ms: stats.gpu_interval_ms,
                        };
                        if is_new {
                            new.push(value);
                        } else {
                            old.push(value);
                        }
                    }
                }
                let scene_a = quantile(&old, |s| s.scene_ms, 0.5);
                let scene_b = quantile(&new, |s| s.scene_ms, 0.5);
                let encode_a = quantile(&old, |s| s.encode_ms, 0.95);
                let encode_b = quantile(&new, |s| s.encode_ms, 0.95);
                let accepted = new.iter().all(|s| s.scene_allocations == 0)
                    && scene_b <= scene_a * 1.25 + 0.01
                    && encode_b <= encode_a * 1.25 + 0.5;
                reports.push(serde_json::json!({"before":before,"after":after,"style":style,"width":w,"height":h,"time_ms":time,"adapter":gpu.adapter,"fixture_line":fixture,"scene_p50_ms":[scene_a,scene_b],"encode_p95_ms":[encode_a,encode_b],"accepted":accepted,"old_samples":old,"new_samples":new}));
            }
        }
    }
    // Glow is the live effect: its intensity, radius and activation now follow
    // the Skia sources, and it composites inside the shared half-resolution pass.
    // The Motion->Glow gates above stay recorded and must be re-run on a host with
    // the real adapter before any phone claim. Because glow is enabled, its own
    // comparison is part of the accepted set instead of being excluded.
    let enabled_pass = reports.iter().all(|r| r["accepted"] == true);
    assert_eq!(crate::appearance::LIVE_EFFECT, Effect::Glow);
    assert!(crate::appearance::LIVE_EFFECT.motion());
    let report = serde_json::json!({"scope":"Linux host same adapter; no phone optimization setting changed, actual fixture/parser/fonts; interleaved per-effect gates; no phone120 evidence","build":if cfg!(debug_assertions) { "debug" } else { "release" },"samples":90,"warmup":8,"thresholds":{"scene_p50":"before*1.25+0.01ms","encode_p95":"before*1.25+0.5ms","steady_scene_allocations":0},"native_present_calls_per_second":null,"live_effect":crate::appearance::LIVE_EFFECT,"glow_live_enabled":crate::appearance::LIVE_EFFECT.glow(),"reports":reports});
    std::fs::write(
        "/tmp/rust-parity-appearance-budget.json",
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    assert!(
        enabled_pass,
        "an enabled effect was rejected; inspect /tmp/rust-parity-appearance-budget.json"
    );
}

#[test]
#[ignore = "GPU pixel transition regression; requires a GPU adapter"]
fn spicy_primed_and_active_start_use_identical_glyph_geometry() {
    let (mut track, _) = track(11, Style::Spicy, false);
    let start = track.lines[0].start;
    track.prepare(start - 1.0).unwrap();
    let mut state = AppearanceState::default();
    state.prepare(&track, start - 1.0, 1000.0);
    for i in 0..30 {
        state.advance(
            &track,
            start - 1.0,
            1000.0 + i as f64 * 16.0,
            true,
            Effect::Glow,
        );
    }
    let mut scene = vello::Scene::new();
    let mut gpu = pollster::block_on(Gpu::new(track.width, track.height)).unwrap();
    let band = track.frame_appearance(start - 1.0, 0.0, &[], &state, &mut scene, Effect::Glow);
    render(&mut gpu, &scene, band, Effect::Glow);
    let primed = gpu.read_pixels().unwrap();
    state.advance(&track, start, 1480.0, true, Effect::Glow);
    let band = track.frame_appearance(start, 0.0, &[], &state, &mut scene, Effect::Glow);
    render(&mut gpu, &scene, band, Effect::Glow);
    let active = gpu.read_pixels().unwrap();
    let max_delta = primed
        .iter()
        .zip(&active)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(max_delta <= 1, "primed -> active pixel delta {max_delta}");
}

#[test]
#[ignore = "GPU surface orientation/clear regression; requires a GPU adapter"]
fn surface_copy_preserves_text_orientation_and_clears_previous_glyphs() {
    let (mut track, time) = track(11, Style::Spicy, false);
    let mut state = AppearanceState::default();
    let mut scene = vello::Scene::new();
    let band = frame(
        &mut track,
        &mut state,
        time,
        1000.0,
        &mut scene,
        Effect::Glow,
    );
    let mut gpu = pollster::block_on(Gpu::new(track.width, track.height)).unwrap();
    render(&mut gpu, &scene, band, Effect::Glow);
    let target = gpu.read_pixels().unwrap();
    let surface = gpu.surface_pixels().unwrap();
    assert!(target.chunks_exact(4).any(|p| p[3] > 0));
    for (a, b) in target.chunks_exact(4).zip(surface.chunks_exact(4)) {
        assert_eq!(
            a[3], b[3],
            "surface must preserve each glyph pixel's coordinates"
        );
    }
    scene.reset();
    render(&mut gpu, &scene, band, Effect::Glow);
    assert!(gpu.read_pixels().unwrap().iter().all(|v| *v == 0));
    assert!(gpu.surface_pixels().unwrap().iter().all(|v| *v == 0));
}
