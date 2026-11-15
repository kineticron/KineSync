//! Skia-parity follow scrolling.
//!
//! Spicy uses the native `withTiming` viewport tween from
//! `reference-motion.ts`/`reference-scroll.tsx`; AMLL uses the shared analytic
//! spring trajectory with per-row cascade delays from `simple-amll-motion.ts`.
//! Both are driven by native milliseconds, so playback pauses and display
//! cadence changes cannot accumulate error.
use crate::style_timing::bezier;
use crate::typography::Style;
use std::ops::Range;

pub const SPICY_MIN_DURATION_MS: f64 = 240.0;
pub const SPICY_MAX_DURATION_MS: f64 = 440.0;
pub const AMLL_MASS: f64 = 0.9;
pub const MAX_STEP_SECONDS: f64 = 0.064;
/// Skia settles the analytic spring below these thresholds.
pub const AMLL_SETTLE_POSITION: f64 = 0.01;
pub const AMLL_SETTLE_VELOCITY: f64 = 0.01;
/// Bounded trajectory history; older segments only serve delayed rows.
const MAX_SEGMENTS: usize = 8;

/// Native Spicy viewport tween duration (`spicyScrollDuration`).
pub fn spicy_duration(interval: f64, interlude: bool, distance: f64) -> f64 {
    if interlude {
        return SPICY_MAX_DURATION_MS;
    }
    let ratio = (1.0 - (interval.clamp(100.0, 800.0) - 100.0) / 700.0).powf(0.2);
    ((SPICY_MAX_DURATION_MS - ratio * 120.0) * (0.7 + 0.3 * (distance / 600.0).clamp(0.0, 1.0)))
        .clamp(SPICY_MIN_DURATION_MS, SPICY_MAX_DURATION_MS)
        .round()
}

pub fn spicy_easing(progress: f64) -> f64 {
    bezier(progress, 0.22, 0.88, 0.34, 1.0)
}

/// AMLL `amllScrollSpring` stiffness; the reference uses mass 0.9.
pub fn amll_stiffness(interval: f64, interlude: bool) -> f64 {
    let ratio = (1.0 - (interval.clamp(100.0, 800.0) - 100.0) / 700.0).powf(0.2);
    if interlude {
        90.0
    } else {
        170.0 + ratio * 50.0
    }
}

pub fn amll_damping(stiffness: f64, interlude: bool) -> f64 {
    if interlude {
        15.0
    } else {
        stiffness.sqrt() * 2.2
    }
}

pub fn amll_omega(interval: f64, interlude: bool) -> f64 {
    (amll_stiffness(interval, interlude) / AMLL_MASS).sqrt()
}

/// Skia `amllRowCascadeDelay`: rows below the first visible row start later;
/// the step shrinks after the target row, so far rows catch up.
pub fn amll_cascade_delay(first_visible: usize, target: usize, row: usize) -> f64 {
    if row <= first_visible {
        return 0.0;
    }
    let mut delay = 0.0;
    let mut step = 0.05;
    for index in first_visible..row {
        delay += step;
        if index >= target {
            step /= 1.05;
        }
    }
    delay
}

/// Immutable per-frame layout facts for one follow command.
#[derive(Clone, Debug)]
pub struct Command {
    pub offset: f64,
    pub interval: f64,
    pub interlude: bool,
    pub first_visible: usize,
    pub index: usize,
    pub visible: Range<usize>,
    pub scale: f64,
    pub style: Style,
}

/// Analytic AMLL trajectory segment, mirroring `SimpleScrollSegment`.
#[derive(Clone, Copy, Debug)]
struct Segment {
    start: f64,
    end: f64,
    omega: f64,
    c1: f64,
    c2: f64,
    shift: f64,
}

