//! Skia interlude dots (`native-interlude-motion.ts` / `native-interlude.tsx`).
//! The slot is inserted above the upcoming lyric; its expansion shifts that row
//! and every later row without changing the stored row heights.
use crate::style_timing::{Curve, Spring, bezier, spicy_spring, spline};

pub(crate) const LONG_PAUSE_MS: f64 = 3000.0;
/// Spicy's dot-group transition/hide times (`native-interlude.tsx`).
const SPICY_HIDE_BEFORE_END: f64 = 500.0;
const SPICY_COLLAPSE_BEFORE_END: f64 = 500.0;
const SPICY_SLOT_DURATION: f64 = 400.0;
const SPICY_GROUP_DURATION: f64 = 300.0;
const SPICY_GROUP_EXIT_DURATION: f64 = 400.0;
const SPICY_FADE_DURATION: f64 = 140.0;
/// AMLL's slot/group/snapshot end offsets.
const AMLL_COLLAPSE_BEFORE_END: f64 = 625.0;
const AMLL_SLOT_DURATION: f64 = 375.0;
pub(crate) const AMLL_SNAPSHOT_BEFORE_END: f64 = 250.0;

// native-interlude.tsx: these are layout units before the animated transforms.
pub(crate) const SPICY_FONT: f64 = 1.3;
pub(crate) const SPICY_HEIGHT: f64 = 0.65;
pub(crate) const SPICY_GAP: f64 = 2.88;
pub(crate) const SPICY_ALPHA: f64 = 0.85;
pub(crate) const AMLL_DIAMETER: f64 = 0.5;
pub(crate) const AMLL_GAP: f64 = 0.25;
pub(crate) const AMLL_MARGIN: f64 = 4.0;
pub(crate) const AMLL_TOP: f64 = 0.4;

/// The exact SF Pro Display Bold bullet used by Skia's SpicyDot. Its advance
/// and ink bounds determine the cell, rather than guessed circle dimensions.
pub(crate) struct DotGlyph {
    pub font: parley::FontData,
    pub size: f32,
    pub width: f64,
    pub height: f64,
    pub glyph: vello::Glyph,
    pub ink: vello::kurbo::Rect,
}
impl DotGlyph {
    pub fn prepare(fonts: &mut crate::typography::Fonts, row_size: f64) -> Self {
        use skrifa::{FontRef, MetadataProvider, instance::Size};
        let size = (row_size * SPICY_FONT) as f32;
        let mut layouts = parley::LayoutContext::new();
        let mut layout = crate::scene::shape(
            "•",
            &mut fonts.context,
            &mut layouts,
            size,
            size,
            700.0,
            "SF Pro Display",
            &[],
            0.0,
        );
        layout.break_all_lines(Some(10000.0));
        let run = layout
            .lines()
            .next()
            .unwrap()
            .items()
            .find_map(|item| {
                if let parley::PositionedLayoutItem::GlyphRun(run) = item {
                    Some(run)
                } else {
                    None
                }
            })
            .expect("bundled bullet glyph");
        let font = run.run().font().clone();
        let id = run.positioned_glyphs().next().unwrap().id;
        let parsed = FontRef::from_index(font.data.as_ref(), font.index).unwrap();
        let metrics = parsed.glyph_metrics(Size::new(size), &[][..]);
        let glyph_id = skrifa::GlyphId::new(id);
        let width = f64::from(metrics.advance_width(glyph_id).unwrap());
        let ink = metrics.bounds(glyph_id).unwrap();
        let height = row_size * SPICY_FONT * SPICY_HEIGHT;
        let glyph = vello::Glyph {
            id,
            x: ((width - f64::from(ink.x_max - ink.x_min)) / 2.0 - f64::from(ink.x_min)) as f32,
            y: (height / 2.0 + f64::from(ink.y_max + ink.y_min) / 2.0) as f32,
        };
        Self {
            font,
            size,
            width,
            height,
            glyph,
            ink: vello::kurbo::Rect::new(
                f64::from(glyph.x + ink.x_min),
                f64::from(glyph.y - ink.y_max),
                f64::from(glyph.x + ink.x_max),
                f64::from(glyph.y - ink.y_min),
            ),
        }
    }
}

