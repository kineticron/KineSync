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
/// iOS `UIScrollView.DecelerationRate.normal`, applied per millisecond.
const FLING_DECELERATION: f64 = 0.998;
/// Velocity below which the fling hands over to the rebound spring (pt/ms).
const FLING_MIN_VELOCITY: f64 = 0.02;
/// Rubber-band stiffness from `UIScrollView` (`0.55`).
const RUBBER_BAND: f64 = 0.55;

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
    /// Manual scroll: raw (unbanded) offset, iOS deceleration and rebound.
    dragging: bool,
    max_offset: f64,
    viewport: f64,
    drag_raw: f64,
    fling_velocity: f64,
    fling_last_ms: Option<f64>,
    settling: bool,
    settle_velocity: f64,
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
        self.dragging = false;
        self.max_offset = 0.0;
        self.viewport = 1.0;
        self.drag_raw = 0.0;
        self.fling_velocity = 0.0;
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
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

    /// Age the analytic settled trajectory through sleep, preserving its
    /// history for the next retarget, then integrate one fresh display step.
    pub(crate) fn resume(&mut self, native_ms: f64, step_ms: f64) {
        if let Some(last) = self.last_ms {
            self.timeline += ((native_ms - last - step_ms) / 1000.0).max(0.0);
            self.last_ms = Some((native_ms - step_ms).max(0.0));
        }
        if self.fling_last_ms.is_some() {
            self.fling_last_ms = Some((native_ms - step_ms).max(0.0));
        }
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
        self.drag_raw = self.position;
        self.fling_velocity = 0.0;
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
    }

    /// iOS rubber band: resistance grows as the offset leaves `[0, max]`.
    fn rubber(distance: f64, viewport: f64) -> f64 {
        if distance <= 0.0 {
            0.0
        } else {
            let dim = viewport.max(1.0);
            (1.0 - 1.0 / (distance * RUBBER_BAND / dim + 1.0)) * dim
        }
    }

    fn unrubber(distance: f64, viewport: f64) -> f64 {
        if distance <= 0.0 {
            0.0
        } else {
            let dim = viewport.max(1.0);
            distance / (RUBBER_BAND * (1.0 - distance / dim).max(1e-6))
        }
    }

    fn band(raw: f64, max: f64, viewport: f64) -> f64 {
        if raw < 0.0 {
            -Self::rubber(-raw, viewport)
        } else if raw > max {
            max + Self::rubber(raw - max, viewport)
        } else {
            raw
        }
    }

    fn unband(position: f64, max: f64, viewport: f64) -> f64 {
        if position < 0.0 {
            -Self::unrubber(-position, viewport)
        } else if position > max {
            max + Self::unrubber(position - max, viewport)
        } else {
            position
        }
    }

    /// Manual drag: the user owns the offset until auto-follow is resumed.
    /// `dy` is in surface pixels; the offset follows the finger 1:1 inside the
    /// content and rubber-bands past either edge.
    pub fn drag(&mut self, dy: f64, max_offset: f64, viewport: f64) {
        let continuing = self.dragging;
        self.dragging = true;
        let max_offset = max_offset.max(0.0);
        self.max_offset = max_offset;
        self.viewport = viewport.max(1.0);
        // Keep the uncompressed finger travel rather than repeatedly inverting
        // a nearly saturated rubber band.
        if !continuing {
            self.drag_raw = Self::unband(self.position, max_offset, self.viewport);
        }
        self.drag_raw += dy;
        self.position = Self::band(self.drag_raw, max_offset, self.viewport);
        self.fling_velocity = 0.0;
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
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
    }

    /// Start an iOS fling after the finger lifts. `velocity` is surface pixels
    /// per millisecond in content direction (positive = content moves up).
    pub fn fling(&mut self, velocity: f64, max_offset: f64, viewport: f64) {
        self.dragging = false;
        self.max_offset = max_offset.max(0.0);
        self.viewport = viewport.max(1.0);
        self.drag_raw = Self::unband(self.position, self.max_offset, self.viewport);
        self.fling_velocity = if velocity.is_finite() { velocity } else { 0.0 };
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
        self.freeze();
        // Releasing outside an edge springs immediately, not after a multi-
        // second fling in invisible raw-offset space.
        if self.position < 0.0 || self.position > self.max_offset {
            let distance = (self.drag_raw - self.drag_raw.clamp(0.0, self.max_offset)).abs();
            let derivative = RUBBER_BAND / (1.0 + distance * RUBBER_BAND / self.viewport).powi(2);
            self.fling_velocity *= derivative;
            self.begin_settle();
        }
        self.animating = self.settling || self.fling_velocity != 0.0;
    }

    fn begin_settle(&mut self) {
        self.settling = true;
        self.settle_velocity = self.fling_velocity;
        self.fling_velocity = 0.0;
    }

    /// Advance manual deceleration/rebound by one native frame. Returns the
    /// displayed (rubber-banded) offset.
    fn advance_manual(&mut self, now_ms: f64) -> f64 {
        if self.dragging {
            return self.position;
        }
        let dt = self.fling_last_ms.map_or(
            if self.fling_velocity != 0.0 || self.settling {
                1000.0 / 120.0
            } else {
                0.0
            },
            |last| (now_ms - last).clamp(0.0, MAX_STEP_SECONDS * 1000.0),
        );
        self.fling_last_ms = Some(now_ms);
        let max = self.max_offset;
        if self.settling {
            let bound = if self.position < 0.0 {
                0.0
            } else if self.position > max {
                max
            } else {
                self.position
            };
            let displacement = self.position - bound;
            if displacement.abs() < 0.05 && self.settle_velocity.abs() < 0.005 {
                self.position = bound;
                self.settle_velocity = 0.0;
                self.settling = false;
                self.animating = false;
                return self.position;
            }
            // Critically damped rebound, mirrored from the native scroll view.
            let omega = 0.035;
            let c = self.settle_velocity + omega * displacement;
            let decay = (-omega * dt).exp();
            self.position = bound + (displacement + c * dt) * decay;
            self.settle_velocity = (self.settle_velocity - omega * c * dt) * decay;
            if (displacement < 0.0 && self.position >= bound)
                || (displacement > 0.0 && self.position <= bound)
            {
                self.position = bound;
                self.settle_velocity = 0.0;
                self.settling = false;
            }
            self.animating = self.settling;
            return self.position;
        }
        if dt > 0.0 && self.fling_velocity != 0.0 {
            // Integrate the per-millisecond exponential exactly so 60/120 Hz
            // produce the same distance, including the time of edge impact.
            let rate = FLING_DECELERATION.ln();
            let velocity = self.fling_velocity;
            let decay = (rate * dt).exp();
            let next = self.position + velocity * (decay - 1.0) / rate;
            if next < 0.0 || next > max {
                let bound = next.clamp(0.0, max);
                let impact_ms =
                    ((1.0 + rate * (bound - self.position) / velocity).ln() / rate).clamp(0.0, dt);
                self.position = bound;
                self.fling_velocity = velocity * (rate * impact_ms).exp();
                self.begin_settle();
                // Continue the remaining frame as a critically damped bounce.
                let remaining = dt - impact_ms;
                let omega = 0.035;
                let decay = (-omega * remaining).exp();
                self.position = bound + self.settle_velocity * remaining * decay;
                self.settle_velocity *= (1.0 - omega * remaining) * decay;
            } else {
                self.position = next;
                self.fling_velocity *= decay;
                if self.fling_velocity.abs() < FLING_MIN_VELOCITY {
                    self.fling_velocity = 0.0;
                }
            }
            self.drag_raw = self.position;
            self.animating = self.fling_velocity != 0.0 || self.settling;
        } else if self.position < 0.0 || self.position > max {
            self.begin_settle();
            self.animating = true;
        }
        self.position
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
            return self.advance_manual(now_ms);
        }
        if self.frozen {
            // Momentum/rebound may have moved since freeze() captured the target.
            // Rebase the follow trajectory on the last displayed offset, not the
            // fling's starting offset, and start the spring at zero elapsed time.
            self.freeze();
            self.drag_raw = Self::unband(self.position, self.max_offset, self.viewport);
            self.last_ms = Some(now_ms);
        }
        self.frozen = false;
        self.dragging = false;
        self.fling_velocity = 0.0;
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
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
        scroll.drag(-120.0, 2_000.0, 800.0);
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
    fn manual_drag_tracks_one_to_one_and_rubber_bands_at_the_edges() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let command = command(Style::Spicy, 0.0, 800.0, 0, 0);
        scroll.sample(&command, 0.0, true);
        scroll.drag(120.0, 1_000.0, 800.0);
        assert_eq!(scroll.position(), 120.0);
        scroll.drag(-40.0, 1_000.0, 800.0);
        assert_eq!(scroll.position(), 80.0);
        scroll.drag(-200.0, 1_000.0, 800.0);
        assert!(scroll.position() < 0.0 && scroll.position() > -120.0);
        // No finger velocity at release: the rubber band rebounds to the edge.
        scroll.fling(0.0, 1_000.0, 800.0);
        let mut now = 0.0;
        for _ in 0..120 {
            now += 16.0;
            scroll.sample(&command, now, false);
        }
        assert!(scroll.position().abs() < 0.05);
    }

    #[test]
    fn overscroll_holds_under_the_finger_and_rebounds_gradually() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let command = command(Style::Spicy, 0.0, 800.0, 0, 0);
        scroll.sample(&command, 0.0, true);
        scroll.drag(-200.0, 1000.0, 800.0);
        let held = scroll.position();
        for now in [16.0, 32.0, 48.0] {
            assert_eq!(scroll.sample(&command, now, false), held);
        }
        scroll.fling(0.0, 1000.0, 800.0);
        scroll.sample(&command, 64.0, false);
        let rebound = scroll.sample(&command, 80.0, false);
        assert!(
            rebound > held && rebound < 0.0,
            "rebound must animate, not snap"
        );
    }

    #[test]
    fn fling_decays_at_the_ios_rate_and_settles() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let command = command(Style::Spicy, 0.0, 800.0, 0, 0);
        scroll.sample(&command, 0.0, true);
        scroll.fling(3.0, 10_000.0, 800.0);
        let first = scroll.sample(&command, 1000.0 / 120.0, false);
        let second = scroll.sample(&command, 2000.0 / 120.0, false);
        assert!(first > 0.0);
        assert!(second > first);
        assert!(second - first < first, "deceleration must shrink each step");
        let mut now = 32.0;
        for _ in 0..1_000 {
            now += 16.0;
            scroll.sample(&command, now, false);
        }
        assert!(!scroll.animating());
        assert!(scroll.position() > second);
    }

    #[test]
    fn repeated_drag_has_finite_edges_and_release_rebounds_immediately() {
        for direction in [-1.0, 1.0] {
            let mut scroll = FollowScroll::default();
            scroll.configure(Style::Spicy, 3.0, 8);
            let cmd = command(Style::Spicy, 0.0, 800.0, 0, 0);
            scroll.sample(&cmd, 0.0, true);
            for _ in 0..1000 {
                scroll.drag(direction * 100.0, 1000.0, 800.0);
                assert!(scroll.position() > -800.0 && scroll.position() < 1800.0);
            }
            scroll.fling(direction * 10.0, 1000.0, 800.0);
            assert!(scroll.settling);
            assert_eq!(scroll.fling_velocity, 0.0);
            for frame in 0..240 {
                scroll.sample(&cmd, f64::from(frame) * 1000.0 / 120.0, false);
            }
            assert_eq!(
                scroll.position(),
                if direction < 0.0 { 0.0 } else { 1000.0 }
            );
            assert!(!scroll.animating());
        }
    }

    #[test]
    fn fling_distance_is_display_cadence_independent() {
        let run = |dt: f64| {
            let mut scroll = FollowScroll::default();
            scroll.configure(Style::Spicy, 3.0, 8);
            let cmd = command(Style::Spicy, 500.0, 800.0, 0, 0);
            scroll.sample(&cmd, 0.0, true);
            scroll.fling(1.0, 10000.0, 800.0);
            // Establish the same initial display sample for both cadences.
            scroll.sample(&cmd, 0.0, false);
            let mut now = 0.0;
            while now < 1000.0 - 1e-6 {
                now += dt;
                scroll.sample(&cmd, now, false);
            }
            scroll.position()
        };
        assert!((run(1000.0 / 60.0) - run(1000.0 / 120.0)).abs() < 1e-9);
    }

    #[test]
    fn momentum_bounces_at_either_edge_without_waiting_for_deceleration() {
        for velocity in [-3.0, 3.0] {
            let mut scroll = FollowScroll::default();
            scroll.configure(Style::Spicy, 3.0, 8);
            let cmd = command(Style::Spicy, 500.0, 800.0, 0, 0);
            scroll.sample(&cmd, 0.0, true);
            scroll.fling(velocity, 1000.0, 800.0);
            for frame in 0..60 {
                scroll.sample(&cmd, f64::from(frame) * 8.0, false);
            }
            assert!(scroll.settling || !scroll.animating());
            assert_eq!(scroll.fling_velocity, 0.0);
            for frame in 60..300 {
                scroll.sample(&cmd, f64::from(frame) * 8.0, false);
            }
            assert_eq!(scroll.position(), if velocity < 0.0 { 0.0 } else { 1000.0 });
            assert!(!scroll.animating());
        }
    }

    #[test]
    fn return_during_fling_or_rebound_preserves_offset_and_stops_momentum() {
        for style in [Style::Amll, Style::Spicy] {
            for overscroll in [false, true] {
                let mut scroll = FollowScroll::default();
                scroll.configure(style, 3.0, 8);
                let target = command(style, 500.0, 800.0, 1, 0);
                scroll.sample(&target, 0.0, true);
                scroll.drag(if overscroll { -800.0 } else { 120.0 }, 2000.0, 800.0);
                scroll.fling(if overscroll { 0.0 } else { 3.0 }, 2000.0, 800.0);
                scroll.sample(&target, 16.0, false);
                let before = scroll.sample(&target, 32.0, false);
                assert!(scroll.fling_velocity != 0.0 || scroll.settling);
                assert!((scroll.sample(&target, 48.0, true) - before).abs() < 1e-9);
                assert_eq!(scroll.fling_velocity, 0.0);
                assert_eq!(scroll.settle_velocity, 0.0);
                assert!(!scroll.settling);
                assert!(!scroll.dragging);
                assert!(scroll.fling_last_ms.is_none());
                assert!(scroll.animating(), "return must keep native frames awake");
                let next = scroll.sample(&target, 49.0, true);
                assert!((next - before).abs() < (target.offset - before).abs() * 0.02);
                assert!((target.offset - next).abs() < (target.offset - before).abs());
                for frame in 1..600 {
                    scroll.sample(&target, 49.0 + f64::from(frame) * 16.0, true);
                }
                assert_eq!(scroll.position(), target.offset);
                assert!(!scroll.animating(), "return must eventually go idle");
            }
        }
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