#[derive(Default, Debug)]
pub struct FollowScroll {
    style: Option<Style>,
    scale: f64,
    position: f64,
    target: f64,
    command_offset: f64,
    has_command: bool,
    /// First sample after load/track/seek teleports to the new target.
    armed: bool,
    /// Spicy viewport tween.
    from: f64,
    start_ms: Option<f64>,
    duration_ms: f64,
    /// AMLL viewport and per-row trajectory.
    timeline: f64,
    segments: Vec<Segment>,
    row_delay: Vec<f64>,
    adjust: Vec<f64>,
    last_visible: Range<usize>,
    last_first_visible: usize,
    last_index: usize,
    last_ms: Option<f64>,
    animating: bool,
    frozen: bool,
}

impl FollowScroll {
    pub fn configure(&mut self, style: Style, scale: f64, rows: usize) {
        let restyle = self.style != Some(style);
        self.style = Some(style);
        self.scale = scale;
        if self.row_delay.len() != rows {
            self.row_delay = vec![-1.0; rows];
            self.adjust = vec![0.0; rows];
            self.last_visible = 0..0;
        }
        if restyle {
            self.reset();
        }
    }

    pub fn reset(&mut self) {
        self.position = 0.0;
        self.target = 0.0;
        self.command_offset = 0.0;
        self.has_command = false;
        self.armed = true;
        self.from = 0.0;
        self.start_ms = None;
        self.duration_ms = 0.0;
        self.timeline = 0.0;
        self.segments.clear();
        self.row_delay.fill(-1.0);
        self.adjust.fill(0.0);
        self.last_visible = 0..0;
        self.last_first_visible = 0;
        self.last_index = 0;
        self.last_ms = None;
        self.animating = false;
        self.frozen = false;
    }

    /// Explicit seek/track replacement: the next sample teleports.
    pub fn snap_next(&mut self) {
        self.armed = true;
        self.start_ms = None;
        self.segments.clear();
        self.timeline = 0.0;
        self.animating = false;
    }

    pub fn position(&self) -> f64 {
        self.position
    }

    pub fn animating(&self) -> bool {
        self.animating
    }

    pub fn row_adjustments(&self) -> &[f64] {
        &self.adjust
    }

    /// Scale the relative scroll offset across a resize without a jump.
    pub fn remap(&mut self, old_target: f64, new_target: f64, ratio: f64) {
        let remap = |value: f64| new_target + (value - old_target) * ratio;
        self.position = remap(self.position);
        self.target = remap(self.target);
        self.command_offset = remap(self.command_offset);
        self.from = remap(self.from);
        self.timeline = 0.0;
        self.segments.clear();
        self.last_ms = None;
        self.animating = false;
    }

    /// Manual drag: the user owns the offset until auto-follow is resumed.
    pub fn drag(&mut self, dy: f64, max_offset: f64) {
        let next = (self.position + dy).clamp(0.0, max_offset.max(0.0));
        self.position = next;
        self.target = next;
        self.command_offset = next;
        self.has_command = false;
        self.start_ms = None;
        self.timeline = 0.0;
        self.segments.clear();
        self.last_ms = None;
        self.row_delay.fill(-1.0);
        self.adjust.fill(0.0);
        self.last_visible = 0..0;
        self.animating = false;
    }

    fn settled_spring(p: f64, v: f64) -> bool {
        p.abs() < AMLL_SETTLE_POSITION && v.abs() < AMLL_SETTLE_VELOCITY
    }

    fn retarget(&mut self, command: &Command, now_ms: f64) {
        let delta = command.offset - self.target;
        self.command_offset = command.offset;
        if command.style == Style::Spicy {
            let distance = (command.offset - self.position).abs() / self.scale.max(0.001);
            self.from = self.position;
            self.target = command.offset;
            self.start_ms = Some(now_ms);
            self.duration_ms = spicy_duration(command.interval, command.interlude, distance);
            return;
        }
        self.plan_rows(command);
        let current = self.sample_amll(self.timeline);
        let omega = amll_omega(command.interval, command.interlude);
        let p0 = current.0 + delta;
        let v0 = current.1;
        if let Some(last) = self.segments.last_mut() {
            last.end = self.timeline;
        }
        for segment in &mut self.segments {
            segment.shift += delta;
        }
        if self.segments.len() == MAX_SEGMENTS {
            self.segments.remove(0);
        }
        self.segments.push(Segment {
            start: self.timeline,
            end: f64::INFINITY,
            omega,
            c1: p0,
            c2: v0 + omega * p0,
            shift: 0.0,
        });
        self.target = command.offset;
    }