const DOT_SCALE: Curve = Curve {
    xs: &[0.0, 0.7, 1.0],
    ys: &[0.75, 1.05, 1.0],
    ks: &[
        0.6369047619047621,
        0.011904761904761843,
        -0.2559523809523811,
    ],
};
const DOT_Y: Curve = Curve {
    xs: &[0.0, 0.9, 1.0],
    ys: &[0.0, -0.12, 0.0],
    ks: &[-0.7333333333333336, 1.066666666666667, 1.2666666666666668],
};
const DOT_GLOW: Curve = Curve {
    xs: &[0.0, 0.6, 1.0],
    ys: &[0.0, 1.0, 1.0],
    ks: &[2.166666666666667, 0.6666666666666663, -0.3333333333333332],
};
const DOT_OPACITY: Curve = Curve {
    xs: &[0.0, 0.6, 1.0],
    ys: &[0.35, 1.0, 1.0],
    ks: &[1.4083333333333334, 0.4333333333333333, -0.21666666666666665],
};
const EXIT_XS: [f64; 14] = [
    0.0, 0.094, 0.18, 0.433, 0.514, 0.559, 0.6, 0.639, 0.676, 0.723, 0.767, 0.85, 0.927, 1.0,
];
const EXIT_YS: [f64; 14] = [
    0.0, -0.006, -0.029, -0.157, -0.185, -0.189, -0.182, -0.163, -0.133, -0.074, 0.006, 0.238,
    0.566, 1.0,
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Interlude {
    pub start: f64,
    pub end: f64,
}

/// Per-row interlude slots, source order. Row `i` owns the break when its lead
/// starts at least 3 s after the previous package's background end.
pub(crate) fn slots(lines: &[crate::Line]) -> Vec<Option<Interlude>> {
    let mut covered_end = 0.0;
    let mut result = Vec::with_capacity(lines.len());
    for line in lines {
        result.push(
            (line.start - covered_end >= LONG_PAUSE_MS).then_some(Interlude {
                start: covered_end,
                end: line.start,
            }),
        );
        covered_end = covered_end.max(line.background_end);
    }
    result
}

/// Spicy `spicyDotTiming`: each of the three dots gets a third of the break,
/// with the shared -550/3 ms overlap from the source animator.
pub(crate) fn spicy_dot_timing(start: f64, end: f64) -> [(f64, f64); 3] {
    let duration = (end - start).max(1.0);
    let base = duration / 3.0;
    let padding = -550.0 / 3.0;
    let first = start.max(start + base + padding);
    let second = first.max(start + base * 2.0 + padding * 2.0);
    [
        (start, first),
        (first, second),
        (second, second.max(end - 550.0)),
    ]
}

/// CSS `linear()` curve from Spicy's dot-group exit transition.
pub(crate) fn spicy_dot_exit_easing(progress: f64) -> f64 {
    let p = progress.clamp(0.0, 1.0);
    let mut i = 1;
    while i < EXIT_XS.len() - 1 && EXIT_XS[i] < p {
        i += 1;
    }
    let span = EXIT_XS[i] - EXIT_XS[i - 1];
    EXIT_YS[i - 1] + (EXIT_YS[i] - EXIT_YS[i - 1]) * (p - EXIT_XS[i - 1]) / span
}

fn ease_in_out_quad(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        2.0 * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
    }
}

