//! Live timed glyph masks. Reuses the existing immutable paragraph geometry;
//! never records/caches an animated glyph picture or creates per-line blur filters.
use crate::{
    appearance::{AppearanceState, Effect},
    scene::TrackScene,
    typography::{Style, WordRange},
};
use vello::{
    Scene,
    kurbo::{Affine, BezPath, Circle, Rect, Shape},
    peniko::{BlendMode, Color, Fill, Gradient, color::ColorSpaceTag},
};
pub(crate) struct Slice {
    path: BezPath,
    runs: Vec<Glyphs>,
    rect: Rect,
    extent: Rect,
    letter: usize,
    amll_x: f64,
    clip: bool,
}
pub(crate) struct Glyphs {
    pub(crate) font: parley::FontData,
    pub(crate) size: f32,
    pub(crate) coords: Vec<i16>,
    pub(crate) glyphs: Vec<vello::Glyph>,
}
fn slice_glyphs(layout: &parley::Layout<()>, rects: &[Rect]) -> (Vec<Glyphs>, bool) {
    let mut result = Vec::new();
    let mut clip = false;
    for line in layout.lines() {
        for item in line.items() {
            let parley::PositionedLayoutItem::GlyphRun(run) = item else {
                continue;
            };
            let raw = run.run();
            let glyphs: Vec<_> = run
                .positioned_glyphs()
                .filter(|g| {
                    rects.iter().any(|r| {
                        let left = if g.advance > 0.0 {
                            f64::from(g.x)
                        } else {
                            f64::from(g.x - raw.font_size())
                        };
                        let right = if g.advance > 0.0 {
                            f64::from(g.x + g.advance)
                        } else {
                            f64::from(g.x + raw.font_size())
                        };
                        f64::from(g.y) > r.y0
                            && f64::from(g.y) <= r.y1
                            && left < r.x1 - 0.01
                            && right > r.x0 + 0.01
                    })
                })
                .map(|g| {
                    // An owned glyph keeps its full ink, including overhang. Only
                    // shared ligatures/marks need the syllable's slice clip.
                    clip |= g.advance <= 0.0
                        || !rects.iter().any(|r| {
                            f64::from(g.y) > r.y0
                                && f64::from(g.y) <= r.y1
                                && f64::from(g.x) >= r.x0 - 0.01
                                && f64::from(g.x + g.advance) <= r.x1 + 0.01
                        });
                    vello::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }
                })
                .collect();
            if !glyphs.is_empty() {
                result.push(Glyphs {
                    font: raw.font().clone(),
                    size: raw.font_size(),
                    coords: raw
                        .normalized_coords()
                        .iter()
                        .map(|c| c.to_bits())
                        .collect(),
                    glyphs,
                });
            }
        }
    }
    (result, clip)
}
pub(crate) struct TimedWord {
    bounds: Rect,
    slices: Vec<Slice>,
    width: f64,
    before: f64,
}
pub(crate) fn geometry(
    layout: &parley::Layout<()>,
    words: &[WordRange],
    voice: &crate::typography::PaintVoice,
) -> Vec<TimedWord> {
    let full: Vec<_> = words
        .iter()
        .map(|w| {
            let mut w = w.clone();
            w.bytes.end += usize::from(w.gap);
            w
        })
        .collect();
    let boxes = crate::scene::fragments(layout, &full);
    let mut before = 0.0;
    words
        .iter()
        .zip(&voice.words)
        .enumerate()
        .map(|(index, (range, word))| {
            let bounds = boxes[index].first().copied().unwrap_or(Rect::ZERO);
            let width = boxes[index].iter().map(Rect::width).sum();
            let children = if word.appearance.as_ref().is_some_and(|a| a.emphasized) {
                let mut offset = range.bytes.start;
                let ranges: Vec<_> = word
                    .graphemes
                    .iter()
                    .map(|letter| {
                        let start = offset;
                        offset += letter.len();
                        WordRange {
                            bytes: start..offset,
                            start: range.start,
                            end: range.end,
                            gap: false,
                        }
                    })
                    .collect();
                crate::scene::fragments(layout, &ranges)
            } else {
                boxes[index].iter().map(|r| vec![*r]).collect()
            };
            let slices = children
                .into_iter()
                .enumerate()
                .filter_map(|(letter, rects)| {
                    let rect = *rects.first()?;
                    let mut path = BezPath::new();
                    for r in &rects {
                        path.extend(r.path_elements(0.1));
                    }
                    let extent = rects
                        .iter()
                        .filter(|r| (r.y0 - rect.y0).abs() < 0.1)
                        .copied()
                        .reduce(|a, b| a.union(b))
                        .unwrap_or(rect);
                    let (runs, clip) = slice_glyphs(layout, &rects);
                    Some(Slice {
                        runs,
                        clip,
                        path,
                        rect,
                        extent,
                        letter,
                        amll_x: {
                            let mut consumed = 0.0;
                            let mut x = rect.x0;
                            for r in &boxes[index] {
                                if (r.y0 - rect.y0).abs() < 1.0 {
                                    x = r.x0 - consumed;
                                    break;
                                }
                                consumed += r.width();
                            }
                            x
                        },
                    })
                })
                .collect();
            let result = TimedWord {
                bounds,
                slices,
                width,
                before,
            };
            before += width;
            result
        })
        .collect()
}
pub(crate) fn srgb(v: f64) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 {
        (v * 12.92) as f32
    } else {
        (1.055 * v.powf(1.0 / 2.4) - 0.055) as f32
    }
}
/// Skia Spicy glow intensity and blur sigma (`native-glyph-picture.tsx`
/// `drawVoice`): emphasized letters use `clamp01(glow * 1.85) * 0.5` with
/// `(4 + 12 * glow) / 2` sigma, other syllables `clamp01(glow * 0.35) * 0.5`
/// with `(4 + 2 * glow) / 2`. The caller scales the sigma by DPR.
pub(crate) fn spicy_glow(letter: bool, glow: f64) -> (f64, f64) {
    if letter {
        (
            (glow * 1.85).clamp(0.0, 1.0) * 0.5,
            (4.0 + 12.0 * glow) / 2.0,
        )
    } else {
        (
            (glow * 0.35).clamp(0.0, 1.0) * 0.5,
            (4.0 + 2.0 * glow) / 2.0,
        )
    }
}
/// Skia Spicy voice alpha for a settled voice (`native-glyph-picture.tsx`
/// `drawVoice`): background voices are dimmer than their parent lead.
fn spicy_voice_alpha(background: bool, sung: bool) -> f64 {
    match (sung, background) {
        (true, true) => 0.6,
        (true, false) => 0.85,
        (false, true) => 0.3,
        (false, false) => 0.5,
    }
}
/// Packs sharp alpha and the near/far glow split into the existing shared
/// half-resolution Gaussian bases; no additional blur pass or texture is used.
pub(crate) fn encoded(alpha: f64, glow: f64, sigma: f64, scale: f64) -> Color {
    let far = ((sigma / scale - 2.5) / 3.5).clamp(0.0, 1.0);
    Color::new([srgb(alpha), srgb(glow * (1.0 - far)), srgb(glow * far), 1.0])
}
fn pivot(bounds: Rect, origin: f64, scale: f64, x: f64, y: f64) -> Affine {
    let p = (
        bounds.x0 + bounds.width() * origin,
        (bounds.y0 + bounds.y1) * 0.5,
    );
    Affine::translate((x, y))
        * Affine::translate(p)
        * Affine::scale(scale)
        * Affine::translate((-p.0, -p.1))
}
// Bake Skia's p=0 word and emphasized-letter transforms into cold glyphs.
// This uses the same shaped runs, font size, pivots and clips as the live path;
// promotion never changes layout or introduces the 1.0 -> 0.95 size jump.
pub(crate) fn spicy_idle(
    words: &[TimedWord],
    source: &crate::typography::PaintVoice,
    unit: f64,
) -> Scene {
    let mut scene = Scene::new();
    for (geometry, word) in words.iter().zip(&source.words) {
        let meta = word.appearance.as_ref();
        let transform = pivot(
            geometry.bounds,
            meta.map_or(0.5, |m| m.origin),
            0.95,
            0.0,
            0.01 * unit,
        );
        for slice in &geometry.slices {
            let transform = if meta.is_some_and(|m| m.emphasized) {
                transform * pivot(slice.rect, 0.5, 0.95, 0.0, 0.02 * unit)
            } else {
                transform
            };
            if slice.clip {
                scene.push_clip_layer(Fill::NonZero, transform, &slice.path);
            }
            for run in &slice.runs {
                scene
                    .draw_glyphs(&run.font)
                    .font_size(run.size)
                    .normalized_coords(&run.coords)
                    .transform(transform)
                    .brush(Color::new([1.0, 0.0, 0.0, 1.0]))
                    .draw(Fill::NonZero, run.glyphs.iter().copied());
            }
            if slice.clip {
                scene.pop_layer();
            }
        }
    }
    scene
}

