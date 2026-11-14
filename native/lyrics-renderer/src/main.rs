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
        Some("alpha-proof") => alpha_proof(
            args.get(2)
                .map(String::as_str)
                .unwrap_or("output/alpha-proof"),
            args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(1),
        ),
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
                "lyrics-renderer [WIDTH HEIGHT TIME_MS PNG [--no-blur]]\nlyrics-renderer gallery [DIRECTORY]\nlyrics-renderer alpha-proof [DIRECTORY] [SCALE=1]\nlyrics-renderer bench [JSON_PATH] [SAMPLES=120] [WARMUP=12] [PNG_DIRECTORY]"
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

fn write_png(path: &str, width: u32, height: u32, pixels: &[u8]) -> Result<(), Error> {
    let mut png = png::Encoder::new(
        std::io::BufWriter::new(std::fs::File::create(path)?),
        width,
        height,
    );
    png.set_color(png::ColorType::Rgba);
    png.set_depth(png::BitDepth::Eight);
    png.write_header()?.write_image_data(pixels)?;
    Ok(())
}
/// Actual Vello + compute + phone-copy shader readback. No formula-only renderer.
fn alpha_proof(directory: &str, scale: u32) -> Result<(), Error> {
    use vello::{
        Scene,
        kurbo::{Affine, Rect},
        peniko::{Color, Fill},
    };
    fs::create_dir_all(directory)?;
    if !(1..=4).contains(&scale) {
        return Err("proof scale must be 1..=4".into());
    }
    let (w, h) = (390 * scale, 640 * scale);
    let track = TrackScene::from_lines(lyrics_renderer::fixture()?, w, h, scale as f32)?;
    let mut gpu = pollster::block_on(Gpu::new_scaled(w, h, scale as f32))?;
    let mut scene = Scene::new();
    let mut results = Vec::new();
    let mut prior = Vec::new();
    for (i, time) in [17500.0, 18250.0, 20250.0].into_iter().enumerate() {
        let band = track.frame(time, &mut scene);
        let stats = gpu.render(&scene, band, true)?;
        let linear = gpu.read_pixels()?;
        let surface = gpu.surface_pixels()?;
        gpu.render(&scene, band, false)?;
        let sharp = gpu.read_pixels()?;
        let mut protected = 0;
        let mut protected_max_delta = 0;
        for (j, (a, b)) in linear
            .chunks_exact(4)
            .zip(sharp.chunks_exact(4))
            .enumerate()
        {
            let y = (j / w as usize) as f32;
            if y >= band.0 && y <= band.1 {
                let delta = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
                protected_max_delta = protected_max_delta.max(delta);
                // Independent Vello area rasterizations may differ by one LSB.
                assert!(
                    delta <= 2,
                    "protected full-resolution sharp comparison: {delta}"
                );
                protected += 1;
            }
        }
        assert!(protected > 1000);
        assert_ne!(linear, sharp, "inactive blur must actually affect pixels");
        let zero = linear.chunks_exact(4).filter(|p| p[3] == 0).count();
        let translucent = linear
            .chunks_exact(4)
            .filter(|p| p[3] > 0 && p[3] < 255)
            .count();
        assert!(
            zero > (w * h) as usize / 2,
            "outside glyphs must be transparent"
        );
        assert!(translucent > 500, "must exercise alpha edges/blur");
        for p in linear.chunks_exact(4) {
            assert!(
                p[..3].iter().all(|c| *c <= p[3]),
                "linear premultiplied constraint"
            );
        }
        for (a, b) in linear.chunks_exact(4).zip(surface.chunks_exact(4)) {
            assert_eq!(a[3], b[3]);
            assert!(
                b[..3].iter().all(|c| *c <= b[3]),
                "surface encoded premultiplied constraint"
            );
            if a[3] == 0 {
                assert_eq!(b, &[0, 0, 0, 0]);
            }
        }
        if !prior.is_empty() {
            assert_ne!(prior, surface, "moving lyric frames must change");
        }
        prior = surface.clone();
        // PNG viewers expect straight RGB; test raw premultiplied surface bytes
        // above, then remove premultiplication only for the exported PNG.
        let mut png_pixels = surface.clone();
        for p in png_pixels.chunks_exact_mut(4) {
            let alpha = u32::from(p[3]);
            for c in &mut p[..3] {
                *c = (u32::from(*c) * 255 + alpha / 2)
                    .checked_div(alpha)
                    .unwrap_or(0)
                    .min(255) as u8;
            }
        }
        write_png(
            &format!("{directory}/rust_spike_transparent_{i}.png"),
            w,
            h,
            &png_pixels,
        )?;
        let mut checker = Vec::with_capacity(linear.len());
        for (j, p) in linear.chunks_exact(4).enumerate() {
            let x = j % w as usize;
            let y = j / w as usize;
            // Background changes color AND phase each frame, in linear light.
            let bg = if ((x + i * 11) / 32 + (y + i * 7) / 32).is_multiple_of(2) {
                [0.025, 0.25, 0.8]
            } else {
                [0.8, 0.08, 0.03]
            };
            let alpha = f64::from(p[3]) / 255.0;
            for c in 0..3 {
                let value = f64::from(p[c]) / 255.0 + bg[c] * (1.0 - alpha);
                let encoded = if value <= 0.0031308 {
                    12.92 * value
                } else {
                    1.055 * value.powf(1.0 / 2.4) - 0.055
                };
                checker.push((encoded * 255.0).round() as u8);
            }
            checker.push(255);
        }
        write_png(
            &format!("{directory}/rust_spike_checkerboard_{i}.png"),
            w,
            h,
            &checker,
        )?;
        results.push(serde_json::json!({"frame":i,"time_ms":time,"transparent_pixels":zero,"translucent_pixels":translucent,"protected_max_delta_u8":protected_max_delta,"stats":stats}));
    }
    // Saturated color on transparent ground must blur without dark RGB halos.
    scene.reset();
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        Color::from_rgba8(255, 0, 0, 128),
        None,
        &Rect::new(150.0, 250.0, 240.0, 350.0),
    );
    gpu.render(&scene, (-1000.0, -900.0), true)?;
    let pixels = gpu.read_pixels()?;
    let mut halo = 0;
    for p in pixels.chunks_exact(4).filter(|p| p[3] > 0) {
        assert_eq!(p[0], p[3], "red premultiplied blur must preserve chroma");
        assert_eq!(p[1], 0);
        assert_eq!(p[2], 0);
        halo += 1;
    }
    assert!(halo > 9000, "blur must extend beyond the source rectangle");
    // Empty frame after content must clear every channel; resize uses new resources.
    scene.reset();
    gpu.render(&scene, (0.0, 0.0), true)?;
    assert!(gpu.read_pixels()?.iter().all(|v| *v == 0));
    assert!(gpu.surface_pixels()?.iter().all(|v| *v == 0));
    gpu.resize(257, 193, 1.0)?;
    gpu.render(&scene, (0.0, 0.0), true)?;
    assert!(gpu.read_pixels()?.iter().all(|v| *v == 0));
    assert!(gpu.surface_pixels()?.iter().all(|v| *v == 0));
    let report = serde_json::json!({"adapter":gpu.adapter,"width":w,"height":h,"scale":scale,"note":"Linux offscreen host proxy; actual Vello, compute and surface shader. Checkerboards CPU-composite actual linear GPU readback; no UIKit/Metal compositor proof.","frames":results,"red_blur_pixels":halo,"empty_frame_clear":true,"shared_resize_odd_extent_clear":true});
    fs::write(
        format!("{directory}/alpha-proof.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    println!("alpha proof passed: {directory}");
    Ok(())
}