/// Spicy dot-group scale/opacity tweens. Entry and exit times are fixed by the
/// break, so this is evaluated rather than retained as animation state.
pub(crate) fn spicy_group(start: f64, end: f64, time: f64) -> (f64, f64) {
    let hidden = end - SPICY_HIDE_BEFORE_END;
    let scale = if time < start {
        0.0
    } else if time < start + SPICY_GROUP_DURATION {
        bezier((time - start) / SPICY_GROUP_DURATION, 0.25, 0.1, 0.25, 1.0)
    } else if time < hidden {
        1.0
    } else if time < hidden + SPICY_GROUP_EXIT_DURATION {
        1.0 - spicy_dot_exit_easing((time - hidden) / SPICY_GROUP_EXIT_DURATION)
    } else {
        0.0
    };
    let opacity = if time < start {
        0.0
    } else if time < start + SPICY_FADE_DURATION {
        ease_in_out_quad((time - start) / SPICY_FADE_DURATION)
    } else if time < hidden {
        1.0
    } else if time < hidden + SPICY_FADE_DURATION {
        1.0 - ease_in_out_quad((time - hidden) / SPICY_FADE_DURATION)
    } else {
        0.0
    };
    (scale, opacity)
}

/// AMLL `InterludeDotsEl` breathing scale and per-dot opacity.
pub(crate) fn amll_snapshot(time: f64, start: f64, end: f64) -> (f64, [f64; 3]) {
    let duration = end - start;
    let elapsed = time - start;
    if duration <= 0.0 || elapsed < 0.0 || elapsed > duration {
        return (0.0, [0.0, 0.0, 0.0]);
    }
    let breathe = duration / (duration / 1500.0).ceil();
    let mut scale = (1.5 * std::f64::consts::PI - elapsed / breathe * 2.0).sin() / 20.0 + 1.0;
    let mut opacity = 1.0;
    if elapsed < 2000.0 {
        scale *= 1.0 - 2.0_f64.powf(-10.0 * elapsed / 2000.0);
    }
    if elapsed < 500.0 {
        opacity = 0.0;
    } else if elapsed < 1000.0 {
        opacity *= (elapsed - 500.0) / 500.0;
    }
    let remaining = duration - elapsed;
    if remaining < 750.0 {
        let p = (750.0 - remaining) / 750.0 / 2.0;
        let c = 2.5949095;
        let ease = (2.0 * p).powi(2) * ((c + 1.0) * 2.0 * p - c) / 2.0;
        scale *= 1.0 - ease;
    }
    if remaining < 375.0 {
        opacity *= (remaining / 375.0).clamp(0.0, 1.0);
    }
    let lighting_duration = (duration - 750.0).max(1.0);
    let dots = [0, 1, 2].map(|index| {
        (opacity
            * (1.0_f64).min((0.25_f64).max(
                (elapsed - lighting_duration / 3.0 * f64::from(index)) * 3.0 / lighting_duration
                    * 0.75,
            )))
        .clamp(0.0, 1.0)
    });
    (scale.max(0.0) * 0.7, dots)
}

/// Expanded slot height above the upcoming lyric. `font_size` and
/// `surface_width` are physical pixels.
pub(crate) fn slot_height(
    slot: &Interlude,
    spicy: bool,
    font_size: f64,
    surface_width: f64,
    time: f64,
) -> f64 {
    let full = if spicy {
        font_size * 1.3 * 0.65
    } else {
        font_size * 1.3 + surface_width * 0.05
    };
    let collapse_at = slot.end
        - if spicy {
            SPICY_COLLAPSE_BEFORE_END
        } else {
            AMLL_COLLAPSE_BEFORE_END
        };
    let duration = if spicy {
        SPICY_SLOT_DURATION
    } else {
        AMLL_SLOT_DURATION
    };
    if time < slot.start || time >= collapse_at + duration {
        return 0.0;
    }
    let eased = if time < slot.start + duration {
        bezier((time - slot.start) / duration, 0.25, 0.1, 0.25, 1.0)
    } else if time < collapse_at {
        1.0
    } else {
        1.0 - bezier((time - collapse_at) / duration, 0.25, 0.1, 0.25, 1.0)
    };
    full * eased
}

