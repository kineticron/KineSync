// Numerical counterpart to downsample.wgsl's vertical tent. A normalized
// symmetric Gaussian and bilinear reconstruction preserve this centroid.
fn reduced_impulse(source: i32, factor: i32) -> (f64, f64) {
    let mut mass = 0.0;
    let mut moment = 0.0;
    for row in -16..16 {
        for tap in 0..2 * factor {
            if row * factor + tap - factor / 2 == source {
                let weight = f64::from((2 * tap + 1).min(4 * factor - 2 * tap - 1))
                    / f64::from(2 * factor * factor);
                mass += weight;
                moment += weight * (f64::from(row * factor) + f64::from(factor - 1) / 2.0);
            }
        }
    }
    (mass, moment)
}

#[test]
fn scrolling_blur_retains_every_pixel_and_subpixel_phase() {
    let shader = include_str!("../src/downsample.wgsl");
    assert!(shader.contains("y - sy / 2"));
    assert!(shader.contains("min(2 * y + 1, 4 * sy - 2 * y - 1)"));
    for factor in [2, 4] {
        for step in -32..=32 {
            let position = f64::from(step) / 8.0;
            let lo = position.floor() as i32;
            let fraction = position - f64::from(lo);
            let (m0, p0) = reduced_impulse(lo, factor);
            let (m1, p1) = reduced_impulse(lo + 1, factor);
            let mass = m0 * (1.0 - fraction) + m1 * fraction;
            let centroid = (p0 * (1.0 - fraction) + p1 * fraction) / mass;
            assert!((mass * f64::from(factor) - 1.0).abs() < 1e-12);
            assert!(
                (centroid - position).abs() < 1e-12,
                "factor={factor} position={position} centroid={centroid}"
            );
        }
    }
}