impl TrackScene {
    pub fn frame_appearance(
        &self,
        time: f64,
        scroll: f64,
        adjust: &[f64],
        state: &AppearanceState,
        scene: &mut Scene,
        effect: Effect,
    ) -> (f32, f32) {
        if effect == Effect::Baseline {
            return self.frame_prepared_adjusted(time, scroll, adjust, scene);
        }
        scene.reset();
        let window = self.window(time);
        let active = window.active();
        let spicy = self.style() == Some(Style::Spicy);
        let scale = f64::from(self.scale);
        let anchor = self.scroll_anchor();
        // The interlude slot is inserted above its row; this row and every later
        // row are translated by the expanded height without changing prefix.
        let (interlude_row, extra) = self.interlude_shift(time);
        let shift =
            |index: usize| interlude_row.map_or(0.0, |row| if index >= row { extra } else { 0.0 });
        // Skia paints the interlude group before the lead voice, so the
        // collapsing row text stays above the fading dots.
        self.draw_interlude_dots(time, scroll, adjust, state, scene);
        for (index, top) in self.drawing_rows(time, scroll, adjust) {
            let cached = &self.cached[index];
            let y =
                anchor + top - scroll + adjust.get(index).copied().unwrap_or(0.0) + shift(index);
            if y + cached.height < -40.0
                || y > f64::from(self.height) + 40.0
                || !cached.layout_ready()
            {
                continue;
            }
            let row = state.row(index);
            let line = &self.lines()[index];
            // Skia's `active` is the whole presentation package, so a line whose
            // lead has ended keeps its reveal and glow while a background voice
            // is still singing.
            let active_row = time >= line.start && time < line.background_end;
            let row_top = y + cached.top;
            let full_bounds = Rect::new(
                -64.0,
                -64.0,
                f64::from(self.width) + 64.0,
                cached.height + 64.0,
            );
            let detailed = (active_row || row.is_some_and(|r| r.releasing))
                && cached.timed_ready()
                && row.is_some();
            if !detailed {
                let lead_scale = if !spicy && effect.motion() {
                    row.map_or(if state.playing() { 0.97 } else { 1.0 }, |r| r.scale.p)
                } else {
                    1.0
                };
                for (voice_index, voice) in cached.voices.iter().enumerate() {
                    let interval = line
                        .voice(voice_index)
                        .map_or((line.start, line.end), |v| v.interval());
                    let sung = time > interval.1;
                    let pre_active = time < line.start
                        && active.is_some_and(|(start, end)| index >= start && index <= end);
                    let outer = row.map_or(
                        if spicy {
                            if pre_active {
                                1.0
                            } else if sung {
                                0.497
                            } else {
                                0.51
                            }
                        } else {
                            1.0
                        },
                        |r| r.outer,
                    );
                    let alpha = if spicy {
                        spicy_voice_alpha(voice.background, sung) * outer
                    } else {
                        row.map_or(if state.playing() { 0.2 } else { 0.4 }, |r| {
                            r.dark * r.outer
                        }) * voice.alpha
                    };
                    let base = Affine::translate((voice.x, row_top + voice.offset + voice.padding));
                    // AMLL ducks its line scale on background voices.
                    let transform = if !spicy && effect.motion() && !voice.background {
                        base * pivot(
                            Rect::new(0.0, 0.0, cached.lane, cached.content_height),
                            if cached.right { 1.0 } else { 0.0 },
                            lead_scale,
                            0.0,
                            0.0,
                        )
                    } else {
                        base
                    };
                    scene.push_layer(
                        Fill::NonZero,
                        BlendMode::default(),
                        alpha as f32,
                        transform,
                        &full_bounds,
                    );
                    let paragraph = if spicy && time <= line.start && effect.motion() {
                        voice.idle.as_ref().unwrap_or(&voice.plain)
                    } else {
                        &voice.plain
                    };
                    scene.append(paragraph, Some(transform));
                    scene.pop_layer();
                    if let Some(t) = &voice.translation {
                        t.draw(
                            scene,
                            transform,
                            outer * voice.alpha,
                            time,
                            interval,
                            effect.glow(),
                            line.voice(voice_index).map(|source| (source, None)),
                        );
                    }
                }
                continue;
            }
            let row = row.expect("detailed row");
            // AMLL ducking scales the lead voice only.
            let lead_transform = if !spicy && effect.motion() {
                pivot(
                    Rect::new(0.0, 0.0, cached.lane, cached.content_height),
                    if cached.right { 1.0 } else { 0.0 },
                    row.scale.p,
                    0.0,
                    0.0,
                )
            } else {
                Affine::IDENTITY
            };
            for (voice_index, voice) in cached.voices.iter().enumerate() {
                let Some(paint) = line.voice(voice_index) else {
                    continue;
                };
                let (Some(timed), Some(row_words)) =
                    (voice.timed.as_ref(), row.voices.get(voice_index))
                else {
                    continue;
                };
                let interval = paint.interval();
                let sung = time > interval.1;
                let background = voice.background;
                let outer = row.outer * voice.alpha;
                let size = voice.size;
                // Spicy scales background word/letter motion by the parent type size.
                let unit = voice.unit;
                let base = Affine::translate((voice.x, row_top + voice.offset + voice.padding));
                let line_transform = if background {
                    Affine::IDENTITY
                } else {
                    lead_transform
                };
                let fade = timed.first().map_or(size, |w| w.bounds.height()) * 0.56;
                let advanced = if spicy {
                    0.0
                } else {
                    timed
                        .iter()
                        .zip(&paint.words)
                        .enumerate()
                        .map(|(i, (g, w))| {
                            crate::progress(time, w.start, w.end)
                                * (g.width
                                    + if i == 0 { fade * 1.5 } else { 0.0 }
                                    + if i + 1 == timed.len() {
                                        fade * 0.5
                                    } else {
                                        0.0
                                    })
                        })
                        .sum()
                };
                for ((geometry, word), motion) in
                    timed.iter().zip(&paint.words).zip(row_words.words.iter())
                {
                    let meta = word.appearance.as_ref().expect("ABI5 appearance metadata");
                    let word_y = if spicy {
                        motion.motion.y * unit
                    } else {
                        crate::style_timing::amll_float(
                            row.clock.word_position(time, word.start, word.end),
                            word.start,
                            word.end,
                            background,
                        ) * size
                    };
                    let word_transform = if effect.motion() {
                        pivot(
                            geometry.bounds,
                            meta.origin,
                            if spicy { motion.motion.scale } else { 1.0 },
                            0.0,
                            word_y,
                        )
                    } else {
                        Affine::IDENTITY
                    };
                    for slice in &geometry.slices {
                        let letter = slice.letter;
                        let mut gradient = motion.motion.gradient;
                        let mut glow = 0.0;
                        let mut sigma = 0.0;
                        let mut letter_transform = Affine::IDENTITY;
                        if meta.emphasized {
                            if spicy {
                                if let Some(m) = motion.letter_motion.get(letter) {
                                    gradient = m.gradient;
                                    let (alpha, radius) = spicy_glow(true, m.glow);
                                    glow = alpha;
                                    sigma = radius * scale;
                                    if effect.motion() {
                                        letter_transform =
                                            pivot(slice.rect, 0.5, m.scale, 0.0, m.y * unit);
                                    }
                                }
                            } else {
                                let (start, end, index, count, last) =
                                    meta.emphasis.as_ref().map_or(
                                        (
                                            word.start,
                                            word.end,
                                            letter,
                                            word.graphemes.len(),
                                            meta.last,
                                        ),
                                        |g| (g.start, g.end, g.index + letter, g.count, g.last),
                                    );
                                let m = crate::style_timing::amll_emphasis(
                                    time, start, end, index, count, last, background,
                                );
                                glow = m.glow;
                                sigma = m.radius * size / 2.0;
                                if effect.motion() {
                                    letter_transform =
                                        pivot(slice.rect, 0.5, m.scale, m.x * size, m.y * size);
                                }
                            }
                        } else if spicy {
                            let (alpha, radius) = spicy_glow(false, motion.motion.glow);
                            glow = alpha;
                            sigma = radius * scale;
                        }
                        // Skia keeps glow while the row is in the active package.
                        if !effect.glow() || !active_row {
                            glow = 0.0;
                        }
                        let (x, length) = if spicy {
                            (
                                if meta.rtl {
                                    slice.extent.x1 - slice.extent.width() * gradient
                                } else {
                                    slice.extent.x0 + slice.extent.width() * gradient
                                },
                                slice.extent.width() * 0.2 * if meta.rtl { -1.0 } else { 1.0 },
                            )
                        } else {
                            // Shared linear word advance; continuation rows consume prior fragment width.
                            let x = slice.amll_x + advanced - geometry.before - fade * 2.0;
                            (x, fade)
                        };
                        let (bright, dark) = if spicy && !active_row {
                            // A settled/dimmed Spicy voice paints its own sung or
                            // unsung alpha instead of the reveal shader.
                            let alpha = spicy_voice_alpha(background, sung);
                            (alpha, alpha)
                        } else if spicy {
                            if background { (0.6, 0.3) } else { (0.85, 0.5) }
                        } else {
                            (row.bright, row.dark)
                        };
                        let glow_bright = if spicy { glow } else { glow * bright };
                        let glow_dark = if spicy { glow } else { glow * dark };
                        let mut brush =
                            Gradient::new_linear((x, slice.rect.y0), (x + length, slice.rect.y0))
                                .with_stops([
                                    encoded(bright * outer, glow_bright * outer, sigma, scale),
                                    encoded(dark * outer, glow_dark * outer, sigma, scale),
                                ]);
                        brush.interpolation_cs = ColorSpaceTag::LinearSrgb;
                        let transform = base * line_transform * word_transform * letter_transform;
                        if slice.clip {
                            scene.push_clip_layer(Fill::NonZero, transform, &slice.path);
                        }
                        for run in &slice.runs {
                            scene
                                .draw_glyphs(&run.font)
                                .font_size(run.size)
                                .normalized_coords(&run.coords)
                                .transform(transform)
                                .brush(&brush)
                                .draw(Fill::NonZero, run.glyphs.iter().copied());
                        }
                        if slice.clip {
                            scene.pop_layer();
                        }
                    }
                }
                if let Some(t) = &voice.translation {
                    t.draw(
                        scene,
                        base * line_transform,
                        outer,
                        time,
                        interval,
                        effect.glow(),
                        Some((paint, Some(row_words))),
                    );
                }
            }
        }
        let first = active.map_or(window.focus.max(0) as usize, |(start, _)| start);
        let last = active.map_or(first, |(_, end)| end);
        let next = (last.max(first) + 1).min(self.lines().len() - 1);
        let adjust_at = |index: usize| adjust.get(index).copied().unwrap_or(0.0);
        let mut band_top = (anchor + self.row_top(first) - scroll + adjust_at(first) + shift(first)
            - 10.0 * scale) as f32;
        let band_bottom = (anchor + self.row_top(next) - scroll
            + adjust_at(next)
            + shift(next)
            + self.cached[next].height
            + 10.0 * scale) as f32;
        // The slot sits ABOVE the upcoming row. When visual priming moves
        // the protected range to that row, keep the dots and their shadow in
        // the same unblurred group as Skia (AMLL has no dot blur at all).
        if let Some((row, _)) = self.interlude_at(time) {
            let dot_top = anchor + self.row_top(row) + self.cached[row].top - scroll
                + adjust_at(row)
                - 32.0 * scale;
            band_top = band_top.min(dot_top as f32);
        }
        (band_top, band_bottom)
    }

