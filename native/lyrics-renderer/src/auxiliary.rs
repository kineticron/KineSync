//! Cached foreground subtitles from native-skia-voice.tsx:213-226,251-252.
//! Geometry is immutable and shaped only with its owning row/window.
use crate::typography::{Fonts, Geometry, Settings, Style};
use parley::{Alignment, AlignmentOptions, LayoutContext, PositionedLayoutItem};
use vello::{
    Scene,
    kurbo::{Affine, Rect},
    peniko::{BlendMode, Color, Fill},
};

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct Policy {
    pub size: f32,
    pub leading: f32,
    pub weight: f32,
    pub width: f32,
    pub margin: f32,
    pub x: f32,
}
impl Policy {
    /// Subtitle policy for one row voice. A background voice keeps its own type
    /// size and text width, and Skia's smaller Spicy background leading/inset
    /// (`native-skia-voice.tsx:207-214`).
    pub fn voice(
        settings: &Settings,
        geometry: &Geometry,
        dpr: f32,
        background: bool,
        font_size: f32,
        text_width: f32,
    ) -> Self {
        let spicy = settings.style == Style::Spicy;
        if spicy {
            return Self {
                size: geometry.font_size * (if background { 12.0 } else { 14.0 } / 33.6),
                leading: geometry.font_size * (if background { 16.0 } else { 18.0 } / 33.6),
                weight: 500.0,
                width: (text_width - 4.0 * dpr).max(dpr),
                margin: if background { 2.0 * dpr } else { 4.0 * dpr },
                x: 2.0 * dpr,
            };
        }
        let size = (10.0 * dpr).max(font_size * 0.5);
        Self {
            size,
            leading: size * 1.5,
            weight: 700.0,
            width: text_width.max(dpr),
            margin: 0.0,
            x: 0.0,
        }
    }
}
pub(crate) struct Translation {
    scene: Scene,
    bounds: Rect,
    pub extra_height: f64,
    pub glyph_count: usize,
    pub missing_glyphs: usize,
    pub diagnostics: serde_json::Value,
}
impl Translation {
    pub fn prepare(
        text: &str,
        policy: &Policy,
        right: bool,
        main_height: f64,
        fonts: &mut Fonts,
        layouts: &mut LayoutContext<()>,
    ) -> Self {
        let p = policy.clone();
        let mut layout = crate::scene::shape(
            text,
            &mut fonts.context,
            layouts,
            p.size,
            p.leading,
            p.weight,
            "'SF Pro Display', sans-serif",
            &[],
            0.0,
        );
        layout.break_all_lines(Some(p.width));
        layout.align(
            if right {
                Alignment::End
            } else {
                Alignment::Start
            },
            AlignmentOptions::default(),
        );
        let mut scene = Scene::new();
        let mut glyph_count = 0;
        let mut missing_glyphs = 0;
        let mut faces = Vec::new();
        let y = main_height + f64::from(p.margin);
        for line in layout.lines() {
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(gr) = item {
                    let run = gr.run();
                    let face = fonts.describe(run.font());
                    faces.push(serde_json::json!({"face":face,"text_bytes":[run.text_range().start,run.text_range().end],"requested_attributes":format!("{:?}",run.font_attrs()),"normalized_coords":run.normalized_coords().iter().map(|c|c.to_bits()).collect::<Vec<_>>() }));
                    scene
                        .draw_glyphs(run.font())
                        .font_size(run.font_size())
                        .normalized_coords(
                            &run.normalized_coords()
                                .iter()
                                .map(|c| c.to_bits())
                                .collect::<Vec<_>>(),
                        )
                        .transform(Affine::translate((f64::from(p.x), y)))
                        // Packed sharp-opacity channel, decoded by the existing shared composite.
                        .brush(Color::new([crate::timed_scene::srgb(0.3), 0.0, 0.0, 1.0]))
                        .draw(
                            Fill::NonZero,
                            gr.positioned_glyphs().map(|g| {
                                glyph_count += 1;
                                missing_glyphs += usize::from(g.id == 0);
                                vello::Glyph {
                                    id: g.id,
                                    x: g.x,
                                    y: g.y,
                                }
                            }),
                        );
                }
            }
        }
        let height = f64::from(layout.height());
        Self {
            scene,
            bounds: Rect::new(
                -64.0,
                y - 64.0,
                f64::from(p.width) + 64.0,
                y + height + 64.0,
            ),
            extra_height: f64::from(p.margin) + height,
            glyph_count,
            missing_glyphs,
            diagnostics: serde_json::json!({"text":text,"policy":p,"height":height,"y":y,"line_count":layout.len(),"faces":faces}),
        }
    }
    pub fn draw(&self, scene: &mut Scene, transform: Affine, outer: f64) {
        scene.push_layer(
            Fill::NonZero,
            BlendMode::default(),
            outer as f32,
            transform,
            &self.bounds,
        );
        scene.append(&self.scene, Some(transform));
        scene.pop_layer();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        appearance::{AppearanceState, Effect},
        gpu::Gpu,
        live::TrackPacket,
        scene::{LayoutCache, TrackScene},
    };
    use std::time::Instant;
    fn data() -> serde_json::Value {
        serde_json::from_str(include_str!("../test/auxiliary-track.json")).unwrap()
    }
    fn track(item: &serde_json::Value, visible: bool) -> (TrackScene, f64, String) {
        let p = TrackPacket::parse(
            &serde_json::to_vec(&item[if visible { "visible" } else { "hidden" }]).unwrap(),
        )
        .unwrap();
        let settings = p.settings.clone().unwrap();
        let lines = p.into_lines();
        let time = lines[0].start + (lines[0].end - lines[0].start) * 0.47;
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
        let (w, h) = if settings.landscape {
            (844, 390)
        } else {
            (390, 640)
        };
        let key = LayoutCache::key("aux", &lines, &settings, w, h, 1.0).unwrap();
        (
            TrackScene::with_fonts(lines, w, h, 1.0, Some(&settings), &mut fonts).unwrap(),
            time,
            key,
        )
    }
    fn frame(
        track: &mut TrackScene,
        state: &mut AppearanceState,
        scene: &mut Scene,
        time: f64,
        wall: f64,
    ) -> (f32, f32) {
        track.prepare(time).unwrap();
        state.prepare(track, time, wall);
        state.advance(track, time, wall, true, Effect::Motion);
        track.frame_appearance(
            time,
            track.scroll_target(time),
            &[],
            state,
            scene,
            Effect::Motion,
        )
    }
    #[test]
    fn actual_translation_visibility_fonts_source_policy_and_cache_identity() {
        use sha2::Digest;
        let d = data();
        assert_eq!(d["packets"].as_array().unwrap().len(), 8);
        for source in d["sources"].as_array().unwrap() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(source["path"].as_str().unwrap());
            assert_eq!(
                format!("{:x}", sha2::Sha256::digest(std::fs::read(path).unwrap())),
                source["sha256"].as_str().unwrap()
            );
        }
        for item in d["packets"].as_array().unwrap() {
            let (mut hidden, time, key_a) = track(item, false);
            let (mut shown, _, key_b) = track(item, true);
            assert_ne!(
                key_a, key_b,
                "visibility/content must invalidate retained geometry"
            );
            hidden.prepare(time).unwrap();
            shown.prepare(time).unwrap();
            assert!(hidden.cached[0].lead().translation.is_none());
            let t = shown.cached[0].lead().translation.as_ref().unwrap();
            assert_eq!(t.diagnostics["text"], item["original_translation"]);
            assert_eq!(t.missing_glyphs, 0);
            assert!(t.glyph_count > 0);
            assert!(shown.cached[0].height >= hidden.cached[0].height);
            let spicy = item["style"] == "spicy";
            let landscape = item["landscape"] == true;
            let size = t.diagnostics["policy"]["size"].as_f64().unwrap();
            let expected = if spicy {
                if landscape { 12.6 } else { 14.0 }
            } else if landscape {
                14.4
            } else {
                18.0
            };
            assert!((size - expected).abs() < 0.0001);
            assert_eq!(
                t.diagnostics["policy"]["weight"],
                if spicy { 500.0 } else { 700.0 }
            );
            assert_eq!(
                t.diagnostics["policy"]["margin"],
                if spicy { 4.0 } else { 0.0 }
            );
            assert!(!t.diagnostics["faces"].as_array().unwrap().is_empty());
            let mut state = AppearanceState::default();
            let mut scene = Scene::new();
            for i in 0..3 {
                frame(
                    &mut shown,
                    &mut state,
                    &mut scene,
                    time,
                    10000.0 + i as f64 * 8.333,
                );
            }
            let prepares = (shown.plain_preparations, shown.detailed_preparations);
            let allocations = crate::allocation_probe::measure(|| {
                for i in 0..120 {
                    frame(
                        &mut shown,
                        &mut state,
                        &mut scene,
                        time + i as f64 * 0.01,
                        10100.0 + i as f64 * 8.333,
                    );
                }
            });
            assert_eq!(allocations, 0);
            assert_eq!(
                prepares,
                (shown.plain_preparations, shown.detailed_preparations)
            );
            let mut invalid = item["visible"].clone();
            invalid["lines"][0]["paint"]["translation"] = serde_json::json!("x".repeat(20001));
            assert!(TrackPacket::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }
    #[test]
    #[ignore = "actual GPU subtitle coverage/premultiplied readback"]
    fn actual_auxiliary_gpu_pixels() {
        let mut receipts = Vec::new();
        for item in data()["packets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["fixture_line"] == 1)
        {
            let (mut shown, time, _) = track(item, true);
            let mut state = AppearanceState::default();
            let mut scene = Scene::new();
            let mut gpu = pollster::block_on(Gpu::new(shown.width, shown.height)).unwrap();
            let band = frame(&mut shown, &mut state, &mut scene, time, 10000.0);
            gpu.render_appearance(&scene, band, true, false).unwrap();
            let pixels = gpu.read_pixels().unwrap();
            for p in pixels.as_chunks::<4>().0 {
                assert!(p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
            }
            assert_eq!(&pixels[..4], &[0, 0, 0, 0]);
            let cached = &shown.cached[0];
            let t = cached.lead().translation.as_ref().unwrap();
            let y = (shown.scroll_anchor() + shown.prefix[0] - shown.scroll_target(time)
                + shown.interlude_shift(time).1
                + cached.top
                + cached.lead().offset
                + cached.lead().padding
                + t.diagnostics["y"].as_f64().unwrap())
            .max(0.0) as usize;
            let y_end = (y + (t.diagnostics["height"].as_f64().unwrap().ceil() as usize))
                .min(shown.height as usize);
            let visible = pixels
                .as_chunks::<4>()
                .0
                .iter()
                .enumerate()
                .filter(|(i, p)| {
                    i / (shown.width as usize) >= y
                        && i / (shown.width as usize) < y_end
                        && p[3] > 0
                })
                .count();
            assert!(
                visible > 20,
                "{} landscape={}: actual subtitle region y={y}..{y_end} must contain ink",
                item["style"],
                item["landscape"]
            );
            let png = format!(
                "/files/rust_parity_aux_{}_{}.png",
                item["style"].as_str().unwrap(),
                if item["landscape"] == true {
                    "landscape"
                } else {
                    "portrait"
                }
            );
            gpu.save(&png).unwrap();
            receipts.push(serde_json::json!({"style":item["style"],"landscape":item["landscape"],"subtitle_pixels":visible,"png":png,"selected_layout":shown.diagnostics,"premultiplied":true,"scope":"actual Rust render; not Skia parity acceptance"}));
        }
        std::fs::write(
            "/tmp/rust-aux-pixels.json",
            serde_json::to_string_pretty(&receipts).unwrap(),
        )
        .unwrap();
    }
    #[derive(serde::Serialize)]
    struct Sample {
        scene_ms: f64,
        encode_ms: f64,
        wall_ms: f64,
        wait_readback_ms: f64,
        gpu_interval_including_queue_gaps_ms: Option<f64>,
        allocations: usize,
    }
    fn percentile(samples: &[Sample], f: impl Fn(&Sample) -> f64, p: f64) -> f64 {
        let mut v: Vec<_> = samples.iter().map(f).collect();
        v.sort_by(f64::total_cmp);
        v[(v.len() as f64 * p).ceil() as usize - 1]
    }
    #[test]
    #[ignore = "interleaved actual auxiliary effect host gate"]
    fn auxiliary_effect_budget() {
        let mut reports = Vec::new();
        for item in data()["packets"].as_array().unwrap() {
            let (mut before, time, _) = track(item, false);
            let (mut after, _, _) = track(item, true);
            let mut gpu = pollster::block_on(Gpu::new(before.width, before.height)).unwrap();
            let mut a = AppearanceState::default();
            let mut b = AppearanceState::default();
            let mut scene = Scene::new();
            for i in 0..8 {
                for (t, s) in [(&mut before, &mut a), (&mut after, &mut b)] {
                    let band = frame(t, s, &mut scene, time, 10000.0 + i as f64 * 8.333);
                    gpu.render_appearance(&scene, band, true, false).unwrap();
                }
            }
            let mut old = Vec::new();
            let mut new = Vec::new();
            for i in 0..90 {
                for slot in 0..2 {
                    let is_new = (i + slot) % 2 == 1;
                    let (t, s) = if is_new {
                        (&mut after, &mut b)
                    } else {
                        (&mut before, &mut a)
                    };
                    let mut band = (0.0, 0.0);
                    let started = Instant::now();
                    let allocations = crate::allocation_probe::measure(|| {
                        band = frame(
                            t,
                            s,
                            &mut scene,
                            time + i as f64 * 8.333,
                            11000.0 + i as f64 * 8.333,
                        );
                    });
                    let scene_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let started = Instant::now();
                    let stats = gpu.render_appearance(&scene, band, true, false).unwrap();
                    let sample = Sample {
                        scene_ms,
                        encode_ms: stats.cpu_encode_ms,
                        wall_ms: started.elapsed().as_secs_f64() * 1000.0,
                        wait_readback_ms: stats.wait_readback_ms,
                        gpu_interval_including_queue_gaps_ms: stats.gpu_interval_ms,
                        allocations,
                    };
                    if is_new {
                        new.push(sample)
                    } else {
                        old.push(sample)
                    }
                }
            }
            let sa = percentile(&old, |s| s.scene_ms, 0.5);
            let sb = percentile(&new, |s| s.scene_ms, 0.5);
            let ea = percentile(&old, |s| s.encode_ms, 0.95);
            let eb = percentile(&new, |s| s.encode_ms, 0.95);
            let accepted = sb <= sa * 1.25 + 0.01
                && eb <= ea * 1.25 + 0.5
                && new.iter().all(|s| s.allocations == 0);
            reports.push(serde_json::json!({"style":item["style"],"landscape":item["landscape"],"fixture_line":item["fixture_line"],"adapter":gpu.adapter,"scene_p50_ms":[sa,sb],"encode_p95_ms":[ea,eb],"accepted":accepted,"before":old,"after":new}));
        }
        let all = reports.iter().all(|r| r["accepted"] == true);
        std::fs::write("/tmp/rust-aux-budget.json",serde_json::to_string_pretty(&serde_json::json!({"scope":"Linux release-opt3 host proxy; one subtitle visibility effect; before/after actual same source packets except subtitle visibility; no native present/phone proof","native_present_calls_per_second":null,"warmup":8,"samples":90,"thresholds":{"scene_p50_ms":"before*1.25+0.01","encode_p95_ms":"before*1.25+0.5","allocations":0},"reports":reports})).unwrap()).unwrap();
        assert!(
            all,
            "auxiliary feature rejected; inspect /tmp/rust-aux-budget.json"
        );
    }
}
