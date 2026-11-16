use lyrics_renderer::gpu::Gpu;
use vello::{
    Scene,
    kurbo::{Affine, Rect},
    peniko::{Color, Fill},
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut gpu = pollster::block_on(Gpu::new(600, 900))?;
    let mut scene = Scene::new();
    for y in (40..860).step_by(65) {
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::WHITE,
            None,
            &Rect::new(30., y as f64, 550., y as f64 + 25.),
        );
    }
    for (name, band, blur, glow) in [
        ("sharp", (0., 900.), false, false),
        ("protected", (0., 900.), true, false),
        ("near", (140., 760.), true, false),
        ("far", (350., 500.), true, false),
        ("glow", (350., 500.), true, true),
    ] {
        let mut times = vec![];
        for i in 0..12 {
            let start = std::time::Instant::now();
            gpu.render_appearance(&scene, band, blur, glow)?;
            if i >= 2 {
                times.push(start.elapsed().as_secs_f64() * 1000.);
            }
        }
        times.sort_by(f64::total_cmp);
        if let Ok(dir) = std::env::var("FILTER_CAPTURE_DIR") {
            gpu.save(&format!("{dir}/{name}.png"))?;
        }
        let pixels = gpu.read_pixels()?;
        let hash: u64 = pixels.iter().fold(0xcbf29ce484222325, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
        });
        println!(
            "{name} median_ms={:.3} max_ms={:.3} hash={hash:x}",
            times[5], times[9]
        );
    }
    Ok(())
}
