//! Live timed glyph masks. Reuses the existing immutable paragraph geometry;
//! never records/caches an animated glyph picture or creates per-line blur filters.
use crate::{
    appearance::{AppearanceState, Effect},
    scene::TrackScene,
    typography::{Style, WordRange},
};
use vello::{
    Scene,
    kurbo::{Affine, BezPath, Rect, Shape},
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
struct Glyphs {
    font: parley::FontData,
    size: f32,
    coords: Vec<i16>,
    glyphs: Vec<vello::Glyph>,
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
fn encoded(alpha: f64, glow: f64, sigma: f64, scale: f64) -> Color {
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
impl TrackScene {
    pub fn frame_appearance(
        &self,
        time: f64,
        scroll: f64,
        state: &AppearanceState,
        scene: &mut Scene,
        effect: Effect,
    ) -> (f32, f32) {
        if effect == Effect::Baseline {
            return self.frame_prepared(time, scroll, scene);
        }
        scene.reset();
        let active = crate::focus(&self.lines, time);
        let spicy = self.style() == Some(Style::Spicy);
        let scale = f64::from(self.scale);
        let anchor = self.scroll_anchor();
        for (index, cached) in self.cached.iter().enumerate() {
            let y = anchor + self.prefix[index] - scroll;
            if y + cached.height < -40.0
                || y > f64::from(self.height) + 40.0
                || cached.layout.is_none()
            {
                continue;
            }
            let row = state.row(index);
            let singing = time >= self.lines[index].start && time < self.lines[index].end;
            let base = Affine::translate((cached.x, y + cached.top));
            let full_bounds = Rect::new(
                -64.0,
                -64.0,
                f64::from(self.width) + 64.0,
                cached.height + 64.0,
            );
            let detailed = (singing || row.is_some_and(|r| r.releasing))
                && cached.timed.is_some()
                && row.is_some();
            if !detailed {
                let alpha = if spicy {
                    (if time > self.lines[index].end {
                        0.85
                    } else {
                        0.5
                    }) * row.map_or(
                        if time > self.lines[index].end {
                            0.497
                        } else {
                            0.51
                        },
                        |r| r.outer,
                    )
                } else {
                    row.map_or(0.2, |r| r.dark * r.outer)
                };
                let transform = if !spicy && effect.motion() {
                    base * pivot(
                        Rect::new(0.0, 0.0, cached.lane, cached.content_height),
                        if cached.right { 1.0 } else { 0.0 },
                        row.map_or(if state.playing() { 0.97 } else { 1.0 }, |r| r.scale.p),
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
                scene.append(&cached.plain, Some(transform));
                scene.pop_layer();
                if let Some(t) = &cached.translation {
                    t.draw(
                        scene,
                        transform,
                        row.map_or(
                            if spicy {
                                if time > self.lines[index].end {
                                    0.497
                                } else {
                                    0.51
                                }
                            } else {
                                1.0
                            },
                            |r| r.outer,
                        ),
                    );
                }
                continue;
            }
            let row = row.expect("detailed row");
            let voice = self.lines[index].paint.as_ref().expect("prepared voice");
            let timed = cached.timed.as_ref().expect("timed geometry");
            let line_transform = if !spicy && effect.motion() {
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
            let size = cached.size;
            let fade = timed.first().map_or(size, |w| w.bounds.height()) * 0.56;
            let advanced = if spicy {
                0.0
            } else {
                timed
                    .iter()
                    .zip(&voice.words)
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
            for ((geometry, word), motion) in timed.iter().zip(&voice.words).zip(&row.words) {
                let meta = word.appearance.as_ref().expect("ABI5 appearance metadata");
                let word_y = if spicy {
                    motion.motion.y * size
                } else {
                    crate::style_timing::amll_float(
                        row.clock.word_position(time, word.start, word.end),
                        word.start,
                        word.end,
                        false,
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
                                glow = (m.glow * 1.85).clamp(0.0, 1.0) * 0.5;
                                sigma = (4.0 + 12.0 * m.glow) / 2.0 * scale;
                                if effect.motion() {
                                    letter_transform =
                                        pivot(slice.rect, 0.5, m.scale, 0.0, m.y * size);
                                }
                            }
                        } else {
                            let (start, end, index, count, last) = meta.emphasis.as_ref().map_or(
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
                                time, start, end, index, count, last, false,
                            );
                            glow = m.glow;
                            sigma = m.radius * size / 2.0;
                            if effect.motion() {
                                letter_transform =
                                    pivot(slice.rect, 0.5, m.scale, m.x * size, m.y * size);
                            }
                        }
                    } else if spicy {
                        glow = (motion.motion.glow * 0.35).clamp(0.0, 1.0) * 0.5;
                        sigma = (4.0 + 2.0 * motion.motion.glow) / 2.0 * scale;
                    }
                    if !effect.glow() || !singing {
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
                    let (bright, dark) = if spicy && !singing {
                        let alpha = if time > self.lines[index].end {
                            0.85
                        } else {
                            0.5
                        };
                        (alpha, alpha)
                    } else if spicy {
                        (0.85, 0.5)
                    } else {
                        (row.bright, row.dark)
                    };
                    let glow_bright = if spicy { glow } else { glow * bright };
                    let glow_dark = if spicy { glow } else { glow * dark };
                    let mut brush =
                        Gradient::new_linear((x, slice.rect.y0), (x + length, slice.rect.y0))
                            .with_stops([
                                encoded(bright * row.outer, glow_bright * row.outer, sigma, scale),
                                encoded(dark * row.outer, glow_dark * row.outer, sigma, scale),
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
            if let Some(t) = &cached.translation {
                t.draw(scene, base * line_transform, row.outer);
            }
        }
        let first = self
            .lines
            .iter()
            .position(|l| time >= l.start && time < l.end)
            .unwrap_or(active)
            .min(active);
        let last = self
            .lines
            .iter()
            .rposition(|l| time >= l.start && time < l.end)
            .unwrap_or(active)
            .max(active);
        let next = (last + 1).min(self.lines.len() - 1);
        (
            (anchor + self.prefix[first] - scroll - 10.0 * scale) as f32,
            (anchor + self.prefix[next] - scroll + self.cached[next].height + 10.0 * scale) as f32,
        )
    }
}
