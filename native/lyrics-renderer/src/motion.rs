//! Closed-form critically damped scroll. Native milliseconds, no fixed-step frame count.
#[derive(Default, Debug)]
pub struct Scroll {
    pub value: f64,
    velocity: f64,
    target: f64,
    previous_ms: Option<f64>,
}
impl Scroll {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn remap(&mut self, old_target: f64, new_target: f64, ratio: f64) {
        self.value = new_target + (self.value - old_target) * ratio;
        self.target = new_target + (self.target - old_target) * ratio;
        self.velocity *= ratio;
    }
    pub fn sample(&mut self, target: f64, native_ms: f64) -> f64 {
        if let Some(previous) = self.previous_ms {
            let dt = (native_ms - previous).max(0.0) / 1000.0;
            // Exact solution for a fixed target; stable across changing refresh rates
            // and long foreground gaps, with no catch-up task queue.
            let omega = 16.0;
            let displacement = self.value - self.target;
            let c = self.velocity + omega * displacement;
            let decay = (-omega * dt).exp();
            self.value = self.target + (displacement + c * dt) * decay;
            self.velocity = (self.velocity - omega * c * dt) * decay;
        } else {
            self.value = target;
        }
        self.previous_ms = Some(native_ms);
        // A new focus retargets without changing position/velocity at this instant.
        self.target = target;
        if !self.animating() {
            self.value = target;
            self.velocity = 0.0;
        }
        self.value
    }
    pub fn animating(&self) -> bool {
        (self.value - self.target).abs() > 0.05 || self.velocity.abs() > 0.5
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn trace(steps: &[f64]) -> Scroll {
        let mut s = Scroll::default();
        s.sample(0.0, 0.0);
        assert_eq!(s.sample(100.0, 0.0), 0.0); // no teleport on line change
        let mut now = 0.0;
        for dt in steps {
            now += dt;
            s.sample(100.0, now);
            assert!((0.0..=100.0).contains(&s.value));
        }
        s
    }
    #[test]
    fn variable_dt_matches_analytic_curve_and_settles() {
        let a = trace(&[100.0; 5]);
        let b = trace(&[8.0, 17.0, 40.0, 75.0, 160.0, 200.0]);
        let expected = 100.0 * (1.0 - 9.0 * (-8.0_f64).exp());
        assert!((a.value - expected).abs() < 1e-9);
        assert!((a.value - b.value).abs() < 1e-9);
        let mut long = trace(&[5000.0]);
        assert_eq!(long.value, 100.0);
        assert!(!long.animating());
        long.reset(); // explicit seek/track replacement snaps
        assert_eq!(long.sample(800.0, 5000.0), 800.0);
    }
    #[test]
    fn resize_preserves_relative_offset_and_pause_can_settle() {
        let mut s = trace(&[50.0]);
        let offset = s.value - 100.0;
        s.remap(100.0, 400.0, 2.0);
        assert!((s.value - 400.0 - offset * 2.0).abs() < 1e-9);
        s.sample(400.0, 100.0);
        assert!(s.animating());
        s.sample(400.0, 2000.0); // same song position, later native target
        assert!(!s.animating());
    }
}
