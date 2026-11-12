mod gpu;
mod scene;
use scene::TrackScene;
use std::{fs, path::Path, time::Instant};

type Error = Box<dyn std::error::Error>;
fn main() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().collect();
    let width = args.get(1).map(|s| s.parse()).transpose()?.unwrap_or(390);
    let height = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(844);
    let time = args
        .get(3)
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(17500.0);
    let output = args
        .get(4)
        .map(String::as_str)
        .unwrap_or("output/frame.png");
    if width == 0 || height == 0 {
        return Err("dimensions must be positive".into());
    }
    let start = Instant::now();
    let track = TrackScene::new(width, height)?;
    println!(
        "Cached layout: {:.2} ms, {} lines, {} glyphs, {} missing glyphs",
        start.elapsed().as_secs_f64() * 1000.0,
        track.lines.len(),
        track.glyph_count,
        track.missing_glyphs
    );
    let mut gpu = pollster::block_on(gpu::Gpu::new(width, height))?;
    let mut frame = vello::Scene::new();
    let protection = track.frame(time, &mut frame);
    gpu.render(&frame, protection)?;
    if let Some(parent) = Path::new(output).parent() {
        fs::create_dir_all(parent)?;
    }
    gpu.save(output)?;
    println!("PNG: {output}");
    Ok(())
}
