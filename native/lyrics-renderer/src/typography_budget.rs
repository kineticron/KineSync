//! Explicit host-only per-effect gate. Uses exact a9b6398 scene source, one GPU,
//! identical song/input/time/dimensions/profile and interleaved baseline/variant.
use crate::{
    allocation_probe,
    gpu::Gpu,
    scene::TrackScene,
    typography::{Fonts, PaintVoice, Settings, Style},
};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
struct Sample {
    scene_ms: f64,
    encode_ms: f64,
    render_wall_ms: f64,
    scene_allocations: usize,
    render_allocations: usize,
}
#[derive(Serialize)]
struct Summary {
    scene_p50: f64,
    encode_p50: f64,
    encode_p95: f64,
    render_wall_p50: f64,
    scene_allocations_max: usize,
    render_allocations_max: usize,
    headless_frames_per_second: f64,
}
fn percentile(values: impl Iterator<Item = f64>, p: f64) -> f64 {
    let mut values: Vec<_> = values.collect();
    values.sort_by(f64::total_cmp);
    values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)]
}
fn summarize(samples: &[Sample]) -> Summary {
    Summary {
        scene_p50: percentile(samples.iter().map(|s| s.scene_ms), 0.5),
        encode_p50: percentile(samples.iter().map(|s| s.encode_ms), 0.5),
        encode_p95: percentile(samples.iter().map(|s| s.encode_ms), 0.95),
        render_wall_p50: percentile(samples.iter().map(|s| s.render_wall_ms), 0.5),
        scene_allocations_max: samples.iter().map(|s| s.scene_allocations).max().unwrap(),
        render_allocations_max: samples.iter().map(|s| s.render_allocations).max().unwrap(),
        headless_frames_per_second: 1000.0 * samples.len() as f64
            / samples
                .iter()
                .map(|s| s.scene_ms + s.render_wall_ms)
                .sum::<f64>(),
    }
}
#[test]
#[ignore = "host proxy effect gate; requires Vulkan, run once per changed effect"]
fn host_typography_effect_budget() {
    use sha2::Digest;
    assert_eq!(
        format!(
            "{:x}",
            sha2::Sha256::digest(include_bytes!("../test/baseline-scene.rs"))
        ),
        "2f28e53f9c18f80d5f8cda2b51756fda802af521bd521cfad7fbe30507758b6c"
    );
    let source: serde_json::Value =
        serde_json::from_str(include_str!("../test/typography-policy.json")).unwrap();
    let mut records = Vec::new();
    for (width, height, landscape) in [(390, 640, false), (844, 390, true)] {
        let mut gpu = pollster::block_on(Gpu::new(width, height)).unwrap();
        for index in [1usize, 9] {
            for style in [Style::Spicy, Style::Amll] {
                let prepared = source["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| {
                        c["name"] == format!("fixture-{index}")
                            && c["style"]
                                == if style == Style::Spicy {
                                    "spicy"
                                } else {
                                    "amll"
                                }
                    })
                    .unwrap();
                let packet = serde_json::json!({"schema":4,"generation":1,"track_id":"budget","lines":[prepared["original_line"]]});
                let mut line =
                    crate::live::TrackPacket::parse(&serde_json::to_vec(&packet).unwrap())
                        .unwrap()
                        .into_lines()
                        .remove(0);
                let voice: PaintVoice = serde_json::from_value(prepared["voice"].clone()).unwrap();
                line.paint = Some(voice);
                let baseline = crate::baseline_scene::TrackScene::from_lines(
                    vec![line.clone()],
                    width,
                    height,
                    1.0,
                )
                .unwrap();
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
                let settings = Settings {
                    style,
                    font_scale: if landscape { 0.9 } else { 1.0 },
                    landscape,
                };
                let mut variant = TrackScene::with_fonts(
                    vec![line.clone()],
                    width,
                    height,
                    1.0,
                    Some(&settings),
                    &mut fonts,
                )
                .unwrap();
                let mut scene = vello::Scene::new();
                let mut before = Vec::new();
                let mut after = Vec::new();
                let base_time = line.start + (line.end - line.start) * 0.47;
                // Warm both paths, all branches and the shared GPU's glyph/encoding buffers.
                for _ in 0..6 {
                    let band = baseline.frame(base_time, &mut scene);
                    gpu.render(&scene, band, true).unwrap();
                    let band = variant.frame(base_time, &mut scene);
                    gpu.render(&scene, band, true).unwrap();
                }
                for sample in 0..30 {
                    let time = base_time + sample as f64 / 120.0;
                    for slot in 0..2 {
                        let candidate = (sample + slot) % 2 == 1;
                        let start = Instant::now();
                        let mut band = (0.0, 0.0);
                        let scene_allocations = allocation_probe::measure(|| {
                            band = if candidate {
                                variant.frame(time, &mut scene)
                            } else {
                                baseline.frame(time, &mut scene)
                            };
                        });
                        let scene_ms = start.elapsed().as_secs_f64() * 1000.0;
                        let start = Instant::now();
                        let mut stats = None;
                        let render_allocations = allocation_probe::measure(|| {
                            stats = Some(gpu.render(&scene, band, true).unwrap());
                        });
                        let render_wall_ms = start.elapsed().as_secs_f64() * 1000.0;
                        let value = Sample {
                            scene_ms,
                            encode_ms: stats.unwrap().cpu_encode_ms,
                            render_wall_ms,
                            scene_allocations,
                            render_allocations,
                        };
                        if candidate {
                            after.push(value);
                        } else {
                            before.push(value);
                        }
                    }
                }
                let a = summarize(&before);
                let b = summarize(&after);
                let accepted = b.scene_allocations_max == 0
                    && b.scene_p50 <= a.scene_p50 * 1.25 + 0.01
                    && b.encode_p95 <= a.encode_p95 * 1.25 + 0.5;
                records.push(serde_json::json!({"effect":"explicit fonts + style typography/layout; no new glow/blur/scroll effect",
                "style":style,"fixture_line":index,"width":width,"height":height,"dpr":1,"time_ms":base_time,
                "baseline_source":"a9b6398 native/lyrics-renderer/src/scene.rs, exact checked test copy", "adapter":gpu.adapter,
                "baseline":a,"variant":b,"accepted":accepted,"baseline_samples":before,"variant_samples":after,
                "actual_layout":variant.diagnostics}));
            }
        }
    }
    let report = serde_json::json!({"scope":"Linux Vulkan host proxy, dev opt0/debug0, one shared GPU, interleaved orders; no phone result",
        "allocation_scope":"alloc/realloc/alloc_zeroed on invoking Rust thread, scene isolated from render+headless wait/readback; other driver threads excluded",
        "thresholds":{"steady_scene_allocations":0,"scene_p50_max":"baseline*1.25 + 0.01ms","encode_p95_max":"baseline*1.25 + 0.5ms"},
        "native_present_calls_per_second":null,"native_present_calls_reason":"headless texture render has no native Surface::present; not a substitute for physical presentation",
        "records":records});
    let out = std::env::var("KR_TYPOGRAPHY_BUDGET_JSON")
        .unwrap_or_else(|_| "/tmp/rust-parity-typography-effect-budget.json".into());
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    assert!(
        records.iter().all(|r| r["accepted"] == true),
        "effect gate rejected a case; inspect {out}"
    );
}
