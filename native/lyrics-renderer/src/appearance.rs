//! Mutable per-owner timing, separate from immutable/cacheable paragraph geometry.
use crate::{
    scene::TrackScene,
    style_timing::{self, FloatClock, Spring, WordSpec, WordState},
    typography::Style,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Effect {
    Baseline,
    Fill,
    Motion,
    Glow,
}
impl Effect {
    pub fn motion(self) -> bool {
        matches!(self, Self::Motion | Self::Glow)
    }
    pub fn glow(self) -> bool {
        self == Self::Glow
    }
}
/// Live effect. `Glow` composites the Skia-derived glyph emission inside the
/// existing shared half-resolution filter pass (band flag bit 4), so the frame
/// cost stays in the same two blur bases and the same two frames in flight.
pub const LIVE_EFFECT: Effect = Effect::Glow;
/// One row voice's mutable word springs, in source word order.
pub struct RowVoice {
    pub words: Vec<WordState>,
}
pub struct RowState {
    pub voices: Vec<RowVoice>,
    pub clock: FloatClock,
    pub scale: Spring,
    pub bright: f64,
    pub dark: f64,
    pub outer: f64,
    target_outer: f64,
    from_outer: f64,
    outer_start: f64,
    pub active: bool,
    pub releasing: bool,
    pub animating: bool,
}
#[derive(Default)]
pub struct AppearanceState {
    pub(crate) rows: Vec<Option<RowState>>,
    pub(crate) interlude: crate::interlude::InterludeState,
    last_ms: Option<f64>,
    playing: bool,
}
impl AppearanceState {
    pub fn reset(&mut self) {
        self.rows.clear();
        self.interlude.reset();
        self.last_ms = None;
    }
    pub fn interlude_animating(&self) -> bool {
        self.interlude.animating()
    }
    /// Invoked with static near-active geometry preparation; allocations only on window changes.
    pub fn prepare(&mut self, track: &TrackScene, time: f64, native_ms: f64) {
        if self.rows.len() != track.lines.len() {
            self.reset();
            self.rows.resize_with(track.lines.len(), || None);
        }
        for (i, line) in track.lines.iter().enumerate() {
            if !track.timed_ready(i) {
                continue;
            }
            if self.rows[i].is_none() {
                if line.paint.is_none() {
                    continue;
                }
                // Background tails keep the package highlighted, matching Skia's
                // `endTimeByIndex` (getBackgroundEndTime) presentation window.
                let active = time >= line.start && time < line.background_end;
                let spicy = track.style() == Some(Style::Spicy);
                let primed = time < line.start
                    && crate::window(&track.lines, time)
                        .active()
                        .is_some_and(|(start, end)| i >= start && i <= end);
                let outer = if spicy {
                    if active || primed {
                        1.0
                    } else if time > line.background_end {
                        0.497
                    } else {
                        0.51
                    }
                } else if active {
                    0.85
                } else {
                    1.0
                };
                self.rows[i] = Some(RowState {
                    voices: line
                        .voices()
                        .map(|voice| RowVoice {
                            words: voice
                                .words
                                .iter()
                                .map(|w| {
                                    WordState::new(WordSpec {
                                        start: w.start,
                                        end: w.end,
                                        emphasized: w
                                            .appearance
                                            .as_ref()
                                            .is_some_and(|a| a.emphasized),
                                        letters: w.graphemes.len(),
                                    })
                                })
                                .collect(),
                        })
                        .collect(),
                    clock: FloatClock::default(),
                    // Match the cold paragraph transform before the first advance.
                    scale: Spring {
                        p: if spicy || active || (self.last_ms.is_some() && !self.playing) {
                            1.0
                        } else {
                            0.97
                        },
                        v: 0.0,
                    },
                    // Skia's line springs have already settled a future row to
                    // bright=dark=0.2 long before it is promoted to exact glyphs.
                    // The raw placeholder paints the same inactive alpha, so the
                    // handoff cannot flash white.
                    bright: if spicy || active { 1.0 } else { 0.2 },
                    dark: if spicy || active { 0.4 } else { 0.2 },
                    outer,
                    target_outer: outer,
                    from_outer: outer,
                    outer_start: native_ms,
                    active,
                    releasing: false,
                    animating: false,
                });
            }
        }
    }
    pub fn advance(
        &mut self,
        track: &TrackScene,
        time: f64,
        native_ms: f64,
        playing: bool,
        effect: Effect,
    ) {
        let dt = self
            .last_ms
            .map_or(0.0, |last| ((native_ms - last) / 1000.0).clamp(0.0, 0.064));
        self.last_ms = Some(native_ms);
        self.playing = playing;
        let spicy = track.style() == Some(Style::Spicy);
        // Skia's visual window promotes the upcoming line for the last 500 ms of
        // a long gap (and for a short gap after the previous line ends), so its
        // 200 ms opacity timing is already at full strength when it starts.
        let primed = crate::window(&track.lines, time).active();
        if effect.motion() && spicy {
            if let Some((row, slot)) = track.interlude_at(time) {
                self.interlude.advance(row, slot, time, dt);
            } else {
                self.interlude.clear();
            }
        }
        for (i, slot) in self.rows.iter_mut().enumerate() {
            let Some(row) = slot else {
                continue;
            };
            if !track.geometry_ready(i) {
                *slot = None;
                continue;
            }
            let line = &track.lines[i];
            let active = time >= line.start && time < line.background_end;
            let pre_active = !active
                && time < line.start
                && primed.is_some_and(|(start, end)| i >= start && i <= end);
            row.clock.advance(active, time, dt * 1000.0);
            row.active = active;
            let target = if spicy {
                if active || pre_active {
                    1.0
                } else if time > line.background_end {
                    0.497
                } else {
                    0.51
                }
            } else if active || pre_active {
                0.85
            } else {
                1.0
            };
            if row.target_outer != target {
                row.from_outer = row.outer;
                row.target_outer = target;
                row.outer_start = native_ms;
            }
            let fraction =
                ((native_ms - row.outer_start) / if spicy { 200.0 } else { 400.0 }).clamp(0.0, 1.0);
            let eased = if spicy {
                style_timing::bezier(fraction, 0.61, 1.0, 0.88, 1.0)
            } else {
                style_timing::bezier(fraction, 0.25, 0.1, 0.25, 1.0)
            };
            row.outer = row.from_outer + (target - row.from_outer) * eased;
            let mut line_animating = false;
            if spicy {
                for voice in &mut row.voices {
                    for word in &mut voice.words {
                        if effect.motion() {
                            word.advance(time, dt);
                        } else {
                            word.advance_fill(time);
                        }
                    }
                }
            } else {
                let target_scale = if active || pre_active || !playing {
                    1.0
                } else {
                    0.97
                };
                let next = style_timing::amll_spring(row.scale, target_scale, 2.0, 25.0, 100.0, dt);
                row.scale = if (next.p - target_scale).abs() < 0.0001 && next.v.abs() < 0.0001 {
                    Spring {
                        p: target_scale,
                        v: 0.0,
                    }
                } else {
                    next
                };
                let factor = ((row.scale.p - 0.97) / 0.03).clamp(0.0, 1.0);
                let bright = if active || pre_active {
                    factor * 0.8 + 0.2
                } else {
                    factor * 0.2 + 0.2
                };
                let dark = factor * 0.2 + 0.2;
                let filter = |from: f64, to: f64| {
                    if (to - from).abs() < 0.001 {
                        to
                    } else {
                        from + (to - from)
                            * (1.0
                                - (-(if to > from { 50.0 } else { 7.0 })
                                    * if dt == 0.0 { 0.016 } else { dt })
                                .exp())
                    }
                };
                row.bright = filter(row.bright, bright);
                row.dark = filter(row.dark, dark);
                line_animating = row.bright != bright || row.dark != dark;
            }
            row.releasing = !active
                && if spicy {
                    row.voices
                        .iter()
                        .any(|voice| voice.words.iter().any(|w| !w.settled))
                } else {
                    row.voices.iter().any(|voice| {
                        voice.words.iter().any(|w| {
                            row.clock.word_position(time, w.spec().start, w.spec().end)
                                > w.spec().start
                        })
                    })
                };
            row.animating = effect.motion()
                && ((row.from_outer != target && fraction < 1.0)
                    || if spicy {
                        row.voices
                            .iter()
                            .any(|voice| voice.words.iter().any(|w| !w.settled))
                    } else {
                        row.releasing || row.scale.v != 0.0 || line_animating
                    });
        }
    }
    pub fn playing(&self) -> bool {
        self.playing
    }
    pub fn animating(&self) -> bool {
        self.rows.iter().flatten().any(|r| r.animating)
    }
    pub fn row(&self, index: usize) -> Option<&RowState> {
        self.rows.get(index).and_then(Option::as_ref)
    }
}