#[derive(Clone, Copy)]
struct DotSprings {
    scale: Spring,
    y: Spring,
    glow: Spring,
    opacity: Spring,
}
impl DotSprings {
    fn initial() -> Self {
        Self {
            scale: Spring { p: 0.75, v: 0.0 },
            y: Spring { p: 0.0, v: 0.0 },
            glow: Spring { p: 0.0, v: 0.0 },
            opacity: Spring { p: 0.35, v: 0.0 },
        }
    }
}

/// Stateful Spicy dot springs. AMLL dots are stateless.
pub(crate) struct InterludeState {
    row: Option<usize>,
    start: f64,
    end: f64,
    dots: [DotSprings; 3],
    last_time: Option<f64>,
}
impl Default for InterludeState {
    fn default() -> Self {
        Self {
            row: None,
            start: 0.0,
            end: 0.0,
            dots: [DotSprings::initial(); 3],
            last_time: None,
        }
    }
}
impl InterludeState {
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
    pub(crate) fn clear(&mut self) {
        if self.row.is_some() {
            self.reset();
        }
    }
    pub(crate) fn row(&self) -> Option<usize> {
        self.row
    }
    pub(crate) fn animating(&self) -> bool {
        self.row.is_some()
            && self.dots.iter().any(|dot| {
                dot.scale.v != 0.0 || dot.y.v != 0.0 || dot.glow.v != 0.0 || dot.opacity.v != 0.0
            })
    }
    /// `advanceSpicyDot` for all three dots, including its seek/jump snap rule.
    pub(crate) fn advance(&mut self, row: usize, slot: Interlude, time: f64, dt: f64) {
        if self.row != Some(row) || self.start != slot.start || self.end != slot.end {
            self.row = Some(row);
            self.start = slot.start;
            self.end = slot.end;
            self.dots = [DotSprings::initial(); 3];
            self.last_time = None;
        }
        let snap = self
            .last_time
            .is_none_or(|last| time < last - 50.0 || (time - last).abs() > 250.0);
        let step = |previous: Spring, goal: f64, frequency: f64, damping: f64| {
            if snap {
                Spring { p: goal, v: 0.0 }
            } else {
                spicy_spring(previous, goal, frequency, damping, dt)
            }
        };
        for (dot, (start, end)) in self
            .dots
            .iter_mut()
            .zip(spicy_dot_timing(slot.start, slot.end))
        {
            let p = ((time - start) / (end - start).max(1.0)).clamp(0.0, 1.0);
            dot.scale = step(dot.scale, spline(&DOT_SCALE, p), 0.7, 0.6);
            dot.y = step(dot.y, spline(&DOT_Y, p), 1.25, 0.4);
            dot.glow = step(dot.glow, spline(&DOT_GLOW, p), 1.0, 0.5);
            dot.opacity = step(dot.opacity, spline(&DOT_OPACITY, p), 1.0, 0.5);
        }
        self.last_time = Some(time);
    }
    /// Scale, translateY (row-font units), glow and opacity for dot `index`.
    pub(crate) fn dot(&self, index: usize) -> (f64, f64, f64, f64) {
        self.dots.get(index).map_or((0.75, 0.0, 0.0, 0.35), |d| {
            (d.scale.p, d.y.p, d.glow.p, d.opacity.p)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: f64, end: f64, background_end: f64) -> crate::Line {
        crate::Line {
            paint: None,
            text: String::new(),
            start,
            end,
            background_end,
            atoms: Vec::new(),
            backgrounds: Vec::new(),
        }
    }

    #[test]
    fn drawing_parameters_match_the_skia_source_constants() {
        let view =
            include_str!("../../../ExpoLyrics/components/lyrics/native/native-interlude.tsx");
        let motion =
            include_str!("../../../ExpoLyrics/components/lyrics/native/reference-motion.ts");
        let number = |source: &str, prefix: &str| -> f64 {
            source
                .split_once(prefix)
                .unwrap()
                .1
                .split(|c: char| !c.is_ascii_digit() && c != '.')
                .next()
                .unwrap()
                .parse()
                .unwrap()
        };
        assert_eq!(SPICY_FONT, number(view, "fontSize: fontSize * "));
        assert_eq!(
            SPICY_HEIGHT,
            number(view, "const dotHeight = fontSize * 1.3 * ")
        );
        assert_eq!(SPICY_GAP, number(view, "gap: spicy ? "));
        assert_eq!(SPICY_ALPHA, number(view, "color=\"rgba(255,255,255,"));
        assert_eq!(AMLL_DIAMETER, number(view, "size={fontSize * "));
        assert_eq!(AMLL_GAP, number(view, "gap: spicy ? 2.88 : fontSize * "));
        assert_eq!(AMLL_MARGIN, number(view, "marginRight: index < 2 ? "));
        assert_eq!(AMLL_TOP, number(view, "top: spicy ? 0 : fontSize * "));
        // The reference draws an actual bold bullet, not a circle, and adds
        // exactly one animated shadow. AMLL uses plain white Views.
        assert!(view.contains("text=\"•\""));
        assert!(view.contains("fontWeight: '700'"));
        assert!(view.contains("(4 + 6 * visibleState.value.glow.p) / 2"));
        assert!(view.contains("visibleState.value.glow.p * 0.9"));
        let amll = view
            .split("const AmllDot =")
            .nth(1)
            .unwrap()
            .split("/** Persistent")
            .next()
            .unwrap();
        assert!(!amll.contains("Shadow") && !amll.contains("Blur"));
        assert_eq!(SPICY_SLOT_DURATION, number(view, "duration: spicy ? "));
        assert_eq!(AMLL_SLOT_DURATION, number(view, "duration: spicy ? 400 : "));
        assert_eq!(
            SPICY_FADE_DURATION,
            number(view, "withTiming(Number(current.shown), { duration: ")
        );
        assert!(view.contains("{ duration: 140 }"));
        for (name, curve) in [
            ("SCALE", DOT_SCALE),
            ("Y", DOT_Y),
            ("GLOW", DOT_GLOW),
            ("OPACITY", DOT_OPACITY),
        ] {
            let declaration = motion
                .split_once(&format!("SPICY_DOT_{name} = curve("))
                .unwrap()
                .1;
            let (xs, rest) = declaration.split_once("], [").unwrap();
            let parse = |s: &str| {
                s.split(',')
                    .map(|n| n.trim().parse::<f64>().unwrap())
                    .collect::<Vec<_>>()
            };
            assert_eq!(curve.xs, parse(xs.trim_start_matches('[')));
            assert_eq!(curve.ys, parse(rest.split(']').next().unwrap()));
        }
    }

    #[test]
    fn slots_use_background_tails_and_source_order() {
        let lines = [
            line(5000.0, 6000.0, 6000.0),
            line(7000.0, 8000.0, 12000.0),
            line(13000.0, 14000.0, 14000.0),
            line(20000.0, 21000.0, 21000.0),
        ];
        let slots = slots(&lines);
        assert_eq!(
            slots[0],
            Some(Interlude {
                start: 0.0,
                end: 5000.0
            })
        );
        assert_eq!(slots[1], None);
        // 13000 - 12000 = 1000 ms is short; 20000 - 14000 = 6000 ms is a break.
        assert_eq!(slots[2], None);
        assert_eq!(
            slots[3],
            Some(Interlude {
                start: 14000.0,
                end: 20000.0
            })
        );
    }

    #[test]
    fn spicy_dot_timing_matches_source_windows() {
        assert_eq!(
            spicy_dot_timing(1000.0, 4000.0),
            [
                (1000.0, 1816.6666666666667),
                (1816.6666666666667, 2633.3333333333335),
                (2633.3333333333335, 3450.0)
            ]
        );
        assert_eq!(
            spicy_dot_timing(0.0, 3000.0),
            [
                (0.0, 816.6666666666666),
                (816.6666666666666, 1633.3333333333333),
                (1633.3333333333333, 2450.0)
            ]
        );
    }

    #[test]
    fn exit_easing_and_group_tweens_hit_their_endpoints() {
        assert_eq!(spicy_dot_exit_easing(0.0), 0.0);
        assert_eq!(spicy_dot_exit_easing(1.0), 1.0);
        assert!((spicy_dot_exit_easing(0.5) + 0.18016049382716048).abs() < 1e-12);
        assert_eq!(spicy_group(1000.0, 5000.0, 999.0), (0.0, 0.0));
        assert_eq!(spicy_group(1000.0, 5000.0, 1500.0), (1.0, 1.0));
        assert_eq!(spicy_group(1000.0, 5000.0, 4499.0), (1.0, 1.0));
        assert_eq!(spicy_group(1000.0, 5000.0, 4900.0), (0.0, 0.0));
    }

    #[test]
    fn amll_snapshot_pins_breathing_scale_and_lighting() {
        let (scale, dots) = amll_snapshot(750.0, 0.0, 6000.0);
        assert!((scale - 0.6304671453334758).abs() < 1e-12);
        assert!((dots[0] - 0.1607142857142857).abs() < 1e-12);
        assert!((dots[1] - 0.125).abs() < 1e-12);
        let (scale, dots) = amll_snapshot(3000.0, 0.0, 6000.0);
        assert!((scale - 0.7228775267302263).abs() < 1e-12);
        assert_eq!(dots[0], 1.0);
        assert!((dots[1] - 0.5357142857142857).abs() < 1e-12);
        assert_eq!(dots[2], 0.25);
        let (_, dots) = amll_snapshot(5900.0, 0.0, 6000.0);
        assert!((dots[0] - 0.26666666666666666).abs() < 1e-12);
        assert_eq!(amll_snapshot(6100.0, 0.0, 6000.0).1, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn slot_height_expands_full_width_and_collapses() {
        let slot = Interlude {
            start: 1000.0,
            end: 5000.0,
        };
        assert_eq!(slot_height(&slot, true, 40.0, 390.0, 999.0), 0.0);
        assert_eq!(
            slot_height(&slot, true, 40.0, 390.0, 1400.0),
            40.0 * 1.3 * 0.65
        );
        assert_eq!(
            slot_height(&slot, true, 40.0, 390.0, 4499.0),
            40.0 * 1.3 * 0.65
        );
        assert_eq!(slot_height(&slot, true, 40.0, 390.0, 4900.0), 0.0);
        let full = 40.0 * 1.3 + 400.0 * 0.05;
        assert_eq!(slot_height(&slot, false, 40.0, 400.0, 1400.0), full);
        assert_eq!(slot_height(&slot, false, 40.0, 400.0, 4374.0), full);
        assert_eq!(slot_height(&slot, false, 40.0, 400.0, 4750.0), 0.0);
    }

    #[test]
    fn springs_snap_on_seek_and_advance_without_allocations() {
        let slot = Interlude {
            start: 1000.0,
            end: 4000.0,
        };
        let mut state = InterludeState::default();
        state.advance(2, slot, 1000.0, 0.016);
        assert_eq!(state.row(), Some(2));
        // First sample snaps to the p=0 goals.
        assert_eq!(state.dot(0), (0.75, 0.0, 0.0, 0.35));
        state.advance(2, slot, 1600.0, 0.016);
        let (scale, _, _, opacity) = state.dot(0);
        assert!(scale > 0.75);
        assert!(opacity > 0.35);
        // A backward jump > 50 ms resets the springs to the current goals.
        state.advance(2, slot, 1000.0, 0.016);
        assert_eq!(state.dot(0), (0.75, 0.0, 0.0, 0.35));
        state.clear();
        assert_eq!(state.row(), None);
    }
}
