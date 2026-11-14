//! Isolated-voice evidence using the unchanged production track, scene and GPU path.
use lyrics_renderer::{gpu::Gpu, live::TrackPacket, scene::TrackScene};
use std::{env, fs, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 7 {
        return Err("parity-capture TRACK_JSON WIDTH HEIGHT DPR TIME_MS PNG".into());
    }
    let width: u32 = args[2].parse()?;
    let height: u32 = args[3].parse()?;
    let scale: f32 = args[4].parse()?;
    let time: f64 = args[5].parse()?;
    if !(128..=4096).contains(&width)
        || !(128..=4096).contains(&height)
        || !time.is_finite()
        || time < 0.0
    {
        return Err("invalid capture dimensions or time".into());
    }
    let packet = TrackPacket::parse(&fs::read(&args[1])?)?;
    let start = Instant::now();
    let track = TrackScene::from_lines(packet.into_lines(), width, height, scale)?;
    let layout_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut gpu = pollster::block_on(Gpu::new(width, height))?;
    let mut scene = vello::Scene::new();
    let start = Instant::now();
    let band = track.frame(time, &mut scene);
    let cpu_scene_ms = start.elapsed().as_secs_f64() * 1000.0;
    let stats = gpu.render(&scene, band, true)?;
    gpu.save(&args[6])?;
    println!(
        "{}",
        serde_json::json!({
            "scope": "unchanged ABI3 production isolated-voice baseline; no style support",
            "width": width, "height": height, "dpr": scale, "time_ms": time,
            "layout_ms": layout_ms, "cpu_scene_ms": cpu_scene_ms,
            "glyph_count": track.glyph_count, "missing_glyphs": track.missing_glyphs,
            "stats": stats,
        })
    );
    Ok(())
}