    /// Spicy bullet dots / AMLL breathing dots for the active interlude. Drawn
    /// before the rows at the padded slot origin so no row layer clips them.
    pub(crate) fn draw_interlude_dots(
        &self,
        time: f64,
        scroll: f64,
        adjust: &[f64],
        state: &AppearanceState,
        scene: &mut Scene,
    ) {
        let Some((row, slot)) = self.interlude_at(time) else {
            return;
        };
        let cached = &self.cached[row];
        let font = cached.size;
        if font <= 0.0 || cached.lane <= 0.0 {
            return;
        }
        let spicy = self.style() == Some(Style::Spicy);
        let top = self.scroll_anchor() + self.row_top(row) + cached.top - scroll
            + adjust.get(row).copied().unwrap_or(0.0);
        let slot_height =
            crate::interlude::slot_height(&slot, spicy, font, f64::from(self.width), time);
        if top + slot_height < -40.0 || top > f64::from(self.height) + 40.0 {
            return;
        }
        let dpr = f64::from(self.scale);
        if spicy {
            if state.interlude.row() != Some(row) {
                return;
            }
            let (group_scale, group_opacity) =
                crate::interlude::spicy_group(slot.start, slot.end, time);
            if group_opacity <= 0.001 || group_scale <= 0.001 {
                return;
            }
            let Some(dot) = &self.dot_glyph else { return };
            let cell = dot.width;
            let gap = crate::interlude::SPICY_GAP * dpr;
            let width = cell * 3.0 + gap * 2.0;
            let x0 = if cached.right {
                cached.x + cached.lane - width
            } else {
                cached.x
            };
            let box_height = dot.height;
            let origin_x = x0 + width * 0.5;
            let origin_y = top + box_height * 0.5;
            for index in 0..3 {
                let (dot_scale, dot_y, glow, opacity) = state.interlude.dot(index);
                let cx = x0 + cell * 0.5 + index as f64 * (cell + gap);
                let cy = origin_y + dot_y * font;
                let px = origin_x + (cx - origin_x) * group_scale;
                let py = origin_y + (cy - origin_y) * group_scale;
                let dot_transform = Affine::translate((px, py))
                    * Affine::scale(dot_scale * group_scale)
                    * Affine::translate((-cell * 0.5, -box_height * 0.5));
                // Apply opacity to the combined glyph+shadow, as Animated.View
                // does. Draw the shadow at its continuously varying local sigma
                // instead of mixing the shared 2.5/6px row-blur bases.
                // LIMITATION: Vello 0.12 has no arbitrary glyph-mask blur.
                // This rounded ink-bounds shadow is an approximation, not
                // Skia glyph-mask parity; see the review follow-up report.
                scene.push_layer(
                    Fill::NonZero,
                    BlendMode::default(),
                    (group_opacity * opacity).clamp(0.0, 1.0) as f32,
                    dot_transform,
                    &Rect::new(
                        -32.0 * dpr,
                        -32.0 * dpr,
                        cell + 32.0 * dpr,
                        box_height + 32.0 * dpr,
                    ),
                );
                let shadow = (glow * 0.9).clamp(0.0, 1.0);
                if shadow > 0.0 {
                    scene.draw_blurred_rounded_rect(
                        dot_transform,
                        dot.ink,
                        Color::new([
                            1.0,
                            0.0,
                            0.0,
                            (crate::interlude::SPICY_ALPHA * shadow) as f32,
                        ]),
                        dot.ink.width().min(dot.ink.height()) * 0.5,
                        (4.0 + 6.0 * glow) / 2.0 * dpr,
                    );
                }
                scene
                    .draw_glyphs(&dot.font)
                    .font_size(dot.size)
                    .transform(dot_transform)
                    .brush(Color::new([
                        1.0,
                        0.0,
                        0.0,
                        crate::interlude::SPICY_ALPHA as f32,
                    ]))
                    .draw(Fill::NonZero, [dot.glyph].into_iter());
                scene.pop_layer();
            }
        } else {
            let size = font * crate::interlude::AMLL_DIAMETER;
            let gap = font * crate::interlude::AMLL_GAP + crate::interlude::AMLL_MARGIN * dpr;
            let width = size * 3.0 + gap * 2.0;
            let x0 = if cached.right {
                cached.x + cached.lane - width
            } else {
                cached.x
            };
            let (group_scale, dots) = crate::interlude::amll_snapshot(
                time,
                slot.start,
                slot.end - crate::interlude::AMLL_SNAPSHOT_BEFORE_END,
            );
            if group_scale <= 0.001 {
                return;
            }
            let origin_x = if cached.right { x0 + width } else { x0 };
            let origin_y = top + font * crate::interlude::AMLL_TOP + size * 0.5;
            for (index, alpha) in dots.iter().enumerate() {
                let cx = x0 + size * 0.5 + index as f64 * (size + gap);
                let px = origin_x + (cx - origin_x) * group_scale;
                // Red is coverage; green/blue are exclusively glow emission.
                // White here silently added a halo even though AMLL has none.
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    encoded(
                        *alpha * state.row(row).map_or(1.0, |r| r.outer),
                        0.0,
                        0.0,
                        dpr,
                    ),
                    None,
                    &Circle::new((px, origin_y), size * 0.5 * group_scale),
                );
            }
        }
    }
}