    fn plan_rows(&mut self, command: &Command) {
        self.last_first_visible = command.first_visible;
        self.last_index = command.index;
        self.row_delay.fill(-1.0);
        for index in command.visible.clone() {
            if let Some(delay) = self.row_delay.get_mut(index) {
                *delay = amll_cascade_delay(command.first_visible, command.index, index);
            }
        }
    }

    /// Skia `sampleTrajectory`: last segment integrates forward; earlier
    /// segments clamp to their end and carry the accumulated target shift.
    fn sample_amll(&self, time: f64) -> (f64, f64) {
        let Some(last) = self.segments.last() else {
            return (0.0, 0.0);
        };
        if time >= last.start {
            let elapsed = (time - last.start).max(0.0);
            let decay = (-last.omega * elapsed).exp();
            let p = (last.c1 + last.c2 * elapsed) * decay;
            let v = (last.c2 - last.omega * (last.c1 + last.c2 * elapsed)) * decay;
            return (p, v);
        }
        for segment in self.segments.iter().rev().skip(1) {
            if time >= segment.start {
                let elapsed = time.min(segment.end) - segment.start;
                let decay = (-segment.omega * elapsed).exp();
                return (
                    (segment.c1 + segment.c2 * elapsed) * decay + segment.shift,
                    (segment.c2 - segment.omega * (segment.c1 + segment.c2 * elapsed)) * decay,
                );
            }
        }
        let first = self.segments.first().expect("non-empty segments");
        (first.c1 + first.shift, 0.0)
    }

    fn advance_amll(&mut self, command: &Command, now_ms: f64) {
        let dt = self.last_ms.map_or(1.0 / 60.0, |last| {
            ((now_ms - last) / 1000.0).clamp(0.0, MAX_STEP_SECONDS)
        });
        self.last_ms = Some(now_ms);
        self.timeline += dt;
        let (viewport, velocity) = self.sample_amll(self.timeline);
        let settled = Self::settled_spring(viewport, velocity);
        let residual = if settled { 0.0 } else { viewport };
        self.position = self.target - residual;
        let mut moving = !settled;
        // Clear last frame's adjustments before filling the new visible range.
        for value in &mut self.adjust[self.last_visible.clone()] {
            *value = 0.0;
        }
        for index in command.visible.clone() {
            let delay = match self.row_delay.get(index).copied() {
                Some(delay) if delay >= 0.0 => delay,
                _ => {
                    let delay = amll_cascade_delay(self.last_first_visible, self.last_index, index);
                    if let Some(slot) = self.row_delay.get_mut(index) {
                        *slot = delay;
                    }
                    delay
                }
            };
            let (row, row_velocity) = self.sample_amll(self.timeline - delay);
            let row = if Self::settled_spring(row, row_velocity) {
                0.0
            } else {
                row
            };
            // Rows are translated by their own spring minus the shared
            // viewport residual (Skia `rowP - renderedResidual`).
            self.adjust[index] = row - residual;
            if row != 0.0 || self.adjust[index] != 0.0 {
                moving = true;
            }
        }
        self.last_visible = command.visible.clone();
        self.animating = moving;
    }

