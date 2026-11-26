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
const AMLL_RETURN_MIN_MS: f64 = 500.0;
const AMLL_RETURN_MAX_MS: f64 = 700.0;
/// iOS `UIScrollView.DecelerationRate.normal`, applied per millisecond.
const FLING_DECELERATION: f64 = 0.998;
/// Velocity below which the fling hands over to the rebound spring (pt/ms).
const FLING_MIN_VELOCITY: f64 = 0.02;
/// Rubber-band stiffness from `UIScrollView` (`0.55`).
const RUBBER_BAND: f64 = 0.55;

/// Fraction of the viewport around the active-line target that still belongs
/// to auto-follow when a manual scroll ends.
pub const FOLLOW_RELEASE_FRACTION: f64 = 1.0 / 3.0;
pub const ESCAPE_GRACE_MS: f64 = 1_000.0;

#[derive(Default, Debug)]
struct EscapeGrace {
    until: f64,
    escaped: bool,
    returning: bool,
    input_target: Option<f64>,
}

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
    let count = row.saturating_sub(first_visible);
    let linear = count.min(target.saturating_sub(first_visible));
    let tail = (count - linear) as f64;
    // The remaining delays form a geometric sum with ratio 1 / 1.05.
    0.05 * linear as f64 - 1.05 * (-tail * 0.05_f64.ln_1p()).exp_m1()
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

#[derive(Clone, Copy, Debug)]
struct AmllReturn {
    deadline_playback: Option<f64>,
    from: f64,
    target: f64,
    start_ms: f64,
    end_ms: f64,
    velocity: f64,
    brake_ms: f64,
}

impl AmllReturn {
    /// With a zero terminal slope, this range makes the cubic monotone.
    fn can_retarget(velocity: f64, duration_ms: f64, distance: f64) -> bool {
        let tangent = velocity * duration_ms;
        tangent * distance >= 0.0 && tangent.abs() <= 3.0 * distance.abs()
    }

