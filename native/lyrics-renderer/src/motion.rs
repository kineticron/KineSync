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

/// Draft only: enable after new source goldens, strict host/iOS and GPU/perf gates.
pub(crate) const SOURCE_SPICY_SCROLL_ENABLED: bool = false;

/// Source Spicy native viewport tween (reference-motion.ts / reference-scroll.tsx).
/// Native time continues while playback is paused; explicit seeks reset the owner.
#[derive(Default, Debug)]
pub struct SourceScroll {
    legacy: Scroll,
    tween: SpicyScroll,
}
impl SourceScroll {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn remap(&mut self, old: f64, new: f64, ratio: f64) {
        self.legacy.remap(old, new, ratio);
        self.tween.remap(old, new, ratio);
    }
    pub fn sample(
        &mut self,
        layout: &crate::scene::TrackScene,
        position: f64,
        native_ms: f64,
    ) -> f64 {
        let target = layout.scroll_target(position);
        if SOURCE_SPICY_SCROLL_ENABLED && layout.style() == Some(crate::typography::Style::Spicy) {
            let index = crate::focus(&layout.lines, position);
            let interval = if index == 0 {
                800.0
            } else {
                layout.lines[index].start - layout.lines[index - 1].start
            };
            self.tween.sample(
                target,
                interval,
                position > layout.lines[index].end,
                native_ms,
                f64::from(layout.scale),
            )
        } else {
            self.legacy.sample(target, native_ms)
        }
    }
    pub fn animating(&self) -> bool {
        self.legacy.animating() || self.tween.animating()
    }
}

#[derive(Default, Debug)]
struct SpicyScroll {
    value: f64,
    from: f64,
    target: f64,
    start: Option<f64>,
    duration: f64,
}
fn spicy_duration(interval: f64, interlude: bool, distance: f64) -> f64 {
    if interlude {
        return 440.0;
    }
    let ratio = (1.0 - (interval.clamp(100.0, 800.0) - 100.0) / 700.0).powf(0.2);
    ((440.0 - ratio * 120.0) * (0.7 + 0.3 * (distance / 600.0).clamp(0.0, 1.0)))
        .clamp(240.0, 440.0)
        .round()
}
impl SpicyScroll {
    fn remap(&mut self, old: f64, new: f64, ratio: f64) {
        self.value = new + (self.value - old) * ratio;
        self.from = new + (self.from - old) * ratio;
        self.target = new + (self.target - old) * ratio;
    }
    fn sample(&mut self, target: f64, interval: f64, interlude: bool, now: f64, dpr: f64) -> f64 {
        if let Some(start) = self.start {
            let t = ((now - start) / self.duration).clamp(0.0, 1.0);
            let eased = crate::style_timing::bezier(t, 0.22, 0.88, 0.34, 1.0);
            self.value = self.from + (self.target - self.from) * eased;
        } else {
            self.value = target;
        }
        if self.start.is_none() || target != self.target {
            self.from = self.value;
            self.target = target;
            self.start = Some(now);
            self.duration = spicy_duration(interval, interlude, (target - self.value).abs() / dpr);
        }
        self.value
    }
    fn animating(&self) -> bool {
        self.value != self.target
    }
}

#[cfg(test)]
mod source_scroll_tests {
    use super::*;
    #[test]
    fn draft_is_not_live() {
        // Runtime stays on approved ABI6 until independent source/perf validation.
        assert!(!std::hint::black_box(SOURCE_SPICY_SCROLL_ENABLED));
    }
    #[test]
    fn spicy_retargets_from_current_value_and_native_pause_settles() {
        let mut s = SpicyScroll::default();
        assert_eq!(s.sample(0.0, 800.0, false, 0.0, 1.0), 0.0);
        assert_eq!(s.sample(100.0, 800.0, false, 0.0, 1.0), 0.0);
        let moving = s.sample(100.0, 800.0, false, 100.0, 1.0);
        assert!(moving > 0.0 && moving < 100.0);
        assert_eq!(s.sample(200.0, 800.0, false, 100.0, 1.0), moving);
        // Native time advances even with the same song target / paused clock.
        assert_eq!(s.sample(200.0, 800.0, false, 1000.0, 1.0), 200.0);
        assert!(!s.animating());
        s = SpicyScroll::default(); // seek/track replacement snap
        assert_eq!(s.sample(900.0, 800.0, false, 1000.0, 1.0), 900.0);
    }
    #[test]
    fn spicy_logical_distance_and_remap_preserve_continuity() {
        assert_eq!(spicy_duration(100.0, false, 0.0), 240.0);
        assert_eq!(spicy_duration(800.0, false, 600.0), 440.0);
        assert_eq!(spicy_duration(100.0, true, 600.0), 440.0);
        let mut a = SpicyScroll::default();
        let mut b = SpicyScroll::default();
        for now in [0.0, 0.0, 17.0, 63.0, 130.0] {
            let target = if now == 0.0 && a.start.is_none() {
                0.0
            } else {
                100.0
            };
            assert!(
                (a.sample(target, 430.0, false, now, 1.0) * 3.0
                    - b.sample(target * 3.0, 430.0, false, now, 3.0))
                .abs()
                    < 1e-9
            );
        }
        let old = a.value;
        a.remap(100.0, 400.0, 2.0);
        assert!((a.value - (400.0 + (old - 100.0) * 2.0)).abs() < 1e-9);
    }
}