    /// Apply the current command at `now_ms`. Returns the visual scroll offset.
    pub fn sample(&mut self, command: &Command, now_ms: f64, following: bool) -> f64 {
        if !following {
            if !self.frozen {
                self.freeze();
            }
            return self.position;
        }
        self.frozen = false;
        if self.armed {
            self.position = command.offset;
            self.target = command.offset;
            self.command_offset = command.offset;
            self.from = command.offset;
            self.start_ms = None;
            self.timeline = 0.0;
            self.segments.clear();
            self.row_delay.fill(-1.0);
            self.adjust.fill(0.0);
            self.last_visible = 0..0;
            self.last_ms = None;
            self.has_command = true;
            self.armed = false;
            self.animating = false;
            return self.position;
        }
        let changed = !self.has_command || command.offset != self.command_offset;
        if changed {
            self.retarget(command, now_ms);
            self.has_command = true;
        }
        match command.style {
            Style::Spicy => {
                if let Some(start) = self.start_ms {
                    let progress = ((now_ms - start) / self.duration_ms.max(1.0)).clamp(0.0, 1.0);
                    self.position = self.from + (self.target - self.from) * spicy_easing(progress);
                    if progress >= 1.0 {
                        self.position = self.target;
                        self.start_ms = None;
                    }
                } else {
                    self.position = self.target;
                }
                self.animating = self.start_ms.is_some();
            }
            Style::Amll => self.advance_amll(command, now_ms),
        }
        self.position
    }

    /// Skia manual-scroll takeover: keep the visual offset, stop following.
    fn freeze(&mut self) {
        self.target = self.position;
        self.command_offset = self.position;
        self.has_command = false;
        self.start_ms = None;
        self.timeline = 0.0;
        self.segments.clear();
        self.last_ms = None;
        self.row_delay.fill(-1.0);
        self.adjust.fill(0.0);
        self.last_visible = 0..0;
        self.animating = false;
        self.frozen = true;
    }
}

