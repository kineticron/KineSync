use lyrics_renderer::gpu::{FrameStats, Gpu};
use lyrics_renderer::scene::TrackScene;
use serde::Serialize;
use std::{fs, path::Path, time::Instant};

type Error = Box<dyn std::error::Error>;

#[derive(Serialize)]
struct Sample {
    frame: usize,
    time_ms: f64,
    cpu_scene_ms: f64,
    #[serde(flatten)]
    render: FrameStats,
    wall_frame_ms: f64,
}
#[derive(Serialize)]
struct Percentiles {
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
}
fn percentiles(values: impl Iterator<Item = f64>) -> Percentiles {
    let mut values: Vec<_> = values.collect();
    values.sort_by(f64::total_cmp);
    // Nearest-rank convention, rank = ceil(p*N), one-indexed.
    let at = |p: f64| values[((p * values.len() as f64).ceil() as usize).saturating_sub(1)];
    Percentiles {
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: *values.last().unwrap(),
    }
}
#[derive(Serialize)]
struct Summary {
    cpu_scene_ms: Percentiles,
    cpu_encode_ms: Percentiles,
    wait_readback_ms: Percentiles,
    gpu_interval_ms: Option<Percentiles>,
    wall_frame_ms: Percentiles,
}
#[derive(Serialize)]
struct Benchmark {
    width: u32,
    height: u32,
    adapter: String,
    layout_ms: f64,
    glyph_count: usize,
    missing_glyphs: usize,
    warmup: usize,
    samples: Vec<Sample>,
    summary: Summary,
}
#[derive(Serialize)]
struct Report {
    schema: u32,
    note: &'static str,
    percentile_convention: &'static str,
    results: Vec<Benchmark>,
}
fn ensure_parent(path: &str) -> Result<(), Error> {
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}
fn setup(width: u32, height: u32) -> Result<(TrackScene, Gpu, f64), Error> {
    if width < 128 || height < 128 || width > 4096 || height > 4096 {
        return Err("dimensions must be in 128..=4096 pixels".into());
    }
    let start = Instant::now();
    let track = TrackScene::new(width, height)?;
    let layout_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "Cached layout: {layout_ms:.2} ms, {} lines, {} glyphs, {} missing glyphs",
        track.lines.len(),
        track.glyph_count,
        track.missing_glyphs
    );
    let gpu = pollster::block_on(Gpu::new(width, height))?;
    Ok((track, gpu, layout_ms))
}
fn render(width: u32, height: u32, time: f64, path: &str, blur: bool) -> Result<(), Error> {
    if !time.is_finite() || time < 0.0 {
        return Err("time must be finite and nonnegative".into());
    }
    let (track, mut gpu, _) = setup(width, height)?;
    let mut scene = vello::Scene::new();
    let band = track.frame(time, &mut scene);
    let stats = gpu.render(&scene, band, blur)?;
    ensure_parent(path)?;
    gpu.save(path)?;
    println!("PNG: {path}\n{}", serde_json::to_string(&stats)?);
    Ok(())
}
fn gallery(directory: &str) -> Result<(), Error> {
    fs::create_dir_all(directory)?;
    for (width, height, orientation) in [(390, 844, "portrait"), (844, 390, "landscape")] {
        let (track, mut gpu, _) = setup(width, height)?;
        let mut scene = vello::Scene::new();
        for time in [11077, 17300, 17500, 17700, 21200, 33400] {
            let band = track.frame(time as f64, &mut scene);
            gpu.render(&scene, band, true)?;
            let path = format!("{directory}/rust_spike_{orientation}_{time}.png");
            gpu.save(&path)?;
            println!("PNG: {path}");
        }
    }
    Ok(())
}
fn benchmark(path: &str, count: usize, warmup: usize, png_dir: &str) -> Result<(), Error> {
    if count == 0 || warmup == 0 {
        return Err("sample and warmup counts must be positive".into());
    }
    fs::create_dir_all(png_dir)?;
    let mut results = Vec::new();
    for (width, height, orientation) in [(390, 844, "portrait"), (844, 390, "landscape")] {
        let (track, mut gpu, layout_ms) = setup(width, height)?;
        let mut scene = vello::Scene::new();
        for frame in 0..warmup {
            let band = track.frame(16600.0 + frame as f64 * 1000.0 / 60.0, &mut scene);
            gpu.render(&scene, band, true)?;
        }
        let mut samples = Vec::with_capacity(count);
        for frame in 0..count {
            let time_ms = 16600.0 + (frame % 180) as f64 * 1000.0 / 60.0;
            let start = Instant::now();
            let band = track.frame(time_ms, &mut scene);
            let cpu_scene_ms = start.elapsed().as_secs_f64() * 1000.0;
            let render = gpu.render(&scene, band, true)?;
            let wall_frame_ms = start.elapsed().as_secs_f64() * 1000.0;
            samples.push(Sample {
                frame,
                time_ms,
                cpu_scene_ms,
                render,
                wall_frame_ms,
            });
        }
        let gpu_values: Vec<_> = samples
            .iter()
            .filter_map(|s| s.render.gpu_interval_ms)
            .collect();
        let summary = Summary {
            cpu_scene_ms: percentiles(samples.iter().map(|s| s.cpu_scene_ms)),
            cpu_encode_ms: percentiles(samples.iter().map(|s| s.render.cpu_encode_ms)),
            wait_readback_ms: percentiles(samples.iter().map(|s| s.render.wait_readback_ms)),
            gpu_interval_ms: if gpu_values.is_empty() {
                None
            } else {
                Some(percentiles(gpu_values.into_iter()))
            },
            wall_frame_ms: percentiles(samples.iter().map(|s| s.wall_frame_ms)),
        };
        println!("{orientation}: {}", serde_json::to_string(&summary)?);
        gpu.save(&format!("{png_dir}/rust_spike_benchmark_{orientation}.png"))?;
        results.push(Benchmark {
            width,
            height,
            adapter: gpu.adapter.clone(),
            layout_ms,
            glyph_count: track.glyph_count,
            missing_glyphs: track.missing_glyphs,
            warmup,
            samples,
            summary,
        });
    }
    let report = Report {
        schema: 1,
        note: "Linux host proxy, not phone performance. One frame in flight, synchronous wait and 16-byte timestamp readback per frame. CPU encode includes Vello raster preparation and queue submission plus GPU blur/composition encoding. GPU timestamp interval brackets Vello + blur/composite across submissions, including GPU queue gaps. PNG readback/encoding, shaping, device/pipeline initialization and warmup excluded from samples; layout reported separately. No CPU pixel blur. No vsync/presentation measurement.",
        percentile_convention: "nearest rank: sorted[ceil(p*N)-1]",
        results,
    };
    ensure_parent(path)?;
    fs::write(path, serde_json::to_string_pretty(&report)? + "\n")?;
    println!("Benchmark raw samples and percentiles: {path}");
    Ok(())
}
fn main() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("gallery") => gallery(args.get(2).map(String::as_str).unwrap_or("output")),
        Some("bench") => benchmark(
            args.get(2)
                .map(String::as_str)
                .unwrap_or("output/benchmark.json"),
            args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(120),
            args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(12),
            args.get(5).map(String::as_str).unwrap_or("output"),
        ),
        Some("--help") => {
            println!(
                "lyrics-renderer [WIDTH HEIGHT TIME_MS PNG [--no-blur]]\nlyrics-renderer gallery [DIRECTORY]\nlyrics-renderer bench [JSON_PATH] [SAMPLES=120] [WARMUP=12] [PNG_DIRECTORY]"
            );
            Ok(())
        }
        _ => render(
            args.get(1).map(|s| s.parse()).transpose()?.unwrap_or(390),
            args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(844),
            args.get(3)
                .map(|s| s.parse())
                .transpose()?
                .unwrap_or(17500.0),
            args.get(4)
                .map(String::as_str)
                .unwrap_or("output/frame.png"),
            !args.iter().any(|a| a == "--no-blur"),
        ),
    }
}