    fn pose(self, now_ms: f64) -> (f64, f64) {
        let elapsed = (now_ms - self.start_ms).max(0.0);
        if elapsed < self.brake_ms {
            let progress = elapsed / self.brake_ms;
            let travel = self.velocity * elapsed * (1.0 - 0.5 * progress);
            return (self.from + travel, self.velocity * (1.0 - progress));
        }
        let duration = self.end_ms - self.start_ms - self.brake_ms;
        let t = ((elapsed - self.brake_ms) / duration).min(1.0);
        if t == 1.0 {
            return (self.target, 0.0);
        }
        let from = self.from + 0.5 * self.velocity * self.brake_ms;
        let velocity = if self.brake_ms > 0.0 {
            0.0
        } else {
            self.velocity
        };
        let distance = self.target - from;
        let position =
            from + distance * t * t * (3.0 - 2.0 * t) + velocity * duration * t * (1.0 - t).powi(2);
        let velocity =
            6.0 * distance * t * (1.0 - t) / duration + velocity * (1.0 - t) * (1.0 - 3.0 * t);
        (position, velocity)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ReturnFrame {
    pub position: f64,
    next: Option<AmllReturn>,
}

impl ReturnFrame {
    pub(crate) fn project_deadline(&mut self, project: impl FnOnce(f64) -> f64) {
        if let Some(curve) = &mut self.next {
            curve.deadline_playback = Some(project(curve.end_ms));
        }
    }
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
    explicit_snap: bool,
    /// Spicy viewport tween.
    from: f64,
    start_ms: Option<f64>,
    duration_ms: f64,
    /// AMLL viewport and per-row trajectory.
    timeline: f64,
    segments: Vec<Segment>,
    adjust: Vec<f64>,
    last_visible: Range<usize>,
    last_first_visible: usize,
    last_index: usize,
    last_ms: Option<f64>,
    amll_return: Option<AmllReturn>,
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
    escape: EscapeGrace,
}

impl FollowScroll {
    pub fn configure(&mut self, style: Style, scale: f64, rows: usize) {
        let restyle = self.style != Some(style);
        self.style = Some(style);
        self.scale = scale;
        if self.adjust.len() != rows {
            self.amll_return = None;
            self.adjust = vec![0.0; rows];
            self.last_visible = 0..0;
        }
        if restyle {
            self.reset();
        }
    }

    pub fn reset(&mut self) {
        self.escape.returning = false;
        self.escape.input_target = None;
        self.position = 0.0;
        self.target = 0.0;
        self.command_offset = 0.0;
        self.has_command = false;
        self.armed = true;
        self.explicit_snap = false;
        self.from = 0.0;
        self.start_ms = None;
        self.duration_ms = 0.0;
        self.timeline = 0.0;
        self.segments.clear();

        self.adjust[self.last_visible.clone()].fill(0.0);
        self.last_visible = 0..0;
        self.last_first_visible = 0;
        self.last_index = 0;
        self.last_ms = None;
        self.amll_return = None;
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
        self.amll_return = None;
        self.armed = true;
        self.explicit_snap = true;
        self.start_ms = None;
        self.segments.clear();
        self.timeline = 0.0;
        self.animating = false;
    }

    pub fn position(&self) -> f64 {
        self.position
    }

    /// Touch input alone can authorize a return. Targets moving with playback,
    /// release, inertia and rebound never create return intent.
    pub(crate) fn note_manual_input(&mut self, dy: f64, target: Option<f64>, now: f64) {
        if !self.dragging {
            self.escape.returning = false;
        }
        let Some(target) = target else {
            self.escape.returning = false;
            return;
        };
        if dy.abs() < 0.5 * self.scale.max(1.0) {
            return;
        }
        let toward = dy * (target - self.position) > 0.0
            && (self.position + dy - target).abs() < (self.position - target).abs();
        if toward {
            self.escape.returning = true;
            self.escape.input_target = Some(target);
        } else {
            if !self.escape.escaped {
                self.escape.until = now + ESCAPE_GRACE_MS;
                self.escape.escaped = true;
            }
            self.escape.returning = false;
        }
    }

    pub(crate) fn resume_follow(&mut self) {
        self.escape = EscapeGrace::default();
    }

    pub(crate) fn explicit_snap_pending(&self) -> bool {
        self.explicit_snap
    }

    pub(crate) fn set_manual_bounds(&mut self, max_offset: f64, viewport: f64) {
        if self.amll_return.is_some() && !self.frozen && !self.dragging {
            self.freeze();
        }
        self.max_offset = max_offset.max(0.0);
        self.viewport = viewport.max(1.0);
    }

    /// Restore a mapped manual viewport after replacing same-track geometry.
    /// Ownership stays manual, but old-layout momentum must not cross layouts.
    pub(crate) fn restore_manual(&mut self, position: f64, max: f64, viewport: f64) {
        self.amll_return = None;
        self.position = position.clamp(0.0, max);
        self.armed = false;
        self.freeze();
        self.max_offset = max;
        self.viewport = viewport;
        self.drag_raw = self.position;
    }

    /// Update the manual coordinate system without changing ownership or
    /// momentum. Preserve any rubber-band displacement during measurement.
    pub(crate) fn relocate_manual(&mut self, position: f64, max: f64, viewport: f64) {
        if self.position != position || self.max_offset != max || self.viewport != viewport {
            self.position = position;
            self.max_offset = max;
            self.viewport = viewport;
            self.drag_raw = Self::unband(position, max, viewport);
        }
    }

    pub fn animating(&self) -> bool {
        self.animating || self.amll_return.is_some()
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
        self.amll_return = None;
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
        if self.amll_return.take().is_some() {
            self.frozen = true;
        }
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

        self.adjust[self.last_visible.clone()].fill(0.0);
        self.last_visible = 0..0;
        self.animating = false;
    }

    /// End a manual scroll and decide whether follow should take ownership
    /// back. Only the release path may recapture, so an active drag never
    /// pulls the viewport away from the finger. `target` is the active-line
    /// target from a ready layout. Without a layout there is no trustworthy
    /// target, so the release stays manual. A near release also requires a
    /// deliberate return input, including during escape grace, with no away velocity.
    pub fn release(
        &mut self,
        velocity: f64,
        max_offset: f64,
        viewport: f64,
        target: Option<f64>,
        _now: f64,
    ) -> bool {
        let returning = self.escape.returning;
        self.escape.returning = false;
        self.fling(velocity, max_offset, viewport);
        let Some(target) = target else {
            return false;
        };
        let threshold = self.viewport * FOLLOW_RELEASE_FRACTION;
        returning
            && self
                .escape
                .input_target
                .is_some_and(|input| (input - target).abs() <= 1.0)
            && (self.position - target).abs() <= threshold
            && velocity * (self.position - target) <= 0.0
    }

    /// Start an iOS fling after the finger lifts. `velocity` is surface pixels
    /// per millisecond in content direction (positive = content moves up).
    pub fn fling(&mut self, velocity: f64, max_offset: f64, viewport: f64) {
        self.max_offset = max_offset.max(0.0);
        self.viewport = viewport.max(1.0);
        self.drag_raw = Self::unband(self.position, self.max_offset, self.viewport);
        self.fling_velocity = if velocity.is_finite() { velocity } else { 0.0 };
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
        self.freeze();
        self.dragging = false;
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

    /// Advance manual deceleration/rebound by one native frame.
    fn advance_manual(&mut self, now_ms: f64) {
        if self.dragging {
            return;
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
                return;
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
            return;
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
    }

    fn row_delay(&self, index: usize) -> f64 {
        amll_cascade_delay(self.last_first_visible, self.last_index, index)
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
        if self.segments.is_empty() {
            self.position = self.target;
            self.adjust[self.last_visible.clone()].fill(0.0);
            self.last_visible = 0..0;
            self.animating = false;
            return;
        }
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
            #[cfg(test)]
            crate::scene::count_frame_work(|work| work.cascade_rows += 1);
            let delay = self.row_delay(index);
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

    fn return_duration(&self, distance: f64) -> f64 {
        let viewports = distance.abs() / self.viewport;
        AMLL_RETURN_MIN_MS
            + (AMLL_RETURN_MAX_MS - AMLL_RETURN_MIN_MS) * ((viewports - 1.0) / 7.0).clamp(0.0, 1.0)
    }

    pub(crate) fn may_prepare_return(&self) -> bool {
        !self.armed
            && self.style == Some(Style::Amll)
            && (self.frozen || self.amll_return.is_some())
    }

    /// The native owner supplies stable row coordinates while retaining pixel
    /// distances for the release threshold and duration.
    pub(crate) fn preview_return(&self, target: f64, now_ms: f64) -> Option<ReturnFrame> {
        self.preview_return_in(target, self.position, target - self.position, 1.0, now_ms)
    }

    pub(crate) fn preview_return_in(
        &self,
        target: f64,
        position: f64,
        pixel_distance: f64,
        pixels_per_unit: f64,
        now_ms: f64,
    ) -> Option<ReturnFrame> {
        if !self.may_prepare_return() {
            return None;
        }
        let Some(returning) = self.amll_return else {
            if !self.frozen || pixel_distance.abs() <= self.viewport {
                return None;
            }
            let duration = self.return_duration(pixel_distance);
            let velocity = if self.settling {
                self.settle_velocity
            } else {
                self.fling_velocity
            } / pixels_per_unit;
            return Some(ReturnFrame {
                position,
                next: Some(AmllReturn {
                    deadline_playback: None,
                    from: position,
                    target,
                    start_ms: now_ms,
                    end_ms: now_ms + duration,
                    velocity,
                    brake_ms: Self::return_brake(
                        velocity,
                        duration,
                        target - position,
                        self.viewport / pixels_per_unit,
                    ),
                }),
            });
        };

        let (position, velocity) = returning.pose(now_ms);
        let remaining = returning.end_ms - now_ms;
        if remaining <= 0.0 {
            // The terminal frame owns the newest prepared destination.
            return Some(ReturnFrame {
                position: target,
                next: None,
            });
        }
        let next = if (target - returning.target).abs() > 1e-7 {
            // Reversal starts with the sampled tangent. Brake away from the
            // new endpoint briefly, then use the rest of the same deadline.
            Some(AmllReturn {
                deadline_playback: returning.deadline_playback,
                from: position,
                target,
                start_ms: now_ms,
                end_ms: returning.end_ms,
                velocity,
                brake_ms: Self::return_brake(
                    velocity,
                    remaining,
                    target - position,
                    self.viewport / pixels_per_unit,
                ),
            })
        } else {
            Some(returning)
        };
        Some(ReturnFrame { position, next })
    }

    fn return_brake(velocity: f64, remaining: f64, distance: f64, viewport: f64) -> f64 {
        if AmllReturn::can_retarget(velocity, remaining, distance) {
            0.0
        } else {
            (0.1 * viewport / velocity.abs())
                .min(40.0)
                .min(remaining / 3.0)
        }
    }

    pub(crate) fn return_deadline(&self) -> Option<f64> {
        self.amll_return.map(|curve| curve.end_ms)
    }

    pub(crate) fn return_deadline_playback(&self) -> Option<f64> {
        self.amll_return?.deadline_playback
    }

    pub(crate) fn returning(&self) -> bool {
        self.amll_return.is_some()
    }

    pub(crate) fn return_tangent(&self) -> f64 {
        match (self.amll_return, self.last_ms) {
            (Some(curve), Some(time)) => curve.pose(time).1,
            _ => 0.0,
        }
    }

    pub(crate) fn rebase_return(&mut self, position: f64, velocity: f64, pixels_per_unit: f64) {
        let (Some(curve), Some(time)) = (&mut self.amll_return, self.last_ms) else {
            return;
        };
        let (old_position, old_velocity) = curve.pose(time);
        if (position - old_position).abs() < 1e-8 && (velocity - old_velocity).abs() < 1e-8 {
            return;
        }
        let remaining = curve.end_ms - time;
        if remaining <= 0.0 {
            return;
        }
        curve.from = position;
        curve.velocity = velocity;
        curve.start_ms = time;
        curve.brake_ms = Self::return_brake(
            velocity,
            remaining,
            curve.target - position,
            self.viewport / pixels_per_unit,
        );
    }

    pub(crate) fn relocate_return(&mut self, position: f64, viewport: f64) {
        self.position = position;
        self.viewport = viewport.max(1.0);
    }

    pub(crate) fn commit_return(&mut self, frame: ReturnFrame, now_ms: f64) -> f64 {
        if self.frozen {
            self.freeze();
        }
        self.frozen = false;
        self.dragging = false;
        self.fling_velocity = 0.0;
        self.fling_last_ms = None;
        self.settling = false;
        self.settle_velocity = 0.0;
        self.position = frame.position;
        self.amll_return = frame.next;
        self.target = frame.position;
        self.command_offset = self.target;
        self.has_command = true;
        self.last_ms = Some(now_ms);
        self.animating = false;
        self.position
    }

    /// Apply the current command at `now_ms`. Returns the visual scroll offset.
    pub fn sample(&mut self, command: &Command, now_ms: f64, following: bool) -> f64 {
        if !following {
            if !self.frozen {
                self.freeze();
            }
            self.advance_manual(now_ms);
            return self.position;
        }
        // A frozen fling's velocity belongs to the first return sample.
        if let Some(frame) = self.preview_return(command.offset, now_ms) {
            return self.commit_return(frame, now_ms);
        }
        let was_frozen = self.frozen;
        if was_frozen {
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
            self.amll_return = None;
            self.position = command.offset;
            self.target = command.offset;
            self.command_offset = command.offset;
            self.from = command.offset;
            self.start_ms = None;
            self.timeline = 0.0;
            self.segments.clear();

            self.adjust[self.last_visible.clone()].fill(0.0);
            self.last_visible = 0..0;
            self.last_ms = None;
            self.has_command = true;
            self.armed = false;
            self.explicit_snap = false;
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
        self.amll_return = None;
        self.target = self.position;
        self.command_offset = self.position;
        self.has_command = false;
        self.start_ms = None;
        self.timeline = 0.0;
        self.segments.clear();
        self.last_ms = None;

        self.adjust[self.last_visible.clone()].fill(0.0);
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
    fn tiny_drag_after_track_switch_and_idle_keeps_the_motion_baseline() {
        for style in [Style::Amll, Style::Spicy] {
            let mut scroll = FollowScroll::default();
            scroll.configure(style, 1.0, 8);
            let old = command(style, 300.0, 800.0, 1, 0);
            scroll.sample(&old, 0.0, true);
            scroll.drag(180.0, 4_000.0, 640.0);
            scroll.fling(3.0, 4_000.0, 640.0);
            scroll.sample(&old, 16.0, false);
            assert!(scroll.animating());

            scroll.reset();
            let fresh = command(style, 1_200.0, 800.0, 2, 1);
            scroll.sample(&fresh, 100.0, true);
            let displayed = scroll.sample(&fresh, 116.0, true);
            scroll.resume(60_100.0, 16.0);
            scroll.set_manual_bounds(4_000.0, 640.0);
            scroll.drag(5.0, 4_000.0, 640.0);
            let input = scroll.position() - displayed;
            let frame = scroll.sample(&fresh, 60_100.0, false) - displayed;
            println!("{style:?} motion-only, input={input:+.3}px first_frame={frame:+.3}px");
            assert_eq!((input, frame), (5.0, 5.0));

            scroll.fling(0.0, 4_000.0, 640.0);
            assert_eq!(scroll.sample(&fresh, 61_100.0, false) - displayed, 5.0);
        }
    }

    #[test]
    fn tiny_drag_keeps_its_rubber_band_when_manual_geometry_moves() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 1.0, 8);
        let cmd = command(Style::Spicy, 1_000.0, 800.0, 2, 1);
        scroll.sample(&cmd, 0.0, true);
        scroll.drag(40.0, 1_000.0, 640.0);
        scroll.relocate_manual(scroll.position() + 80.0, 1_080.0, 640.0);
        scroll.drag(5.0, 1_080.0, 640.0);
        assert!((scroll.position() - FollowScroll::band(1_125.0, 1_080.0, 640.0)).abs() < 1e-9);
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

    const RETURN_START_MS: f64 = 1_000.0;
    const RETURN_VIEWPORT: f64 = 800.0;

    fn return_command(style: Style, target: f64, position: f64) -> Command {
        // Model uniform 80 px rows and the scene's position-based overscan.
        let first = (position / 80.0) as usize;
        Command {
            visible: first.saturating_sub(12)..(first + 20).min(240),
            ..command(style, target, 800.0, (target / 80.0) as usize, first)
        }
    }

    fn manual_return(style: Style, target: f64, manual: f64) -> (FollowScroll, Command) {
        let mut scroll = FollowScroll::default();
        scroll.configure(style, 3.0, 240);
        scroll.sample(&return_command(style, target, target), 0.0, true);
        scroll.drag(manual - target, 19_200.0, RETURN_VIEWPORT);
        scroll.fling(0.0, 19_200.0, RETURN_VIEWPORT);
        let command = return_command(style, target, manual);
        assert_eq!(scroll.sample(&command, 900.0, false), manual);
        (scroll, command)
    }

    fn assert_return_cleared(scroll: &FollowScroll) {
        assert!(scroll.amll_return.is_none());
        assert!(scroll.segments.is_empty());
        assert!(scroll.row_adjustments().iter().all(|&adjust| adjust == 0.0));
        assert!(!scroll.animating());
    }

    #[test]
    fn continuous_return_traverses_the_full_distance_at_both_cadences() {
        for distance in [801.0, 10_400.0] {
            for direction in [-1.0, 1.0] {
                let (manual, target) = if direction > 0.0 {
                    (1_600.0, 1_600.0 + distance)
                } else {
                    (1_600.0 + distance, 1_600.0)
                };
                let mut midpoints = Vec::new();
                for hz in [60, 120] {
                    let (mut scroll, command) = manual_return(Style::Amll, target, manual);
                    assert_eq!(scroll.sample(&command, RETURN_START_MS, true), manual);
                    let curve = scroll.amll_return.unwrap();
                    assert_eq!(curve.pose(RETURN_START_MS), (manual, 0.0));
                    let duration = curve.end_ms - curve.start_ms;
                    assert!((500.0..=700.0).contains(&duration));
                    assert_eq!(duration == 700.0, distance > 8.0 * RETURN_VIEWPORT);
                    let mut previous = manual;
                    for frame in 1..=hz {
                        let now = (RETURN_START_MS + f64::from(frame) * 1000.0 / f64::from(hz))
                            .min(curve.end_ms);
                        let position = scroll.sample(&command, now, true);
                        let direction = (target - manual).signum();
                        assert!((position - previous) * direction >= 0.0);
                        assert!((target - position) * direction >= 0.0);
                        assert!(scroll.row_adjustments().iter().all(|&offset| offset == 0.0));
                        if frame == hz / 4 {
                            midpoints.push(position);
                            assert!(position != manual && position != target);
                        }
                        if now == curve.end_ms {
                            assert_eq!(curve.pose(now), (target, 0.0));
                            break;
                        }
                        previous = position;
                    }
                    assert_eq!(scroll.position(), target);
                    assert_return_cleared(&scroll);
                }
                assert_eq!(midpoints[0], midpoints[1]);
            }
        }
    }

    #[test]
    fn amll_return_threshold_is_strict_and_near_returns_keep_the_original_spring() {
        for distance in [120.0, 799.9, 800.0, 800.1] {
            let target = 2_400.0;
            let manual = target + distance;
            let (mut scroll, cmd) = manual_return(Style::Amll, target, manual);
            let initial = scroll.sample(&cmd, RETURN_START_MS, true);
            if distance > RETURN_VIEWPORT {
                assert_eq!(initial, manual);
                assert!(scroll.amll_return.is_some());
            } else {
                assert_eq!(initial, manual);
                assert!(scroll.amll_return.is_none());
                let elapsed = 0.016;
                let omega = amll_omega(800.0, false);
                let expected =
                    target + distance * (1.0 + omega * elapsed) * (-omega * elapsed).exp();
                let position = scroll.sample(&cmd, RETURN_START_MS + 16.0, true);
                assert!((position - expected).abs() < 1e-9);
                assert!((scroll.row_delay(cmd.first_visible + 1) - 0.05).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn ordinary_far_amll_target_jump_keeps_the_original_spring_and_cascade() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Amll, 3.0, 240);
        scroll.set_manual_bounds(19_200.0, RETURN_VIEWPORT);
        let from = 1_600.0;
        let target = 12_000.0;
        scroll.sample(&return_command(Style::Amll, from, from), 0.0, true);
        let cmd = return_command(Style::Amll, target, from);
        let elapsed = 1.0 / 60.0;
        let omega = amll_omega(800.0, false);
        let expected =
            target - (target - from) * (1.0 + omega * elapsed) * (-omega * elapsed).exp();
        assert!((scroll.sample(&cmd, RETURN_START_MS, true) - expected).abs() < 1e-9);
        assert_eq!(scroll.row_delay(cmd.first_visible + 3), 0.05 * 3.0);
        assert!(scroll.amll_return.is_none());
        assert!(scroll.sample(&cmd, RETURN_START_MS + 480.0, true) < target);
    }

    #[test]
    fn far_spicy_return_keeps_the_original_tween() {
        let manual = 1_600.0;
        let target = 12_000.0;
        let (mut scroll, cmd) = manual_return(Style::Spicy, target, manual);
        let duration = spicy_duration(cmd.interval, cmd.interlude, (target - manual) / cmd.scale);
        assert_eq!(scroll.sample(&cmd, RETURN_START_MS, true), manual);
        let midpoint = manual + (target - manual) * spicy_easing(0.5);
        assert_eq!(
            scroll.sample(&cmd, RETURN_START_MS + duration / 2.0, true),
            midpoint
        );
        assert_eq!(
            scroll.sample(&cmd, RETURN_START_MS + duration, true),
            target
        );
        assert_return_cleared(&scroll);
    }

    #[test]
    fn continuous_return_uses_native_time_and_retries_do_not_advance_it() {
        let (mut scroll, cmd) = manual_return(Style::Amll, 12_000.0, 1_600.0);
        let displayed = scroll.sample(&cmd, RETURN_START_MS, true);
        let now = RETURN_START_MS + 240.0;
        let preview = scroll.preview_return(cmd.offset, now).unwrap();
        assert_eq!(scroll.position(), displayed);
        assert_eq!(
            scroll.preview_return(cmd.offset, now).unwrap().position,
            preview.position
        );
        assert_eq!(scroll.sample(&cmd, now, true), preview.position);
        assert_eq!(scroll.sample(&cmd, now, true), preview.position);
        assert!(preview.position > displayed && preview.position < cmd.offset);
        scroll.resume(20_000.0, 16.0);
        assert_eq!(scroll.sample(&cmd, 20_000.0, true), cmd.offset);
        assert_return_cleared(&scroll);
    }

    #[test]
    fn terminal_return_sample_uses_a_new_target_received_at_the_deadline() {
        let (mut scroll, original) = manual_return(Style::Amll, 12_000.0, 1_600.0);
        scroll.sample(&original, RETURN_START_MS, true);
        let deadline = scroll.return_deadline().unwrap();
        scroll.sample(&original, deadline - 8.0, true);
        let latest = return_command(Style::Amll, 12_072.0, scroll.position());
        assert_eq!(scroll.sample(&latest, deadline, true), latest.offset);
        assert_return_cleared(&scroll);
    }

    #[test]
    fn closed_form_cascade_preserves_the_reference_accumulation() {
        for (first, target) in [(0, 0), (3, 1), (1, 36_000), (10, 40)] {
            for row in [0, 4, 12, 42, 35_999, 36_001, 36_100] {
                let (mut delay, mut step) = (0.0, 0.05);
                for index in first..row {
                    delay += step;
                    if index >= target {
                        step /= 1.05;
                    }
                }
                assert!((amll_cascade_delay(first, target, row) - delay).abs() < 1e-8);
            }
        }
    }

    #[test]
    fn continuous_return_reverses_from_the_sampled_tangent_at_the_original_deadline() {
        for fraction in [0.3, 0.5, 0.8] {
            let (mut scroll, cmd) = manual_return(Style::Amll, 12_000.0, 1_600.0);
            scroll.sample(&cmd, RETURN_START_MS, true);
            let original = scroll.amll_return.unwrap();
            let now = original.start_ms + (original.end_ms - original.start_ms) * fraction;
            let pose = original.pose(now);
            let reversed = return_command(Style::Amll, 1_600.0, pose.0);
            assert_eq!(scroll.sample(&reversed, now, true), pose.0);
            let curve = scroll.amll_return.unwrap();
            assert_eq!(curve.pose(now), pose);
            assert_eq!(curve.end_ms, original.end_ms);
            assert_eq!(curve.pose(original.end_ms), (reversed.offset, 0.0));
            assert!(curve.pose(original.end_ms - 1.0).0 > reversed.offset);
            assert_eq!(
                scroll.sample(&reversed, original.end_ms, true),
                reversed.offset
            );
            assert_return_cleared(&scroll);
        }
    }

    #[test]
    fn continuous_return_takes_fling_velocity_before_clearing_manual_state() {
        for velocity in [-3.0, 3.0] {
            let (mut scroll, cmd) = manual_return(Style::Amll, 12_000.0, 1_600.0);
            scroll.fling(velocity, 19_200.0, RETURN_VIEWPORT);
            let displayed = scroll.position();
            assert_eq!(scroll.sample(&cmd, RETURN_START_MS, true), displayed);
            let curve = scroll.amll_return.unwrap();
            assert_eq!(curve.pose(RETURN_START_MS).1, velocity);
            assert_eq!(scroll.fling_velocity, 0.0);
            if velocity < 0.0 {
                assert!(curve.brake_ms > 0.0);
                let (position, velocity) = curve.pose(RETURN_START_MS + curve.brake_ms + 1e-9);
                assert!(displayed - position <= RETURN_VIEWPORT * 0.05 + 1e-7);
                assert!(velocity.abs() < 1e-7);
            }
        }
    }

    #[test]
    fn continuous_return_manual_takeover_holds_the_displayed_pose_and_tracks_the_finger() {
        for drag in [false, true] {
            let (mut scroll, cmd) = manual_return(Style::Amll, 12_000.0, 1_600.0);
            scroll.sample(&cmd, RETURN_START_MS, true);
            let displayed = scroll.sample(&cmd, RETURN_START_MS + 200.0, true);
            let delta = if drag { 5.0 } else { 0.0 };
            if drag {
                scroll.drag(delta, 19_200.0, RETURN_VIEWPORT);
            } else {
                scroll.set_manual_bounds(19_200.0, RETURN_VIEWPORT);
            }
            assert_eq!(scroll.position(), displayed + delta);
            assert_eq!(
                scroll.sample(&cmd, RETURN_START_MS + 216.0, false),
                displayed + delta
            );
            assert_eq!(
                scroll.sample(&cmd, RETURN_START_MS + 600.0, false),
                displayed + delta
            );
            assert_return_cleared(&scroll);
        }
    }

    #[test]
    fn seek_reset_and_restyle_clear_an_active_amll_return() {
        for reset in ["seek", "reset", "restyle"] {
            let (mut scroll, stale) = manual_return(Style::Amll, 12_000.0, 1_600.0);
            let initial = scroll.sample(&stale, RETURN_START_MS, true);
            let cmd = return_command(Style::Amll, stale.offset, initial);
            let before = scroll.sample(&cmd, RETURN_START_MS + 90.0, true);
            assert_ne!(initial, before);
            assert!(scroll.row_adjustments().iter().all(|&offset| offset == 0.0));
            let next = match reset {
                "seek" => {
                    scroll.snap_next();
                    assert!(scroll.explicit_snap_pending());
                    return_command(Style::Amll, 1_600.0, scroll.position())
                }
                "reset" => {
                    scroll.reset();
                    return_command(Style::Amll, 1_600.0, scroll.position())
                }
                "restyle" => {
                    scroll.configure(Style::Spicy, 3.0, 240);
                    return_command(Style::Spicy, 1_600.0, scroll.position())
                }
                _ => unreachable!(),
            };
            assert_return_cleared(&scroll);
            assert_eq!(
                scroll.sample(&next, RETURN_START_MS + 100.0, true),
                next.offset
            );
            assert!(!scroll.animating());
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
    fn deliberate_return_after_grace_reengages_within_a_third_for_both_styles() {
        for style in [Style::Spicy, Style::Amll] {
            for (distance, near) in [(0.0, true), (299.9, true), (300.0, true), (300.1, false)] {
                for direction in [-1.0, 1.0] {
                    let mut scroll = FollowScroll::default();
                    scroll.configure(style, 3.0, 8);
                    let target = command(style, 500.0, 800.0, 1, 0);
                    scroll.sample(&target, 0.0, true);
                    let escape = direction * (distance + 10.0);
                    scroll.note_manual_input(escape, Some(target.offset), 0.0);
                    scroll.drag(escape, 2_000.0, 900.0);
                    scroll.note_manual_input(-direction * 10.0, Some(target.offset), 2_600.0);
                    scroll.drag(-direction * 10.0, 2_000.0, 900.0);
                    let released = scroll.position();
                    assert_eq!(
                        scroll.release(0.0, 2_000.0, 900.0, Some(target.offset), 2_700.0),
                        near,
                        "{style:?} at the exact viewport-third boundary"
                    );
                    if near {
                        // The resumed trajectory starts at the released offset, then
                        // eases toward the active line instead of snapping.
                        assert_eq!(scroll.sample(&target, 200.0, true), released);
                        // Sample display frames rather than skipping straight to
                        // the endpoint. AMLL caps each display step at 64 ms, as
                        // does the reference's stepSimpleScroll.
                        for frame in 1..=120 {
                            let now = 200.0 + f64::from(frame) * 1000.0 / 60.0;
                            let position = scroll.sample(&target, now, true);
                            if distance == 0.0 {
                                assert_eq!(position, target.offset);
                            } else if frame == 1 || frame == 6 {
                                let remaining = (target.offset - position).abs();
                                assert!(
                                    remaining > 0.0 && remaining < distance,
                                    "{style:?}, distance {distance}, direction {direction}, \
                                 frame {frame}: released {released}, position {position}, \
                                 target {}",
                                    target.offset
                                );
                                if style == Style::Amll {
                                    // Reference sampleTrajectory, starting at rest:
                                    // interval 800 gives stiffness 170, mass 0.9.
                                    let omega = (170.0_f64 / 0.9).sqrt();
                                    let elapsed = (now - 200.0) / 1000.0;
                                    let expected = distance
                                        * (1.0 + omega * elapsed)
                                        * (-omega * elapsed).exp();
                                    assert!((remaining - expected).abs() < 1e-9);
                                }
                                println!(
                                    "{style:?} distance={distance} direction={direction} \
                                 elapsed={}ms released={released} position={position} target={}",
                                    now - 200.0,
                                    target.offset
                                );
                            }
                        }
                        assert_eq!(scroll.position(), target.offset);
                        assert!(!scroll.animating(), "{style:?} must eventually go idle");
                    } else {
                        // A far release stays manual and does not drift to the target.
                        assert_eq!(scroll.sample(&target, 200.0, false), released);
                        assert_eq!(scroll.sample(&target, 1_500.0, false), released);
                        assert!(!scroll.animating());
                    }
                }
            }
        }
    }

    #[test]
    fn same_track_rebuild_keeps_the_original_escape_deadline() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 1.0, 8);
        let target = command(Style::Spicy, 500.0, 800.0, 1, 0);
        scroll.sample(&target, 0.0, true);
        scroll.note_manual_input(40.0, Some(500.0), 0.0);
        scroll.drag(40.0, 2_000.0, 900.0);
        scroll.reset();
        scroll.restore_manual(540.0, 2_000.0, 900.0);
        scroll.note_manual_input(20.0, Some(500.0), 1_001.0);
        assert_eq!(scroll.escape.until, 1_000.0);
        scroll.resume_follow();
        assert_eq!(scroll.escape.until, 0.0);
    }

    #[test]
    fn touch_playback_and_geometry_never_start_escape_grace() {
        for style in [Style::Spicy, Style::Amll] {
            let mut scroll = FollowScroll::default();
            scroll.configure(style, 1.0, 8);
            let target = command(style, 500.0, 800.0, 1, 0);
            scroll.sample(&target, 0.0, true);
            for now in [999.0, 1_001.0] {
                scroll.sample(&target, now, false);
                assert!(!scroll.release(0.0, 2_000.0, 900.0, Some(500.0), now));
                scroll.restore_manual(500.0, 2_000.0, 900.0);
                assert_eq!(scroll.escape.until, 0.0);
                scroll.note_manual_input(0.0, Some(500.0), now);
                assert_eq!(scroll.escape.until, 0.0);
                scroll.resume_follow();
                assert_eq!(scroll.escape.until, 0.0);
            }
        }
    }

    #[test]
    fn escape_deadline_starts_once_and_return_overrides_it() {
        for style in [Style::Spicy, Style::Amll] {
            for now in [999.0, 1_000.0, 1_001.0] {
                let mut scroll = FollowScroll::default();
                scroll.configure(style, 1.0, 8);
                let target = command(style, 500.0, 800.0, 1, 0);
                scroll.sample(&target, 0.0, true);
                assert_eq!(scroll.escape.until, 0.0);
                scroll.note_manual_input(40.0, Some(500.0), 0.0);
                scroll.drag(40.0, 2_000.0, 900.0);
                assert_eq!(scroll.escape.until, 1_000.0);
                assert!(!scroll.release(0.0, 2_000.0, 900.0, Some(500.0), now));
                scroll.note_manual_input(20.0, Some(500.0), now);
                scroll.drag(20.0, 2_000.0, 900.0);
                assert_eq!(scroll.escape.until, 1_000.0);
                scroll.note_manual_input(-60.0, Some(500.0), now);
                scroll.drag(-60.0, 2_000.0, 900.0);
                assert!(scroll.release(0.0, 2_000.0, 900.0, Some(500.0), now));
                scroll.resume_follow();
                assert_eq!(scroll.escape.until, 0.0);
                scroll.reset();
                assert_eq!(scroll.escape.until, 0.0);
            }
        }
    }

    #[test]
    fn escape_release_and_playback_cannot_forge_a_return() {
        for style in [Style::Spicy, Style::Amll] {
            for direction in [-1.0, 1.0] {
                for now in [100.0, 3_000.0] {
                    let mut scroll = FollowScroll::default();
                    scroll.configure(style, 1.0, 8);
                    let target = command(style, 500.0, 800.0, 1, 0);
                    scroll.sample(&target, 0.0, true);
                    scroll.note_manual_input(direction * 40.0, Some(500.0), 0.0);
                    scroll.drag(direction * 40.0, 2_000.0, 900.0);
                    let held = scroll.position();
                    assert_eq!(scroll.sample(&target, now, false), held);
                    assert!(!scroll.release(0.0, 2_000.0, 900.0, Some(500.0), now));
                    scroll.note_manual_input(-direction * 10.0, Some(500.0), 3_100.0);
                    scroll.drag(-direction * 10.0, 2_000.0, 900.0);
                    // Playback advances the active target after the last input.
                    let moved_target = scroll.position();
                    assert!(!scroll.release(0.0, 2_000.0, 900.0, Some(moved_target), 3_200.0));
                    scroll.note_manual_input(-direction * 10.0, Some(500.0), 3_300.0);
                    scroll.drag(-direction * 10.0, 2_000.0, 900.0);
                    assert!(!scroll.release(direction, 2_000.0, 900.0, Some(500.0), 3_400.0));
                    scroll.note_manual_input(-direction * 10.0, Some(500.0), 3_500.0);
                    scroll.drag(-direction * 10.0, 2_000.0, 900.0);
                    assert!(scroll.release(0.0, 2_000.0, 900.0, Some(500.0), 3_600.0));
                }
            }
        }
    }

    #[test]
    fn active_drag_keeps_manual_ownership_until_release() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let target = command(Style::Spicy, 500.0, 800.0, 1, 0);
        scroll.sample(&target, 0.0, true);
        for _ in 0..40 {
            scroll.drag(-1.0, 2_000.0, 800.0);
            assert!(scroll.dragging, "the finger still owns the viewport");
        }
        // Sampling manual frames never retargets, even when the finger is close
        // to the active line. Only release may hand ownership back.
        let held = scroll.position();
        assert_eq!(scroll.sample(&target, 100.0, false), held);
        assert_eq!(scroll.sample(&target, 200.0, false), held);
        assert!(scroll.dragging);
        assert!(!scroll.release(0.0, 2_000.0, 800.0, Some(target.offset), 3_000.0));
        assert!(!scroll.dragging);
    }

    #[test]
    fn release_without_layout_stays_manual() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let target = command(Style::Spicy, 500.0, 800.0, 1, 0);
        scroll.sample(&target, 0.0, true);
        scroll.drag(-40.0, 2_000.0, 800.0);
        assert!(!scroll.release(0.0, 2_000.0, 800.0, None, 3_000.0));
        // The fling handoff still happened, but follow ownership did not move
        // because no layout supplied an authoritative active-line target.
        assert!(!scroll.dragging);
        assert_eq!(scroll.sample(&target, 100.0, false), 460.0);
        assert_eq!(scroll.sample(&target, 1_000.0, false), 460.0);
        assert!(!scroll.animating());
    }

    #[test]
    fn late_follow_enable_after_manual_frames_still_snaps_to_layout_target() {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Amll, 3.0, 8);
        scroll.reset();
        // A new song can render before the first layout/follow handshake lands.
        let target = command(Style::Amll, 720.0, 800.0, 3, 1);
        assert_eq!(scroll.sample(&target, 0.0, false), 0.0);
        assert_eq!(scroll.sample(&target, 16.0, false), 0.0);
        // The first followed frame after layout readiness still teleports to
        // the authoritative target instead of animating from the old song.
        assert_eq!(scroll.sample(&target, 32.0, true), 720.0);
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