/// Legacy baseline fixture spring, retained for the static parity harness.
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

    fn command(style: Style, offset: f64, interval: f64, index: usize, first: usize) -> Command {
        Command {
            offset,
            interval,
            interlude: false,
            first_visible: first,
            index,
            visible: 0..8,
            scale: 3.0,
            style,
        }
    }

    #[test]
    fn duration_and_easing_match_pinned_production_helper() {
        use sha2::Digest;
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../test/scroll-timing.json")).unwrap();
        let source = &data["source"];
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(source["path"].as_str().unwrap());
        assert_eq!(
            format!("{:x}", sha2::Sha256::digest(std::fs::read(path).unwrap())),
            source["sha256"].as_str().unwrap()
        );
        let durations = data["durations"].as_array().unwrap();
        assert_eq!(durations.len(), 24);
        for case in durations {
            assert_eq!(
                spicy_duration(
                    case["interval"].as_f64().unwrap(),
                    case["interlude"].as_bool().unwrap(),
                    case["distance"].as_f64().unwrap(),
                ),
                case["expected"].as_f64().unwrap()
            );
        }
        let easing = data["easing"].as_array().unwrap();
        assert_eq!(easing.len(), 7);
        for case in easing {
            assert!(
                (spicy_easing(case["progress"].as_f64().unwrap())
                    - case["expected"].as_f64().unwrap())
                .abs()
                    < 1e-12
            );
        }
    }

    #[test]
    fn spicy_first_sample_snaps_then_retargets_from_the_visual_offset() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let first = command(Style::Spicy, 300.0, 800.0, 1, 0);
        assert_eq!(scroll.sample(&first, 1_000.0, true), 300.0);
        assert!(!scroll.animating());
        // Command delta is measured from the current visual offset, not the old target.
        let next = command(Style::Spicy, 900.0, 430.0, 2, 1);
        scroll.sample(&next, 2_000.0, true);
        let partial = scroll.sample(&next, 2_000.0 + 100.0, true);
        assert!(partial > 300.0 && partial < 900.0);
        assert!(scroll.animating());
        assert_eq!(scroll.sample(&next, 2_000.0 + 1_000.0, true), 900.0);
        assert!(!scroll.animating());
        // An interlude always takes the slow 440 ms tween.
        let interlude = Command {
            interlude: true,
            ..command(Style::Spicy, 1_500.0, 800.0, 3, 2)
        };
        scroll.sample(&interlude, 4_000.0, true);
        assert!(scroll.animating());
        assert_eq!(scroll.sample(&interlude, 4_440.0, true), 1_500.0);
    }

    #[test]
    fn amll_spring_converges_and_cascades_rows_behind_the_viewport() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Amll, 3.0, 8);
        scroll.sample(&command(Style::Amll, 0.0, 800.0, 0, 0), 0.0, true);
        let target = command(Style::Amll, 600.0, 430.0, 3, 1);
        scroll.sample(&target, 1_000.0, true);
        scroll.sample(&target, 1_008.0, true);
        let adjust = scroll.row_adjustments();
        // Cascade: rows more than one screen away lag less, the target row lags
        // most, and every row is moving toward the same final offset.
        assert_eq!(
            adjust[0], 0.0,
            "rows above the first visible row do not lag"
        );
        assert_ne!(adjust[2], 0.0);
        assert_ne!(adjust[3], 0.0);
        let mut now = 1_008.0;
        for _ in 0..600 {
            now += 16.0;
            scroll.sample(&target, now, true);
        }
        assert_eq!(scroll.position(), 600.0);
        assert!(scroll.row_adjustments().iter().all(|value| *value == 0.0));
        assert!(!scroll.animating());
        assert!(amll_cascade_delay(1, 3, 0) == 0.0);
        assert!(amll_cascade_delay(1, 3, 3) > amll_cascade_delay(1, 3, 2));
    }

    #[test]
    fn manual_scroll_freezes_and_resume_animates_from_the_user_offset() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        scroll.sample(&command(Style::Spicy, 500.0, 800.0, 1, 0), 0.0, true);
        scroll.drag(-120.0, 2_000.0);
        assert_eq!(scroll.position(), 380.0);
        // Playback moves on while auto-follow is disabled: no scroll movement.
        let moved = command(Style::Spicy, 1_000.0, 800.0, 2, 1);
        assert_eq!(scroll.sample(&moved, 1_000.0, false), 380.0);
        assert_eq!(scroll.sample(&moved, 2_000.0, false), 380.0);
        // Resume eases from the user's offset toward the authoritative target.
        let resumed = scroll.sample(&moved, 2_000.0, true);
        assert!((resumed - 380.0).abs() < 1e-9);
        let middle = scroll.sample(&moved, 2_100.0, true);
        assert!(middle > 380.0 && middle < 1_000.0);
        assert_eq!(scroll.sample(&moved, 3_000.0, true), 1_000.0);
    }

    #[test]
    fn resize_remap_keeps_relative_offset_and_seek_snaps() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Amll, 3.0, 8);
        scroll.sample(&command(Style::Amll, 400.0, 800.0, 1, 0), 0.0, true);
        scroll.remap(400.0, 800.0, 2.0);
        assert_eq!(scroll.position(), 800.0);
        scroll.snap_next();
        let seek = command(Style::Amll, 1_200.0, 800.0, 2, 1);
        assert_eq!(scroll.sample(&seek, 1_000.0, true), 1_200.0);
        assert!(!scroll.animating());
    }

    #[test]
    fn legacy_baseline_spring_advances_and_snaps_on_reset() {
        let mut s = Scroll::default();
        s.sample(0.0, 0.0);
        assert_eq!(s.sample(100.0, 0.0), 0.0);
        let mut now = 0.0;
        let mut previous = 0.0;
        for _ in 0..5 {
            now += 100.0;
            previous = s.sample(100.0, now);
        }
        assert!(previous > 0.0 && previous < 100.0);
        assert_eq!(s.sample(100.0, 5_000.0), 100.0);
        assert!(!s.animating());
        s.reset();
        assert_eq!(s.sample(800.0, 5_000.0), 800.0);
    }
}
