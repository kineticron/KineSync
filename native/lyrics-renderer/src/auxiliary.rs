//! Translations are shaped only with their owning row.
use crate::{
    style_timing::bezier,
    timed_scene::{Glyphs, encoded},
    typography::{Fonts, PaintVoice, Settings, Style},
};
use parley::{Alignment, AlignmentOptions, LayoutContext, PositionedLayoutItem};
use skrifa::{
    FontRef, GlyphId, MetadataProvider,
    bitmap::{BitmapFormat, Origin},
    instance::{NormalizedCoord, Size},
    raw::TableProvider,
    string::StringId,
};
use std::sync::Mutex;
use vello::{
    Scene,
    kurbo::{Affine, Rect},
    low_level::vello_encoding::Patch,
    peniko::{
        BlendMode, Blob, BrushRef, Color, Compose, Fill, Gradient, Mix, color::ColorSpaceTag,
    },
};

const TRANSITION_MS: f64 = 300.0;
const FUTURE_OPACITY: f64 = 0.51;
const SUNG_OPACITY: f64 = 0.497;

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct Policy {
    pub size: f32,
    pub leading: f32,
    pub weight: f32,
    pub width: f32,
    pub margin: f32,
    pub x: f32,
    #[serde(skip_serializing_if = "is_zero")]
    bottom: f32,
    #[serde(skip)]
    spicy: bool,
    #[serde(skip)]
    background: bool,
}

fn is_zero(value: &f32) -> bool {
    *value == 0.0
}

impl Policy {
    pub fn voice(
        settings: &Settings,
        dpr: f32,
        background: bool,
        font_size: f32,
        text_width: f32,
    ) -> Self {
        if settings.style == Style::Spicy {
            let size = font_size * if background { 0.56 } else { 0.45 };
            let inset = (size * 0.25).min((text_width - dpr).max(0.0));
            // Express the overlay's block padding in translation ems so it
            // follows the mobile type scale and DPR along with the glyphs.
            return Self {
                size,
                leading: size * if background { 1.2 } else { 13.0 / 11.0 },
                weight: if background { 700.0 } else { 900.0 },
                width: (text_width - inset).max(dpr),
                margin: size * if background { -0.2 } else { 0.25 },
                x: inset,
                bottom: size * if background { 0.625 } else { 0.75 },
                spicy: true,
                background,
            };
        }
        let size = (10.0 * dpr).max(font_size * 0.5);
        Self {
            size,
            leading: size * 1.5,
            weight: 700.0,
            width: text_width.max(dpr),
            margin: 0.0,
            x: 0.0,
            bottom: 0.0,
            spicy: false,
            background,
        }
    }
}
struct WordInk {
    index: usize,
    rect: Rect,
    first_byte: usize,
    inline_offset: f64,
    inline_width: f64,
    coverage_bounds: Option<Rect>,
    runs: Vec<Glyphs>,
    fallback: Option<Box<Scene>>,
}

struct WordFill {
    pieces: Vec<WordInk>,
    groups: Vec<(usize, usize, usize)>,
    smooth: bool,
    history: Mutex<History>,
}

struct History {
    time: f64,
    gradients: Vec<f64>,
}

fn smooth_fill(text: &str, ratio: f64) -> bool {
    !(0.7..=1.45).contains(&ratio)
        || text.chars().any(|c| {
            matches!(c,
                '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
                | '\u{ac00}'..='\u{d7af}' | '\u{1100}'..='\u{11ff}' | '\u{0600}'..='\u{06ff}'
                | '\u{0590}'..='\u{05ff}' | '\u{0400}'..='\u{04ff}' | '\u{0e00}'..='\u{0e7f}'
                | '\u{0370}'..='\u{03ff}'
            )
        })
}

fn segment_gradient(progress: f64, index: usize, count: usize) -> f64 {
    -20.0 + 120.0 * (progress * count as f64 - index as f64).clamp(0.0, 1.0)
}

fn ordinal_progress(count: usize, gradients: impl Iterator<Item = f64>) -> f64 {
    let mut sung = 0;
    let mut active = None;
    for (i, gradient) in gradients.enumerate() {
        if gradient >= 90.0 {
            sung = i + 1;
        } else if gradient > -15.0 {
            active = Some(i as f64 + (gradient + 20.0) / 120.0);
        }
    }
    active.unwrap_or(sung as f64) / count as f64
}

fn follow_gradient(target: f64, previous: f64) -> f64 {
    let target = target.max(previous);
    let delta = target - previous;
    if target >= 96.0 {
        100.0
    } else if delta <= 8.0 {
        previous + 0.68 * delta
    } else {
        target
    }
}

fn translation_words(text: &str) -> impl Iterator<Item = &str> {
    // ECMAScript includes the BOM and excludes NEL.
    text.split(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{0085}'))
        .filter(|word| !word.is_empty())
}

fn coverage_bounds(run: &parley::Run<'_, ()>, glyphs: &[vello::Glyph]) -> Option<Rect> {
    let font = FontRef::from_index(run.font().data.as_ref(), run.font().index).ok()?;
    let size = Size::new(run.font_size());
    let coords: Vec<_> = run
        .normalized_coords()
        .iter()
        .map(|coord| NormalizedCoord::from_bits(coord.to_bits()))
        .collect();
    let location = coords.as_slice();
    let metrics = font.metrics(size, location);
    let outlines = font.glyph_metrics(size, location);
    let colors = font.color_glyphs();
    let bitmaps = font.bitmap_strikes();
    let apple_emoji = bitmaps.format() == Some(BitmapFormat::Sbix)
        && font
            .localized_strings(StringId::POSTSCRIPT_NAME)
            .any(|name| name.chars().eq("AppleColorEmoji".chars()));

    glyphs
        .iter()
        .filter_map(|glyph| {
            let id = GlyphId::new(glyph.id);
            let x = f64::from(glyph.x);
            let y = f64::from(glyph.y);
            let bounds = if let Some(color) = colors.get(id) {
                // COLRv0 has no clip box. The font bounds conservatively cover its layers.
                color.bounding_box(location, size).or(metrics.bounds)
            } else if let Some(bitmap) = bitmaps.glyph_for_size(size, id) {
                // Match Vello's bitmap placement, including sbix and bottom-origin strikes.
                let scale = f64::from(run.font_size() / bitmap.ppem_y);
                let units = run.font_size() / f32::from(metrics.units_per_em);
                let (dx, dy) = if apple_emoji {
                    (0.0, f64::from(run.font_size()) / 8.0)
                } else {
                    (
                        f64::from(bitmap.bearing_x * units),
                        -f64::from(bitmap.bearing_y * units),
                    )
                };
                let height = f64::from(bitmap.height);
                let left = x + dx + scale * f64::from(bitmap.inner_bearing_x);
                let top = y + dy
                    - scale
                        * (f64::from(bitmap.inner_bearing_y)
                            + if bitmap.placement_origin == Origin::BottomLeft {
                                height
                            } else {
                                0.0
                            });
                return Some(Rect::new(
                    left,
                    top,
                    left + scale * f64::from(bitmap.width),
                    top + scale * height,
                ));
            } else {
                outlines.bounds(id)
            }?;
            Some(Rect::new(
                x + f64::from(bounds.x_min),
                y - f64::from(bounds.y_max),
                x + f64::from(bounds.x_max),
                y - f64::from(bounds.y_min),
            ))
        })
        .reduce(|a, b| a.union(b))
}

fn prepare_words(layout: &parley::Layout<()>, text: &str, source: &PaintVoice) -> WordFill {
    let mut ranges: Vec<_> = translation_words(text)
        .map(|word| {
            let start = word.as_ptr() as usize - text.as_ptr() as usize;
            start..start + word.len()
        })
        .collect();
    // The upstream inline span owns the separator before the next span.
    for i in 1..ranges.len() {
        ranges[i - 1].end = ranges[i].start;
    }
    let ratio = ranges.len() as f64 / source.words.len() as f64;
    let mut groups: Vec<_> = (0..ranges.len())
        .map(|i| {
            (
                ((i as f64 / ratio.max(0.01)).floor() as usize).min(source.words.len() - 1),
                0,
                1,
            )
        })
        .collect();
    let mut first = 0;
    while first < groups.len() {
        let mapped = groups[first].0;
        let size = groups[first..].partition_point(|group| group.0 == mapped);
        for (index, group) in groups[first..first + size].iter_mut().enumerate() {
            *group = (mapped, index, size);
        }
        first += size;
    }
    let mut pieces: Vec<WordInk> = Vec::new();
    for line in layout.lines() {
        let metrics = line.metrics();
        let mut current: Option<usize> = None;
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(positioned) = item else {
                continue;
            };
            let run = positioned.run();
            let mut positioned_glyphs = positioned.positioned_glyphs();
            let mut x = positioned.offset();
            let color = has_color_glyphs(run.font());
            let coords: Vec<_> = run
                .normalized_coords()
                .iter()
                .map(|c| c.to_bits())
                .collect();
            let mut clusters = run.visual_clusters().peekable();
            while let Some(cluster) = clusters.peek() {
                let owner = |bytes: std::ops::Range<usize>| {
                    let i = ranges.partition_point(|word| word.end <= bytes.start);
                    ranges
                        .get(i)
                        .filter(|word| word.start < bytes.end)
                        .map(|_| i)
                };
                let index = owner(cluster.text_range());
                let left = x;
                let mut glyphs = Vec::new();
                let mut first_byte = usize::MAX;
                while clusters
                    .peek()
                    .is_some_and(|c| owner(c.text_range()) == index)
                {
                    let cluster = clusters.next().unwrap();
                    first_byte = first_byte.min(cluster.text_range().start);
                    // Cluster glyph counts establish ownership. Positioned glyphs
                    // establish placement, including ligatures in visual RTL order.
                    for _ in cluster.glyphs() {
                        let glyph = positioned_glyphs.next().expect("glyph in positioned run");
                        if index.is_some() {
                            glyphs.push(vello::Glyph {
                                id: glyph.id,
                                x: glyph.x,
                                y: glyph.y,
                            });
                        }
                    }
                    x += cluster.advance();
                }
                let Some(index) = index else {
                    current = None;
                    continue;
                };
                let rect = Rect::new(
                    f64::from(left),
                    f64::from(metrics.block_min_coord),
                    f64::from(x),
                    f64::from(metrics.block_max_coord),
                );
                let piece = match current {
                    Some(i) if pieces[i].index == index => &mut pieces[i],
                    _ => {
                        current = Some(pieces.len());
                        pieces.push(WordInk {
                            index,
                            rect,
                            first_byte,
                            inline_offset: 0.0,
                            inline_width: 0.0,
                            coverage_bounds: None,
                            runs: Vec::new(),
                            fallback: None,
                        });
                        pieces.last_mut().unwrap()
                    }
                };
                piece.rect = piece.rect.union(rect);
                piece.first_byte = piece.first_byte.min(first_byte);
                if glyphs.is_empty() {
                    continue;
                }
                if color {
                    if let Some(bounds) = coverage_bounds(run, &glyphs) {
                        // Leave room for sampling at the coverage clip edge.
                        let bounds = bounds.inflate(1.0, 1.0);
                        piece.coverage_bounds =
                            Some(piece.coverage_bounds.map_or(bounds, |b| b.union(bounds)));
                    }
                    piece
                        .fallback
                        .get_or_insert_with(|| Box::new(Scene::new()))
                        .draw_glyphs(run.font())
                        .font_size(run.font_size())
                        .normalized_coords(&coords)
                        .brush(Color::WHITE)
                        .draw(Fill::NonZero, glyphs.into_iter());
                } else {
                    piece.runs.push(Glyphs {
                        font: run.font().clone(),
                        size: run.font_size(),
                        coords: coords.clone(),
                        glyphs,
                    });
                }
            }
            debug_assert!(positioned_glyphs.next().is_none());
        }
    }
    // Place logical fragments in inline order, then measure each slice from the
    // physical left edge of the reconstructed box. The gradient stays at 90deg.
    let mut order: Vec<_> = (0..pieces.len()).collect();
    order.sort_unstable_by_key(|&i| (pieces[i].index, pieces[i].first_byte));
    let mut widths = vec![0.0; ranges.len()];
    for i in order {
        let piece = &mut pieces[i];
        piece.inline_offset = widths[piece.index];
        widths[piece.index] += piece.rect.width();
    }
    for piece in &mut pieces {
        piece.inline_width = widths[piece.index];
        if layout.is_rtl() {
            piece.inline_offset = piece.inline_width - piece.inline_offset - piece.rect.width();
        }
    }
    WordFill {
        pieces,
        smooth: smooth_fill(&source.text, ratio),
        history: Mutex::new(History {
            time: f64::NAN,
            gradients: vec![f64::NAN; ranges.len()],
        }),
        groups,
    }
}

enum Ink {
    Amll {
        scene: Box<Scene>,
        bounds: Rect,
    },
    Spicy {
        runs: Vec<Glyphs>,
        fallback: Option<Box<Scene>>,
        bounds: Rect,
        gradient_box: (f64, f64),
        background: bool,
        words: Option<WordFill>,
        settled: Option<Box<[Scene; 2]>>,
    },
}

pub(crate) struct Translation {
    ink: Ink,
    origin: Affine,
    pub extra_height: f64,
    pub glyph_count: usize,
    pub missing_glyphs: usize,
    pub diagnostics: serde_json::Value,
}

fn has_color_glyphs(font: &parley::FontData) -> bool {
    FontRef::from_index(font.data.as_ref(), font.index).is_ok_and(|font| {
        (font.colr().is_ok() && font.cpal().is_ok()) || !font.bitmap_strikes().is_empty()
    })
}

// Follow the existing media clock for both render paths, including after
// seeks and cache promotion. A short voice releases from its entry level.
fn spicy_levels(time: f64, (start, end): (f64, f64)) -> (f64, f64) {
    let ease = |elapsed| bezier(elapsed / TRANSITION_MS, 0.37, 0.0, 0.63, 1.0);
    let entry = ease(time.min(end) - start);
    let exit = ease(time - end);
    let mix = |from, to, t| from + (to - from) * t;
    let entered = mix(FUTURE_OPACITY, 1.0, entry);
    (mix(entered, SUNG_OPACITY, exit), entry * (1.0 - exit))
}

impl Translation {
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        text: &str,
        policy: &Policy,
        right: bool,
        main_height: f64,
        fonts: &mut Fonts,
        layouts: &mut LayoutContext<()>,
        collect_diagnostics: bool,
        source: Option<&PaintVoice>,
    ) -> Self {
        let mut p = policy.clone();
        let timed = source.filter(|v| p.spicy && !v.words.is_empty());
        let normalized;
        let shape_text = if timed.is_some() {
            normalized = translation_words(text).collect::<Vec<_>>().join(" ");
            normalized.as_str()
        } else {
            text
        };
        let mut layout = crate::scene::shape_with_wrap(
            shape_text,
            &mut fonts.context,
            layouts,
            p.size,
            p.leading,
            p.weight,
            "'SF Pro Display', sans-serif",
            &[],
            0.0,
            timed.is_some(),
        );
        layout.break_all_lines(Some(p.width));
        let alignment = if p.spicy {
            if right {
                Alignment::Right
            } else {
                p.x = 0.0;
                Alignment::Left
            }
        } else if right {
            Alignment::End
        } else {
            Alignment::Start
        };
        layout.align(
            alignment,
            AlignmentOptions {
                align_when_overflowing: p.spicy,
                ..AlignmentOptions::default()
            },
        );
        let words = timed.map(|v| prepare_words(&layout, shape_text, v));
        let mut scene = Scene::new();
        let mut runs = Vec::new();
        let mut fallback = None;
        let mut glyph_count = 0;
        let mut missing_glyphs = 0;
        let mut faces = Vec::new();
        let y = main_height + f64::from(p.margin);
        let origin = Affine::translate((f64::from(p.x), y));
        for line in layout.lines() {
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(gr) = item {
                    let run = gr.run();
                    if collect_diagnostics {
                        let face = fonts.describe(run.font());
                        faces.push(serde_json::json!({"face":face,"text_bytes":[run.text_range().start,run.text_range().end],"requested_attributes":format!("{:?}",run.font_attrs()),"normalized_coords":run.normalized_coords().iter().map(|c|c.to_bits()).collect::<Vec<_>>() }));
                    }
                    let coords = run
                        .normalized_coords()
                        .iter()
                        .map(|c| c.to_bits())
                        .collect::<Vec<_>>();
                    let glyphs = gr.positioned_glyphs().map(|g| {
                        glyph_count += 1;
                        missing_glyphs += usize::from(g.id == 0);
                        vello::Glyph {
                            id: g.id,
                            x: g.x,
                            y: g.y,
                        }
                    });
                    if words.is_some() {
                        glyphs.for_each(drop);
                    } else if p.spicy && has_color_glyphs(run.font()) {
                        // Vello decodes bitmap glyphs during encoding. Keep the
                        // image handles in the coverage scene for later frames.
                        fallback
                            .get_or_insert_with(|| Box::new(Scene::new()))
                            .draw_glyphs(run.font())
                            .font_size(run.font_size())
                            .normalized_coords(&coords)
                            .brush(Color::WHITE)
                            .draw(Fill::NonZero, glyphs);
                    } else if p.spicy {
                        runs.push(Glyphs {
                            font: run.font().clone(),
                            size: run.font_size(),
                            coords,
                            glyphs: glyphs.collect(),
                        });
                    } else {
                        scene
                            .draw_glyphs(run.font())
                            .font_size(run.font_size())
                            .normalized_coords(&coords)
                            .transform(origin)
                            .brush(encoded(0.3, 0.0, 0.0, 1.0))
                            .draw(Fill::NonZero, glyphs);
                    }
                }
            }
        }
        let height = f64::from(layout.height());
        let ink = if p.spicy {
            let top = if p.background {
                0.0
            } else {
                -f64::from(p.margin)
            };
            Ink::Spicy {
                runs,
                fallback,
                bounds: Rect::new(-64.0, -64.0, f64::from(p.width) + 64.0, height + 64.0),
                gradient_box: (top, height + f64::from(p.bottom) - top),
                background: p.background,
                words,
                settled: None,
            }
        } else {
            Ink::Amll {
                scene: Box::new(scene),
                bounds: Rect::new(
                    -64.0,
                    y - 64.0,
                    f64::from(p.width) + 64.0,
                    y + height + 64.0,
                ),
            }
        };
        let mut translation = Self {
            ink,
            origin,
            extra_height: f64::from(p.margin) + height + f64::from(p.bottom),
            glyph_count,
            missing_glyphs,
            diagnostics: if collect_diagnostics {
                serde_json::json!({"text":text,"policy":p,"height":height,"y":y,"line_count":layout.len(),"faces":faces})
            } else {
                serde_json::Value::Null
            },
        };
        translation.prepare_settled(timed);
        translation
    }

    fn prepare_settled(&mut self, source: Option<&PaintVoice>) {
        let Ink::Spicy {
            fallback, words, ..
        } = &self.ink
        else {
            return;
        };
        if fallback.is_some()
            || words
                .as_ref()
                .is_some_and(|words| words.pieces.iter().any(|piece| piece.fallback.is_some()))
        {
            return;
        }

        // Use the live painter at full settlement so the brushes, glyph order,
        // and per-piece geometry are identical to the animated path.
        let interval = (0.0, 1.0);
        let scenes = [-1.0, interval.1 + TRANSITION_MS].map(|time| {
            let mut scene = Scene::new();
            self.draw_inner(
                &mut scene,
                Affine::IDENTITY,
                1.0,
                time,
                interval,
                false,
                source.map(|voice| (voice, None)),
            );
            scene
        });
        self.reset_word_fill();
        if let Ink::Spicy { settled, .. } = &mut self.ink {
            *settled = Some(Box::new(scenes));
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &self,
        scene: &mut Scene,
        transform: Affine,
        amll_outer: f64,
        time: f64,
        interval: (f64, f64),
        glow: bool,
        source: Option<(&PaintVoice, Option<&crate::appearance::RowVoice>)>,
    ) {
        let transform = if matches!(&self.ink, Ink::Spicy { .. }) {
            transform * self.origin
        } else {
            transform
        };
        self.draw_inner(scene, transform, amll_outer, time, interval, glow, source);
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_inner(
        &self,
        scene: &mut Scene,
        transform: Affine,
        amll_outer: f64,
        time: f64,
        interval: (f64, f64),
        glow: bool,
        source: Option<(&PaintVoice, Option<&crate::appearance::RowVoice>)>,
    ) {
        match &self.ink {
            Ink::Amll { scene: ink, bounds } => {
                scene.push_layer(
                    Fill::NonZero,
                    BlendMode::default(),
                    amll_outer as f32,
                    transform,
                    bounds,
                );
                scene.append(ink, Some(transform));
                scene.pop_layer();
            }
            Ink::Spicy {
                runs,
                fallback,
                bounds,
                gradient_box,
                background,
                words,
                settled,
            } => {
                let (start, end) = interval;
                if let Some(scenes) = settled
                    && (words.is_none() || source.is_some())
                {
                    let sung = time > end && time - end >= TRANSITION_MS && time >= start;
                    if sung || time < start.min(end) {
                        if let Some(words) = words {
                            words.settle(time, sung);
                        }
                        scene.append(&scenes[usize::from(sung)], Some(transform));
                        return;
                    }
                }
                let (top, height) = *gradient_box;
                let (opacity, active) = spicy_levels(time, interval);
                let (dim, bright) = if *background {
                    (0.42, 0.75)
                } else {
                    (0.50, 0.85)
                };
                let emission = if glow && !*background {
                    0.4 * active
                } else {
                    0.0
                };
                // Select the widest existing glow basis (about 2.4pt sigma
                // before reconstruction). It approximates the wider CSS halo.
                let mask = |alpha| encoded(alpha * opacity, emission, 6.0, 1.0);
                if let (Some(words), Some((source, cached))) = (words, source) {
                    words.draw(
                        scene,
                        transform,
                        time,
                        interval,
                        source,
                        cached,
                        opacity,
                        if glow { active } else { 0.0 },
                        *background,
                    );
                    return;
                }
                let reveal = crate::progress(time, interval.0, interval.1);
                let gradient;
                let brush: BrushRef<'_> = if reveal == 0.0 || height <= 0.0 {
                    mask(dim).into()
                } else if reveal == 1.0 {
                    mask(bright).into()
                } else {
                    let edge = top + (1.2 * reveal - 0.2) * height;
                    gradient = Gradient::new_linear((0.0, edge), (0.0, edge + 0.2 * height))
                        .with_stops([mask(bright), mask(dim)])
                        .with_interpolation_cs(ColorSpaceTag::LinearSrgb);
                    (&gradient).into()
                };
                paint_mask(scene, transform, *bounds, brush, runs, fallback.as_deref());
            }
        }
    }

    pub(crate) fn reset_word_fill(&mut self) {
        if let Ink::Spicy {
            words: Some(words), ..
        } = &mut self.ink
        {
            let history = words.history.get_mut().unwrap();
            history.time = f64::NAN;
            history.gradients.fill(f64::NAN);
        }
    }

    pub fn animation_window(&self, source: &crate::typography::PaintVoice) -> Option<(f64, f64)> {
        matches!(&self.ink, Ink::Spicy { .. }).then(|| {
            let (start, end) = source.interval();
            (start, end + TRANSITION_MS)
        })
    }
}

fn source_gradient(
    word: &crate::typography::PaintWord,
    cached: Option<&crate::style_timing::WordState>,
    time: f64,
) -> f64 {
    if let Some(cached) = cached {
        let letters = &cached.letter_motion;
        return 100.0
            * if letters.is_empty() {
                cached.motion.gradient
            } else {
                letters.iter().map(|letter| letter.gradient).sum::<f64>() / letters.len() as f64
            };
    }
    // Evaluate the same fill kernel for voices outside the resident motion window.
    let emphasized = word.appearance.as_ref().is_some_and(|a| a.emphasized);
    let end = word.end - if emphasized { 250.0 } else { 0.0 };
    let count = word.graphemes.len();
    if !emphasized || count == 0 {
        return segment_gradient(
            ((time - word.start) / (end - word.start).max(1.0)).clamp(0.0, 1.0),
            0,
            1,
        );
    }
    let duration = (end - word.start) / count as f64;
    (0..count)
        .map(|i| {
            let start = word.start + i as f64 * duration;
            if time < start {
                -20.0
            } else if time >= start + duration {
                100.0
            } else {
                -20.0 + 120.0 * ((time - start) / duration * std::f64::consts::FRAC_PI_2).sin()
            }
        })
        .sum::<f64>()
        / count as f64
}

fn word_style(position: f64, active: bool, sung: bool, background: bool) -> (f64, f64, f64, f64) {
    let (bright, dim) = if sung {
        (0.50, 0.35)
    } else if background {
        (0.75, 0.42)
    } else {
        (0.85, 0.50)
    };
    let (opacity, glow) = if position >= 90.0 {
        (if active { 1.0 } else { 0.6 }, 0.0)
    } else if position > -15.0 {
        (
            1.0,
            if active {
                if background { 0.4 } else { 0.5 }
            } else {
                0.0
            },
        )
    } else {
        (FUTURE_OPACITY, 0.0)
    };
    (bright, dim, opacity, glow)
}

impl WordInk {
    fn gradient_start(&self, position: f64) -> f64 {
        self.rect.x0 - self.inline_offset + position * 0.01 * self.inline_width
    }
}

impl WordFill {
    fn settle(&self, time: f64, sung: bool) {
        let mut history = self.history.lock().unwrap();
        if time != history.time {
            history.gradients.fill(if sung { 100.0 } else { -20.0 });
            history.time = time;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw(
        &self,
        scene: &mut Scene,
        transform: Affine,
        time: f64,
        interval: (f64, f64),
        source: &PaintVoice,
        cached: Option<&crate::appearance::RowVoice>,
        opacity: f64,
        glow: f64,
        background: bool,
    ) {
        let gradient_at = |i| {
            source_gradient(
                &source.words[i],
                cached.and_then(|row| row.words.get(i)),
                time,
            )
        };
        let active = time >= interval.0 && time <= interval.1;
        let sung = time > interval.1;
        let overall = if active && self.smooth {
            ordinal_progress(source.words.len(), (0..source.words.len()).map(gradient_at))
        } else {
            0.0
        };
        let mut history = self.history.lock().unwrap();
        // Follow the source motion's discontinuity rule across cached frames.
        if time < history.time || time - history.time > 1000.0 {
            history.gradients.fill(f64::NAN);
        }
        let count = self.groups.len();
        if time != history.time {
            for (i, (&(mapped, slot, size), previous)) in
                self.groups.iter().zip(&mut history.gradients).enumerate()
            {
                *previous = if active {
                    let target = if self.smooth {
                        segment_gradient(overall, i, count)
                    } else {
                        let source = gradient_at(mapped);
                        if size == 1 {
                            source
                        } else {
                            segment_gradient((source + 20.0) / 120.0, slot, size)
                        }
                    };
                    if previous.is_nan() {
                        if target >= 96.0 { 100.0 } else { target }
                    } else {
                        follow_gradient(target, *previous)
                    }
                } else if sung {
                    100.0
                } else {
                    -20.0
                };
            }
            history.time = time;
        }
        for piece in &self.pieces {
            let position = history.gradients[piece.index];
            let (bright, dim, word_opacity, emission) =
                word_style(position, active, sung, background);
            let mask = |alpha| encoded(alpha * opacity * word_opacity, emission * glow, 6.0, 1.0);
            let gradient;
            let brush: BrushRef<'_> = if position <= -20.0 || piece.inline_width <= 0.0 {
                mask(dim).into()
            } else if position >= 100.0 {
                mask(bright).into()
            } else {
                let width = piece.inline_width;
                let x = piece.gradient_start(position);
                gradient = Gradient::new_linear((x, 0.0), (x + 0.2 * width, 0.0))
                    .with_stops([mask(bright), mask(dim)])
                    .with_interpolation_cs(ColorSpaceTag::LinearSrgb);
                (&gradient).into()
            };
            paint_mask(
                scene,
                transform,
                piece.coverage_bounds.unwrap_or(piece.rect),
                brush,
                &piece.runs,
                piece.fallback.as_deref(),
            );
        }
    }
}

fn paint_mask(
    scene: &mut Scene,
    transform: Affine,
    bounds: Rect,
    brush: BrushRef<'_>,
    runs: &[Glyphs],
    fallback: Option<&Scene>,
) {
    for run in runs {
        scene
            .draw_glyphs(&run.font)
            .font_size(run.size)
            .normalized_coords(&run.coords)
            .transform(transform)
            .brush(brush)
            .draw(Fill::NonZero, run.glyphs.iter().copied());
    }
    if let Some(coverage) = fallback {
        scene.push_layer(Fill::NonZero, BlendMode::default(), 1.0, transform, &bounds);
        let first_patch = scene.encoding().resources.patches.len();
        scene.append(coverage, Some(transform));
        // Vello can recreate its image atlas after a patch-free overlay pass
        // while retaining the old residency records. Force bitmap uploads
        // for this draw, sharing the already decoded pixel data.
        for patch in &mut scene.encoding_mut().resources.patches[first_patch..] {
            if let Patch::Image { image, .. } = patch {
                let (pixels, _) = image.data.clone().into_raw_parts();
                image.data = Blob::new(pixels);
            }
        }
        // Use only the cached glyph's alpha to mask the encoded
        // brush. Its original color is outside the mask contract.
        scene.push_layer(
            Fill::NonZero,
            BlendMode::new(Mix::Normal, Compose::SrcIn),
            1.0,
            transform,
            &bounds,
        );
        scene.fill(Fill::NonZero, transform, brush, None, &bounds);
        scene.pop_layer();
        scene.pop_layer();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        appearance::{AppearanceState, Effect},
        gpu::Gpu,
        live::TrackPacket,
        scene::{LayoutCache, TrackScene},
    };
    use std::time::Instant;
    fn data() -> serde_json::Value {
        serde_json::from_str(include_str!("../test/auxiliary-track.json")).unwrap()
    }
    fn track(item: &serde_json::Value, visible: bool) -> (TrackScene, f64, String) {
        let p = TrackPacket::parse(
            &serde_json::to_vec(&item[if visible { "visible" } else { "hidden" }]).unwrap(),
        )
        .unwrap();
        let settings = p.settings.clone().unwrap();
        let lines = p.into_lines();
        let time = lines[0].start + (lines[0].end - lines[0].start) * 0.47;
        let mut fonts = fonts();
        let (w, h) = if settings.landscape {
            (844, 390)
        } else {
            (390, 640)
        };
        let key = LayoutCache::key("aux", &lines, &settings, w, h, 1.0).unwrap();
        (
            TrackScene::with_fonts(lines, w, h, 1.0, Some(&settings), &mut fonts).unwrap(),
            time,
            key,
        )
    }
    fn fonts() -> Fonts {
        let mut fonts = Fonts::default();
        fonts
            .register(
                &std::fs::read(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"
                ))
                .unwrap(),
                &std::fs::read(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"
                ))
                .unwrap(),
            )
            .unwrap();
        fonts
    }
    fn frame(
        track: &mut TrackScene,
        state: &mut AppearanceState,
        scene: &mut Scene,
        time: f64,
        wall: f64,
    ) -> (f32, f32) {
        track.prepare(time).unwrap();
        state.prepare(track, time, wall);
        state.advance(track, time, wall, true, Effect::Motion);
        track.frame_appearance(
            time,
            track.scroll_target(time),
            &[],
            state,
            scene,
            Effect::Motion,
        )
    }
    #[test]
    fn actual_translation_visibility_fonts_source_policy_and_cache_identity() {
        use sha2::Digest;
        let d = data();
        assert_eq!(d["packets"].as_array().unwrap().len(), 8);
        for source in d["sources"].as_array().unwrap() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(source["path"].as_str().unwrap());
            assert_eq!(
                format!("{:x}", sha2::Sha256::digest(std::fs::read(path).unwrap())),
                source["sha256"].as_str().unwrap()
            );
        }
        for item in d["packets"].as_array().unwrap() {
            let (mut hidden, time, key_a) = track(item, false);
            let (mut shown, _, key_b) = track(item, true);
            assert_ne!(
                key_a, key_b,
                "visibility/content must invalidate retained geometry"
            );
            hidden.prepare(time).unwrap();
            shown.prepare(time).unwrap();
            shown.layout_json().unwrap();
            assert!(hidden.cached[0].lead().translation.is_none());
            let t = shown.cached[0].lead().translation.as_ref().unwrap();
            assert_eq!(t.diagnostics["text"], item["original_translation"]);
            assert_eq!(t.missing_glyphs, 0);
            assert!(t.glyph_count > 0);
            assert!(shown.cached[0].height >= hidden.cached[0].height);
            let spicy = item["style"] == "spicy";
            let landscape = item["landscape"] == true;
            let size = t.diagnostics["policy"]["size"].as_f64().unwrap();
            let expected = if spicy {
                33.6 * 0.45 * if landscape { 0.9 } else { 1.0 }
            } else if landscape {
                14.4
            } else {
                18.0
            };
            assert!((size - expected).abs() < 0.0001);
            assert_eq!(
                t.diagnostics["policy"]["weight"],
                if spicy { 900.0 } else { 700.0 }
            );
            let margin = t.diagnostics["policy"]["margin"].as_f64().unwrap();
            assert!((margin - if spicy { size * 0.25 } else { 0.0 }).abs() < 0.0001);
            let leading = t.diagnostics["policy"]["leading"].as_f64().unwrap();
            let ratio = if spicy { 13.0 / 11.0 } else { 1.5 };
            assert!((leading - size * ratio).abs() < 0.0001);
            let bottom = t.diagnostics["policy"]["bottom"].as_f64().unwrap_or(0.0);
            let height = t.diagnostics["height"].as_f64().unwrap();
            assert!((t.extra_height - height - margin - bottom).abs() < 0.0001);
            assert!(!t.diagnostics["faces"].as_array().unwrap().is_empty());
            let mut state = AppearanceState::default();
            let mut scene = Scene::new();
            for i in 0..3 {
                frame(
                    &mut shown,
                    &mut state,
                    &mut scene,
                    time,
                    10000.0 + i as f64 * 8.333,
                );
            }
            let prepares = (shown.plain_preparations, shown.detailed_preparations);
            let allocations = crate::allocation_probe::measure(|| {
                for i in 0..120 {
                    frame(
                        &mut shown,
                        &mut state,
                        &mut scene,
                        time + i as f64 * 0.01,
                        10100.0 + i as f64 * 8.333,
                    );
                }
            });
            assert_eq!(allocations, 0);
            assert_eq!(
                prepares,
                (shown.plain_preparations, shown.detailed_preparations)
            );
            let mut invalid = item["visible"].clone();
            invalid["lines"][0]["paint"]["translation"] = serde_json::json!("x".repeat(20001));
            assert!(TrackPacket::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn spicy_translation_eases_at_voice_boundaries() {
        let interval = (1000.0, 2000.0);
        for (time, opacity, glow) in [
            (999.0, 0.51, 0.0),
            (1000.0, 0.51, 0.0),
            (1150.0, 0.755, 0.5),
            (1300.0, 1.0, 1.0),
            (2000.0, 1.0, 1.0),
            (2150.0, 0.7485, 0.5),
            (2300.0, 0.497, 0.0),
        ] {
            let actual = spicy_levels(time, interval);
            assert!((actual.0 - opacity).abs() < 0.000001);
            assert!((actual.1 - glow).abs() < 0.000001);
        }
        assert!(spicy_levels(1075.0, interval).1 < 0.25);
        let short = (1000.0, 1100.0);
        let boundary = spicy_levels(1100.0, short);
        assert!(boundary.0 < 1.0 && boundary.1 > 0.0);
        assert!((spicy_levels(1100.001, short).0 - boundary.0).abs() < 0.000001);
    }

    #[test]
    fn spicy_translation_uses_same_mask_and_blur_band_in_both_frame_paths() {
        let d = data();
        let item = d["packets"].as_array().unwrap().first().unwrap();
        assert_eq!(item["style"], "spicy");
        let (mut track, _, _) = track(item, true);
        let interval = track.lines()[0].voice(0).unwrap().interval();
        let time = interval.0 + 150.0;
        assert!(time < interval.1);
        track.prepare(time).unwrap();
        assert!(track.timed_ready(0));
        let cold = AppearanceState::default();
        let mut warm = AppearanceState::default();
        warm.prepare(&track, time, 5000.0);
        warm.advance(&track, time, 5000.0, true, Effect::Glow);
        assert!(warm.row(0).is_some());
        let scroll = track.scroll_target(time);
        let mut scene = Scene::new();
        for (time, effect, opacity, glow, gradient) in [
            (time, Effect::Glow, 0.755, 0.5, true),
            (time, Effect::Fill, 0.755, 0.0, true),
            (interval.1 + 150.0, Effect::Glow, 0.7485, 0.5, false),
            (interval.1 + 312.0, Effect::Glow, 0.497, 0.0, false),
        ] {
            // Keep the detailed path populated past the interval to test
            // translation release independently of the original word springs.
            warm.rows.get_mut(&0).unwrap().releasing = time >= interval.1;
            scene.reset();
            for state in [&cold, &warm] {
                track.cached[0].voices[0]
                    .translation
                    .as_mut()
                    .unwrap()
                    .reset_word_fill();
                let with = track.frame_appearance(time, scroll, &[], state, &mut scene, effect);
                let translation = track.cached[0].voices[0].translation.take().unwrap();
                let Ink::Spicy {
                    words: Some(words), ..
                } = &translation.ink
                else {
                    panic!("missing shaped lead translation words");
                };
                let history = words.history.lock().unwrap();
                let mut expected = Scene::new();
                for piece in &words.pieces {
                    let position = history.gradients[piece.index];
                    let active = time <= interval.1;
                    let word_active = position > -15.0 && position < 90.0;
                    let alpha = if position >= 90.0 && !active {
                        0.6
                    } else if position > -15.0 {
                        1.0
                    } else {
                        0.51
                    };
                    let emission = if active && word_active {
                        glow * 0.5
                    } else {
                        0.0
                    };
                    let (bright, dim) = if active { (0.85, 0.5) } else { (0.5, 0.35) };
                    let bright = encoded(bright * opacity * alpha, emission, 6.0, 1.0);
                    let dim = encoded(dim * opacity * alpha, emission, 6.0, 1.0);
                    let encoded = scene.encoding();
                    let count = if position > -20.0 && position < 100.0 {
                        encoded
                            .resources
                            .color_stops
                            .windows(2)
                            .filter(|pair| {
                                pair.iter()
                                    .zip([
                                        vello::peniko::ColorStop::from((0.0, bright)),
                                        vello::peniko::ColorStop::from((1.0, dim)),
                                    ])
                                    .all(|(actual, expected)| {
                                        actual.offset == expected.offset
                                            && actual
                                                .color
                                                .components
                                                .iter()
                                                .zip(expected.color.components)
                                                .all(|(a, b)| (a - b).abs() < 0.000001)
                                    })
                            })
                            .count()
                    } else {
                        expected.reset();
                        expected.encoding_mut().encode_color(if position >= 100.0 {
                            bright
                        } else {
                            dim
                        });
                        let mask = expected.encoding().draw_data[0];
                        encoded
                            .draw_data
                            .iter()
                            .filter(|&&value| value == mask)
                            .count()
                    };
                    let matching_runs: usize = words
                        .pieces
                        .iter()
                        .filter(|other| {
                            let other_pos = history.gradients[other.index];
                            if position > -20.0 && position < 100.0 {
                                other_pos > -20.0
                                    && other_pos < 100.0
                                    && (other_pos >= 90.0) == (position >= 90.0)
                                    && (other_pos > -15.0) == (position > -15.0)
                            } else {
                                other_pos == position
                            }
                        })
                        .map(|piece| piece.runs.len())
                        .sum();
                    assert_eq!(count, matching_runs);
                }
                assert_eq!(
                    history.gradients.iter().any(|p| *p > -20.0 && *p < 100.0),
                    gradient
                );
                drop(history);
                let glyphs_with = scene.encoding().resources.glyphs.len();
                let without = track.frame_appearance(time, scroll, &[], state, &mut scene, effect);
                assert_eq!(with, without);
                assert_eq!(
                    glyphs_with - scene.encoding().resources.glyphs.len(),
                    words
                        .pieces
                        .iter()
                        .flat_map(|piece| &piece.runs)
                        .map(|run| run.glyphs.len())
                        .sum::<usize>()
                );
                track.cached[0].voices[0].translation = Some(translation);
            }
        }
        for (elapsed, advancing, changing) in [
            (299.0, true, true),
            (300.0, true, false),
            (299.0, false, false),
        ] {
            let time = interval.1 + elapsed;
            let schedule = track.frame_schedule(time, scroll, &[], &cold, false, advancing);
            assert_eq!(schedule.visible_changes, changing);
            assert_eq!(schedule.continuous, changing);
        }
    }

    #[test]
    fn positioned_rtl_ligature_and_wrapped_inline_gradient() {
        let fixture = data();
        let (track, _, _) = track(&fixture["packets"][0], true);
        let source = track.lines()[0].voice(0).unwrap();
        let mut fonts = fonts();
        let font = include_bytes!("../tests/fonts/arabic-ligature-subset.ttf");
        assert!(
            !fonts
                .context
                .collection
                .register_fonts(font.to_vec().into(), None)
                .is_empty()
        );
        let mut layouts = LayoutContext::new();
        let mut shape = |text: &str, width| {
            let mut layout = crate::scene::shape_with_wrap(
                text,
                &mut fonts.context,
                &mut layouts,
                20.0,
                24.0,
                700.0,
                "'DejaVu Sans', sans-serif",
                &[],
                0.0,
                true,
            );
            layout.break_all_lines(Some(width));
            layout.align(Alignment::Right, AlignmentOptions::default());
            layout
        };
        let rtl = shape("لا", 150.0);
        let line = rtl.lines().next().unwrap();
        assert!(
            line.runs()
                .flat_map(|run| run.visual_clusters())
                .any(|cluster| cluster.is_rtl() && cluster.is_ligature_continuation())
        );
        let positioned: Vec<_> = line
            .items()
            .flat_map(|item| match item {
                PositionedLayoutItem::GlyphRun(run) => run
                    .positioned_glyphs()
                    .map(|g| (g.id, g.x, g.y))
                    .collect::<Vec<_>>(),
                _ => Vec::new(),
            })
            .collect();
        let prepared = prepare_words(&rtl, "لا", source);
        let actual: Vec<_> = prepared
            .pieces
            .iter()
            .flat_map(|piece| &piece.runs)
            .flat_map(|run| &run.glyphs)
            .map(|g| (g.id, g.x, g.y))
            .collect();
        assert_eq!(actual, positioned);

        let text = "WWWWWWWWWWWWWWWWWWWW next";
        let wrapped = shape(text, 70.0);
        let words = prepare_words(&wrapped, text, source);
        let fragments: Vec<_> = words
            .pieces
            .iter()
            .filter(|piece| piece.index == 0)
            .collect();
        assert!(fragments.len() >= 2);
        let width = fragments[0].inline_width;
        let mut offset = 0.0;
        for fragment in fragments {
            assert_eq!(fragment.inline_offset, offset);
            assert_eq!(fragment.inline_width, width);
            assert!(
                (fragment.gradient_start(50.0) - fragment.rect.x0 + offset - width * 0.5).abs()
                    < 1e-9
            );
            offset += fragment.rect.width();
        }
        assert_eq!(offset, width);

        let text = "لا".repeat(24);
        let wrapped = shape(&text, 70.0);
        assert!(wrapped.is_rtl());
        assert!(wrapped.len() > 1);
        let words = prepare_words(&wrapped, &text, source);
        assert!(words.pieces.len() >= 2);
        for piece in &words.pieces {
            assert!(!piece.runs.is_empty());
            for run in &piece.runs {
                assert_eq!(run.font.data.as_ref(), font.as_slice());
                assert!(run.glyphs.iter().all(|glyph| glyph.id != 0));
            }
        }
        let width = words.pieces[0].inline_width;
        let mut right_edge = width;
        for fragment in &words.pieces {
            right_edge -= fragment.rect.width();
            assert!((fragment.inline_offset - right_edge).abs() < 1e-9);
            let start = fragment.gradient_start(50.0);
            assert!((start - fragment.rect.x0 + right_edge - width * 0.5).abs() < 1e-9);
        }
        assert!(right_edge.abs() < 1e-9);
        assert!(words.pieces.first().unwrap().inline_offset > 0.0);
        assert!(words.pieces.last().unwrap().inline_offset.abs() < 1e-9);

        let spaced = shape("A B", 150.0);
        let words = prepare_words(&spaced, "A B", source);
        let advance: f64 = spaced
            .lines()
            .flat_map(|line| line.runs())
            .flat_map(|run| run.visual_clusters())
            .filter(|cluster| cluster.text_range().start < 2)
            .map(|cluster| f64::from(cluster.advance()))
            .sum();
        assert!((words.pieces[0].inline_width - advance).abs() < 1e-4);
    }

    #[test]
    fn translated_word_style_follows_voice_and_line_state() {
        for (background, bright, dim, glow) in [(false, 0.85, 0.50, 0.5), (true, 0.75, 0.42, 0.4)] {
            assert_eq!(
                word_style(-20.0, true, false, background),
                (bright, dim, 0.51, 0.0)
            );
            assert_eq!(
                word_style(45.0, true, false, background),
                (bright, dim, 1.0, glow)
            );
            assert_eq!(
                word_style(100.0, true, false, background),
                (bright, dim, 1.0, 0.0)
            );
            assert_eq!(
                word_style(100.0, false, true, background),
                (0.50, 0.35, 0.6, 0.0)
            );
        }
    }

    #[test]
    fn source_fill_uses_cached_sustained_letter_gradients() {
        use crate::style_timing::{WordSpec, WordState};
        let fixture = data();
        let (track, _, _) = track(&fixture["packets"][0], true);
        let word = &track.lines()[0].voice(0).unwrap().words[0];
        let mut cached = WordState::new(WordSpec {
            start: word.start,
            end: word.end,
            emphasized: true,
            letters: 3,
        });
        cached.motion.gradient = 0.95;
        for (letter, gradient) in cached.letter_motion.iter_mut().zip([1.0, 0.4, -0.2]) {
            letter.gradient = gradient;
        }
        assert!((source_gradient(word, Some(&cached), 0.0) - 40.0).abs() < 1e-9);
    }

    #[test]
    fn translated_words_follow_ordinals_groups_and_seek() {
        let fixture = data();
        let (track, _, _) = track(&fixture["packets"][0], true);
        let mut source = track.lines()[0].voice(0).unwrap().clone();
        source.text = "one two three".into();
        source.start = 1000.0;
        source.end = 3000.0;
        source.words.truncate(3);
        assert_eq!(source.words.len(), 3);
        for (word, (start, end)) in
            source
                .words
                .iter_mut()
                .zip([(1000.0, 1200.0), (1500.0, 2500.0), (2700.0, 3000.0)])
        {
            word.start = start;
            word.end = end;
            word.appearance = None;
        }
        let policy = Policy::voice(
            &Settings {
                style: Style::Spicy,
                font_scale: 1.0,
                landscape: false,
            },
            1.0,
            true,
            36.0,
            85.0,
        );
        let mut fonts = fonts();
        let mut layouts = LayoutContext::new();
        let mut scene = Scene::new();
        for (text, non_latin, smooth, expected) in [
            (
                "Alpha Beta שלום 😀",
                false,
                false,
                vec![100.0, 100.0, 40.0, -20.0],
            ),
            (
                "Alpha Beta שלום 😀",
                true,
                true,
                vec![100.0, 100.0, -20.0, -20.0],
            ),
            (
                "Alpha Beta שלום 😀 echo fox",
                false,
                true,
                vec![100.0, 100.0, 100.0, -20.0, -20.0, -20.0],
            ),
        ] {
            source.text = if non_latin {
                "one 두 three"
            } else {
                "one two three"
            }
            .into();
            let t = Translation::prepare(
                text,
                &policy,
                true,
                0.0,
                &mut fonts,
                &mut layouts,
                true,
                Some(&source),
            );
            let Ink::Spicy {
                words: Some(words), ..
            } = &t.ink
            else {
                panic!("missing prepared translation words");
            };
            assert_eq!(words.smooth, smooth);
            assert!(t.diagnostics["line_count"].as_u64().unwrap() > 1);
            assert!(words.pieces.iter().any(|piece| piece.index == 3));
            let mut draw = |time| {
                scene.reset();
                t.draw(
                    &mut scene,
                    Affine::IDENTITY,
                    1.0,
                    time,
                    source.interval(),
                    false,
                    Some((&source, None)),
                );
                scene.encoding().resources.color_stops.len()
            };
            draw(1350.0);
            let gap = words.history.lock().unwrap().gradients.clone();
            assert_eq!(gap[0], 100.0);
            assert_eq!(gap.last(), Some(&-20.0));
            let stops = draw(2000.0);
            assert!(
                words
                    .history
                    .lock()
                    .unwrap()
                    .gradients
                    .iter()
                    .zip(expected)
                    .all(|(actual, expected)| (actual - expected).abs() < 1e-9)
            );
            assert_eq!(stops > 0, !smooth);
            draw(2900.0);
            draw(1100.0);
            assert_eq!(words.history.lock().unwrap().gradients.last(), Some(&-20.0));
        }
        assert!((follow_gradient(48.0, 40.0) - 45.44).abs() < 1e-10);
        assert_eq!(follow_gradient(30.0, 40.0), 40.0);
        assert_eq!(follow_gradient(96.0, 95.0), 100.0);
    }

    #[test]
    fn spicy_background_translation_uses_own_type_alignment_and_gradient() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let p = Policy::voice(&settings, 2.0, true, 50.0, 300.0);
        assert!((p.size - 28.0).abs() < 0.0001);
        assert!((p.leading / p.size - 1.2).abs() < 0.0001);
        assert_eq!(p.weight, 700.0);
        let mut fonts = fonts();
        let mut layouts = LayoutContext::new();
        let mut prepare = |text, right| {
            Translation::prepare(text, &p, right, 40.0, &mut fonts, &mut layouts, true, None)
        };
        let left = prepare("한국어 中文", false);
        let right = prepare("한국어 中文", true);
        let rtl_left = prepare("שלום translation", false);
        let rtl_right = prepare("שלום translation", true);
        assert_eq!(left.diagnostics["text"], "한국어 中文");
        assert_eq!(right.diagnostics["text"], left.diagnostics["text"]);
        assert_eq!(left.diagnostics["policy"]["x"], 0.0);
        assert_eq!(rtl_left.diagnostics["policy"]["x"], 0.0);
        for t in [&right, &rtl_right] {
            assert!((t.origin.as_coeffs()[4] - f64::from(0.25 * p.size)).abs() < 0.0001);
        }
        let leftmost_glyph = |translation: &Translation| {
            let Ink::Spicy { runs, .. } = &translation.ink else {
                panic!("missing shaped translation");
            };
            runs.iter()
                .flat_map(|run| &run.glyphs)
                .map(|glyph| glyph.x)
                .min_by(f32::total_cmp)
                .unwrap()
        };
        assert!(leftmost_glyph(&rtl_right) > leftmost_glyph(&rtl_left));
        assert_eq!(left.extra_height, right.extra_height);
        let height = right.diagnostics["height"].as_f64().unwrap();
        assert!((right.extra_height - height - f64::from(p.margin + p.bottom)).abs() < 0.0001);
        let Ink::Spicy { runs, .. } = &right.ink else {
            panic!("missing shaped background translation");
        };
        let mut scene = Scene::new();
        left.draw(
            &mut scene,
            Affine::IDENTITY,
            1.0,
            999.0,
            (1000.0, 2000.0),
            false,
            None,
        );
        let left_x = scene.encoding().resources.glyphs[0].x;
        for (time, uses_gradient) in [(999.0, false), (1500.0, true), (2300.0, false)] {
            scene.reset();
            right.draw(
                &mut scene,
                Affine::IDENTITY,
                0.1,
                time,
                (1000.0, 2000.0),
                true,
                None,
            );
            let encoded = scene.encoding();
            assert_eq!(encoded.resources.glyph_runs.len(), runs.len());
            assert!(encoded.resources.glyphs[0].x > left_x);
            assert_eq!(!encoded.resources.color_stops.is_empty(), uses_gradient);
            if uses_gradient {
                assert_eq!(encoded.resources.color_stops.len(), runs.len() * 2);
            }
        }
    }

    fn add_test_bitmap(t: &mut Translation) {
        use std::sync::Arc;
        use vello::peniko::{ImageAlphaType, ImageBrush, ImageData, ImageFormat};

        let Ink::Spicy {
            fallback,
            words,
            settled,
            ..
        } = &mut t.ink
        else {
            panic!("expected a Spicy translation");
        };
        *settled = None;
        let image = ImageBrush::new(ImageData {
            data: Blob::new(Arc::new([0, 255, 0, 255])),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: 1,
            height: 1,
        });
        let fallback = words.as_mut().map_or(fallback, |words| {
            let piece = &mut words.pieces[0];
            let bounds = Rect::new(160.0, 2.0, 168.0, 10.0);
            piece.coverage_bounds = Some(piece.coverage_bounds.map_or(bounds, |b| b.union(bounds)));
            &mut piece.fallback
        });
        fallback
            .get_or_insert_with(|| Box::new(Scene::new()))
            .draw_image(&image, Affine::translate((160.0, 2.0)) * Affine::scale(8.0));
    }

    #[test]
    fn spicy_settled_scenes_match_live_paint_across_boundaries_and_seeks() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let fixture = data();
        let (mut track, fixture_time, _) = track(&fixture["packets"][0], true);
        track.prepare(fixture_time).unwrap();
        let source = track.lines()[0].voice(0).unwrap();
        assert!(!source.words.is_empty());
        let (start, end) = source.interval();
        let middle = (start + end) * 0.5;
        let partial = (1..999)
            .map(|offset| start + f64::from(offset))
            .find(|&time| {
                time < end
                    && source.words.iter().any(|word| {
                        let gradient = source_gradient(word, None, time);
                        gradient > -15.0 && gradient < 90.0
                    })
            })
            .expect("fixture must begin revealing a word within one second");
        let transform = Affine::translate((23.0, 47.0)) * Affine::scale(0.875);
        let mut fonts = fonts();
        // The subset covers lam and alef. Keep system fonts out of this case
        // so the generic family cannot select a host-dependent Arabic face.
        let mut rtl_fonts = Fonts::default();
        rtl_fonts.context.collection =
            parley::fontique::Collection::new(parley::fontique::CollectionOptions {
                system_fonts: false,
                ..Default::default()
            });
        let arabic_font = include_bytes!("../tests/fonts/arabic-ligature-subset.ttf");
        let arabic_families = rtl_fonts
            .context
            .collection
            .register_fonts(arabic_font.to_vec().into(), None);
        assert!(!arabic_families.is_empty());
        rtl_fonts.context.collection.set_generic_families(
            parley::fontique::GenericFamily::SansSerif,
            arabic_families.into_iter().map(|(family, _)| family),
        );
        let mut layouts = LayoutContext::new();
        let mut rtl_layouts = LayoutContext::new();
        let lam_alef = "لا";
        let wrapped_rtl = lam_alef.repeat(24);
        for (text, width, background, voice) in [
            ("Outline subtitle", 350.0, false, None),
            ("Outline subtitle", 350.0, true, None),
            ("Outline subtitle", 350.0, false, Some(source)),
            ("Outline subtitle", 350.0, true, Some(source)),
            (wrapped_rtl.as_str(), 70.0, false, Some(source)),
        ] {
            let is_wrapped_rtl = text == wrapped_rtl.as_str();
            let (test_fonts, test_layouts) = if is_wrapped_rtl {
                (&mut rtl_fonts, &mut rtl_layouts)
            } else {
                (&mut fonts, &mut layouts)
            };
            let policy = Policy::voice(&settings, 1.0, background, 30.0, width);
            let mut prepare = || {
                Translation::prepare(
                    text,
                    &policy,
                    true,
                    20.0,
                    test_fonts,
                    test_layouts,
                    is_wrapped_rtl,
                    voice,
                )
            };
            let cached = prepare();
            let mut live = prepare();
            let Ink::Spicy {
                settled: Some(scenes),
                ..
            } = &cached.ink
            else {
                panic!("expected cached outline scenes for {text}");
            };
            let outlined = &scenes[0].encoding().resources;
            let prefix_font = &outlined.glyph_runs[0].font;
            let prefix_glyph = outlined.glyphs[0];
            if is_wrapped_rtl {
                assert_eq!(cached.missing_glyphs, 0);
                assert!(cached.diagnostics["line_count"].as_u64().unwrap() > 1);
                assert!(
                    outlined
                        .glyphs
                        .iter()
                        .any(|glyph| glyph.y != prefix_glyph.y)
                );
                for run in &outlined.glyph_runs {
                    let face = FontRef::from_index(run.font.data.as_ref(), run.font.index).unwrap();
                    let charmap = face.charmap();
                    assert!(lam_alef.chars().all(|letter| charmap.map(letter).is_some()));
                    let outlines = face.outline_glyphs();
                    assert!(outlined.glyphs[run.glyphs.clone()].iter().all(|glyph| {
                        glyph.id != 0 && outlines.get(GlyphId::new(glyph.id)).is_some()
                    }));
                }
            }
            let Ink::Spicy { settled, .. } = &mut live.ink else {
                panic!("expected Spicy ink");
            };
            assert!(settled.take().is_some());

            let mut appearance = AppearanceState::default();
            for (frame, time) in [
                start - 1.0,
                partial,
                start,
                middle,
                end,
                end + TRANSITION_MS - 1.0,
                end + TRANSITION_MS,
                end + TRANSITION_MS,
                end + TRANSITION_MS + 1.0,
                middle,
                start - 1.0,
                start - 1.0,
                partial,
                start,
                middle,
            ]
            .into_iter()
            .enumerate()
            {
                let native_ms = frame as f64 * 16.0;
                appearance.prepare(&track, time, native_ms);
                appearance.advance(
                    &track,
                    time,
                    native_ms,
                    true,
                    crate::appearance::LIVE_EFFECT,
                );
                let row_words = &appearance.row(0).expect("missing fixture row").voices[0];
                let draw = |translation: &Translation| {
                    let mut scene = Scene::new();
                    let clip = Rect::new(0.0, 0.0, 390.0, 640.0);
                    scene.push_layer(Fill::NonZero, BlendMode::default(), 0.75, transform, &clip);
                    scene
                        .draw_glyphs(prefix_font)
                        .font_size(12.0)
                        .transform(Affine::translate((12.0, 100.0)))
                        .brush(Color::WHITE)
                        .draw(Fill::NonZero, [prefix_glyph].into_iter());
                    translation.draw(
                        &mut scene,
                        transform,
                        1.0,
                        time,
                        (start, end),
                        true,
                        voice.map(|voice| (voice, (frame % 2 == 0).then_some(row_words))),
                    );
                    scene.fill(Fill::EvenOdd, transform, Color::WHITE, None, &clip);
                    scene.pop_layer();
                    scene
                };
                let cached_frame = draw(&cached);
                let live_frame = draw(&live);
                if let (
                    Ink::Spicy {
                        words: Some(actual),
                        ..
                    },
                    Ink::Spicy {
                        words: Some(expected),
                        ..
                    },
                ) = (&cached.ink, &live.ink)
                {
                    let actual = actual.history.lock().unwrap();
                    let expected = expected.history.lock().unwrap();
                    assert_eq!(actual.time, expected.time, "history time at {time}");
                    assert_eq!(actual.gradients, expected.gradients, "history at {time}");
                }
                let actual = cached_frame.encoding();
                let expected = live_frame.encoding();
                assert_eq!(actual.draw_data, expected.draw_data, "time {time}");
                assert!(
                    actual.draw_tags == expected.draw_tags,
                    "draw tags at {time}"
                );
                assert!(
                    actual.path_tags == expected.path_tags,
                    "path tags at {time}"
                );
                assert_eq!(actual.transforms, expected.transforms, "time {time}");
                let glyph_positions = |scene: &Scene| {
                    scene
                        .encoding()
                        .resources
                        .glyphs
                        .iter()
                        .map(|glyph| (glyph.id, glyph.x, glyph.y))
                        .collect::<Vec<_>>()
                };
                assert_eq!(glyph_positions(&cached_frame), glyph_positions(&live_frame));
                assert_eq!(actual.resources.color_stops, expected.resources.color_stops);
                assert_eq!(
                    actual.resources.normalized_coords,
                    expected.resources.normalized_coords
                );
                assert_eq!(
                    actual.resources.glyph_runs.len(),
                    expected.resources.glyph_runs.len()
                );
                for (actual, expected) in actual
                    .resources
                    .glyph_runs
                    .iter()
                    .zip(&expected.resources.glyph_runs)
                {
                    assert_eq!(actual.transform, expected.transform);
                    assert_eq!(actual.font.index, expected.font.index);
                    assert!(actual.font.data.as_ref() == expected.font.data.as_ref());
                    assert_eq!(actual.glyphs, expected.glyphs);
                    assert_eq!(actual.normalized_coords, expected.normalized_coords);
                    assert_eq!(
                        actual.stream_offsets.draw_data,
                        expected.stream_offsets.draw_data
                    );
                }
            }
        }
    }

    #[test]
    fn spicy_settled_preparation_excludes_bitmap_coverage() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let fixture = data();
        let (track, _, _) = track(&fixture["packets"][0], true);
        let source = track.lines()[0].voice(0).unwrap();
        let policy = Policy::voice(&settings, 1.0, false, 30.0, 350.0);
        let mut fonts = fonts();
        let mut layouts = LayoutContext::new();
        for voice in [None, Some(source)] {
            let mut translation = Translation::prepare(
                "Outline subtitle",
                &policy,
                false,
                20.0,
                &mut fonts,
                &mut layouts,
                false,
                voice,
            );
            assert!(matches!(
                &translation.ink,
                Ink::Spicy {
                    settled: Some(_),
                    ..
                }
            ));
            // Inject real image coverage before invoking the same eligibility check as prepare.
            add_test_bitmap(&mut translation);
            translation.prepare_settled(voice);
            assert!(matches!(&translation.ink, Ink::Spicy { settled: None, .. }));
        }
    }

    #[test]
    fn spicy_multilingual_translation_and_cached_bitmap_draw_without_allocating() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let fixture = data();
        let (track, time, _) = track(&fixture["packets"][0], true);
        let source = track.lines()[0].voice(0).unwrap();
        let mut fonts = fonts();
        let mut layouts = LayoutContext::new();
        let mut scene = Scene::new();
        for background in [false, true] {
            let policy = Policy::voice(&settings, 1.0, background, 30.0, 350.0);
            let mut translation = Translation::prepare(
                "Underneath · 한국어 中文",
                &policy,
                false,
                0.0,
                &mut fonts,
                &mut layouts,
                false,
                Some(source),
            );
            assert_eq!(translation.missing_glyphs, 0);
            if let Ink::Spicy {
                words: Some(words),
                settled,
                ..
            } = &translation.ink
                && words.pieces.iter().any(|piece| piece.fallback.is_some())
            {
                assert!(
                    settled.is_none(),
                    "bitmap coverage must stay on the live path"
                );
            }
            // Exercise cached bitmap coverage even on hosts without a color font.
            add_test_bitmap(&mut translation);
            let mut draw = || {
                scene.reset();
                translation.draw(
                    &mut scene,
                    Affine::IDENTITY,
                    1.0,
                    time,
                    source.interval(),
                    true,
                    Some((source, None)),
                );
            };
            draw();
            assert_eq!(crate::allocation_probe::measure(draw), 0);
        }
    }

    #[test]
    fn bitmap_word_layers_stay_local_at_translation_byte_limit() {
        use std::sync::Arc;
        use vello::peniko::{ImageAlphaType, ImageBrush, ImageData, ImageFormat};

        let fixture = data();
        let (track, time, _) = track(&fixture["packets"][0], true);
        let source = track.lines()[0].voice(0).unwrap();
        let p = Policy::voice(
            &Settings {
                style: Style::Spicy,
                font_scale: 1.0,
                landscape: false,
            },
            1.0,
            true,
            36.0,
            350.0,
        );
        let text = "😀 ".repeat(3999) + "😀!";
        assert_eq!(text.len(), 20_000);
        let mut t = Translation::prepare(
            &text,
            &p,
            true,
            0.0,
            &mut fonts(),
            &mut LayoutContext::new(),
            false,
            Some(source),
        );
        let Ink::Spicy {
            words: Some(words),
            bounds,
            settled,
            ..
        } = &mut t.ink
        else {
            panic!("missing prepared bitmap words");
        };
        *settled = None;
        let image = ImageBrush::new(ImageData {
            data: Blob::new(Arc::new([0, 255, 0, 255])),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: 1,
            height: 1,
        });
        let mut layers = 0;
        for piece in &mut words.pieces {
            // Supply a deterministic bitmap on hosts without color emoji.
            if piece.fallback.is_none() && !piece.runs.is_empty() {
                let ink = Rect::new(
                    piece.rect.x0 - 2.0,
                    piece.rect.y0,
                    piece.rect.x0 + 2.0,
                    piece.rect.y0 + 4.0,
                );
                let mut coverage = Scene::new();
                coverage.draw_image(
                    &image,
                    Affine::translate((ink.x0, ink.y0)) * Affine::scale(4.0),
                );
                piece.coverage_bounds = Some(ink);
                piece.fallback = Some(Box::new(coverage));
            }
            if piece.fallback.is_some() {
                layers += 2;
                let ink = piece.coverage_bounds.unwrap();
                assert!(ink.width() < bounds.width() * 0.25);
                assert!(ink.height() < bounds.height() * 0.25);
            }
        }
        assert!(layers >= 8000);
        let mut scene = Scene::new();
        let mut draw = || {
            scene.reset();
            t.draw(
                &mut scene,
                Affine::IDENTITY,
                1.0,
                time,
                source.interval(),
                true,
                Some((source, None)),
            );
        };
        draw();
        assert_eq!(crate::allocation_probe::measure(draw), 0);
        assert!(scene.encoding().n_clips as usize >= layers);
    }

    #[test]
    fn amll_translation_keeps_fixed_sharp_mask_in_every_voice_phase() {
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let p = Policy::voice(&settings, 1.0, true, 36.0, 300.0);
        let t = Translation::prepare(
            "Subtitle",
            &p,
            true,
            40.0,
            &mut fonts(),
            &mut LayoutContext::new(),
            true,
            None,
        );
        assert_eq!(t.diagnostics["height"].as_f64(), Some(t.extra_height));
        let mut scene = Scene::new();
        let mut mask = Scene::new();
        mask.encoding_mut()
            .encode_color(encoded(0.3, 0.0, 0.0, 1.0));
        let fixed = mask.encoding().draw_data[0];
        t.draw(
            &mut scene,
            Affine::IDENTITY,
            0.4,
            0.0,
            (1000.0, 2000.0),
            true,
            None,
        );
        assert!(scene.encoding().draw_data.contains(&fixed));
        let inactive = scene.encoding().draw_data.clone();
        for time in [1500.0, 2300.0] {
            scene.reset();
            t.draw(
                &mut scene,
                Affine::IDENTITY,
                0.4,
                time,
                (1000.0, 2000.0),
                true,
                None,
            );
            assert_eq!(scene.encoding().draw_data, inactive);
        }
    }

    #[test]
    #[ignore = "requires a GPU adapter for shared blur and glow readback"]
    fn spicy_translation_gpu_blur_and_glow() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let p = Policy::voice(&settings, 1.0, false, 33.6, 250.0);
        let mut t = Translation::prepare(
            "Subtitle",
            &p,
            false,
            0.0,
            &mut fonts(),
            &mut LayoutContext::new(),
            false,
            None,
        );
        add_test_bitmap(&mut t);
        let mut scene = Scene::new();
        let mut gpu = pollster::block_on(Gpu::new(320, 320)).unwrap();
        let mut render = |time, band, blur, glow| {
            scene.reset();
            t.draw(
                &mut scene,
                Affine::translate((40.0, 160.0)),
                1.0,
                time,
                (1000.0, 2000.0),
                glow,
                None,
            );
            gpu.render_appearance(&scene, band, blur, glow).unwrap();
            gpu.read_pixels().unwrap()
        };
        let inside = (0.0, 320.0);
        let outside = (30.0, 60.0);
        let inactive = render(900.0, outside, false, false);
        let protected = render(900.0, inside, true, false);
        let bitmap_center = (171 * 320 + 204) * 4 + 3;
        assert!((45..=80).contains(&inactive[bitmap_center]));
        assert_eq!(inactive[bitmap_center], protected[bitmap_center]);
        let changed_bytes = inactive
            .iter()
            .zip(&protected)
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            changed_bytes, 0,
            "protected outline and bitmap coverage changed"
        );
        let blurred = render(900.0, outside, true, false);
        let active = render(1400.0, inside, true, false);
        let glowing = render(1400.0, inside, true, true);
        let peak = |pixels: &[u8]| pixels.chunks_exact(4).map(|p| p[3]).max().unwrap();
        assert!(peak(&blurred) < peak(&inactive));
        assert!(
            inactive
                .chunks_exact(4)
                .zip(blurred.chunks_exact(4))
                .any(|(sharp, blur)| sharp[3] == 0 && blur[3] > 0),
            "blur must extend coverage outside the original ink",
        );
        assert!(peak(&active) > peak(&inactive));
        assert!(
            active
                .chunks_exact(4)
                .zip(glowing.chunks_exact(4))
                .any(|(sharp, glow)| sharp[3] == 0 && glow[3] > 0)
        );
    }
    #[test]
    #[ignore = "actual GPU subtitle coverage/premultiplied readback"]
    fn actual_auxiliary_gpu_pixels() {
        let mut receipts = Vec::new();
        for item in data()["packets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["fixture_line"] == 1)
        {
            // Keep the original capture timestamp from HEAD's track helper.
            let (mut shown, time, _) = track(item, true);
            let mut state = AppearanceState::default();
            let mut scene = Scene::new();
            let mut gpu = pollster::block_on(Gpu::new(shown.width, shown.height)).unwrap();
            let band = frame(&mut shown, &mut state, &mut scene, time, 10000.0);
            gpu.render_appearance(&scene, band, true, false).unwrap();
            let pixels = gpu.read_pixels().unwrap();
            for p in pixels.as_chunks::<4>().0 {
                assert!(p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
            }
            assert_eq!(&pixels[..4], &[0, 0, 0, 0]);
            shown.layout_json().unwrap();
            let cached = &shown.cached[0];
            let t = cached.lead().translation.as_ref().unwrap();
            let y = (shown.scroll_anchor() + shown.row_top(0) - shown.scroll_target(time)
                + shown.interlude_shift(time).1
                + cached.top
                + cached.lead().offset
                + cached.lead().padding
                + t.diagnostics["y"].as_f64().unwrap())
            .max(0.0) as usize;
            let y_end = (y + (t.diagnostics["height"].as_f64().unwrap().ceil() as usize))
                .min(shown.height as usize);
            let visible = pixels
                .as_chunks::<4>()
                .0
                .iter()
                .enumerate()
                .filter(|(i, p)| {
                    i / (shown.width as usize) >= y
                        && i / (shown.width as usize) < y_end
                        && p[3] > 0
                })
                .count();
            assert!(
                visible > 20,
                "{} landscape={}: actual subtitle region y={y}..{y_end} must contain ink",
                item["style"],
                item["landscape"]
            );
            let png = format!(
                "/files/rust_parity_aux_{}_{}.png",
                item["style"].as_str().unwrap(),
                if item["landscape"] == true {
                    "landscape"
                } else {
                    "portrait"
                }
            );
            gpu.save(&png).unwrap();
            let mut comparison = None;
            if item["style"] == "spicy" {
                assert!((time - 14_706.9).abs() < 1e-6);
                let Ink::Spicy {
                    words: Some(words), ..
                } = &t.ink
                else {
                    panic!("missing fixture translation words");
                };
                let gradients = words.history.lock().unwrap().gradients.clone();
                assert_eq!(gradients.len(), 6);
                assert_eq!(&gradients[..2], &[100.0, 100.0]);
                assert!((40.0..60.0).contains(&gradients[2]), "{gradients:?}");
                assert_eq!(&gradients[3..], &[-20.0, -20.0, -20.0]);
                // Capture the previous line-gradient render at the identical media
                // position, with the original packet, viewport, and scroll position.
                let p = &t.diagnostics["policy"];
                let number = |key: &str| p[key].as_f64().unwrap() as f32;
                let policy = Policy {
                    size: number("size"),
                    leading: number("leading"),
                    weight: number("weight"),
                    width: number("width"),
                    margin: number("margin"),
                    x: number("x"),
                    bottom: number("bottom"),
                    spicy: true,
                    background: false,
                };
                let legacy = Translation::prepare(
                    t.diagnostics["text"].as_str().unwrap(),
                    &policy,
                    policy.x > 0.0,
                    cached.lead().padding + cached.lead().height,
                    &mut fonts(),
                    &mut LayoutContext::new(),
                    false,
                    None,
                );
                let stem = png.strip_suffix(".png").unwrap();
                let after_png = format!("{stem}_mid_after.png");
                let before_png = format!("{stem}_mid_before.png");
                gpu.save(&after_png).unwrap();
                let current = shown.cached[0].voices[0]
                    .translation
                    .replace(legacy)
                    .unwrap();
                let legacy_band = shown.frame_appearance(
                    time,
                    shown.scroll_target(time),
                    &[],
                    &state,
                    &mut scene,
                    Effect::Motion,
                );
                assert_eq!(band, legacy_band);
                gpu.render_appearance(&scene, legacy_band, true, false)
                    .unwrap();
                let before = gpu.read_pixels().unwrap();
                let stride = shown.width as usize * 4;
                assert_ne!(
                    &before[y * stride..y_end * stride],
                    &pixels[y * stride..y_end * stride]
                );
                gpu.save(&before_png).unwrap();
                shown.cached[0].voices[0].translation = Some(current);
                comparison = Some(serde_json::json!({
                    "baseline_png": before_png,
                    "word_fill_png": after_png,
                    "word_gradients_percent": gradients,
                }));
            }
            receipts.push(serde_json::json!({"style":item["style"],"landscape":item["landscape"],"media_time_ms":time,"mid_reveal":comparison,"subtitle_pixels":visible,"png":png,"selected_layout":shown.diagnostics,"premultiplied":true,"scope":"actual Rust render; not Skia parity acceptance"}));
        }
        std::fs::write(
            "/tmp/rust-aux-pixels.json",
            serde_json::to_string_pretty(&receipts).unwrap(),
        )
        .unwrap();
    }
    #[derive(serde::Serialize)]
    struct Sample {
        scene_ms: f64,
        encode_ms: f64,
        wall_ms: f64,
        wait_readback_ms: f64,
        gpu_interval_including_queue_gaps_ms: Option<f64>,
        allocations: usize,
    }
    fn percentile(samples: &[Sample], f: impl Fn(&Sample) -> f64, p: f64) -> f64 {
        let mut v: Vec<_> = samples.iter().map(f).collect();
        v.sort_by(f64::total_cmp);
        v[(v.len() as f64 * p).ceil() as usize - 1]
    }
    #[test]
    #[ignore = "interleaved actual auxiliary effect host gate"]
    fn auxiliary_effect_budget() {
        let mut reports = Vec::new();
        for item in data()["packets"].as_array().unwrap() {
            let (mut before, time, _) = track(item, false);
            let (mut after, _, _) = track(item, true);
            let mut gpu = pollster::block_on(Gpu::new(before.width, before.height)).unwrap();
            let mut a = AppearanceState::default();
            let mut b = AppearanceState::default();
            let mut scene = Scene::new();
            for i in 0..8 {
                for (t, s) in [(&mut before, &mut a), (&mut after, &mut b)] {
                    let band = frame(t, s, &mut scene, time, 10000.0 + i as f64 * 8.333);
                    gpu.render_appearance(&scene, band, true, false).unwrap();
                }
            }
            let mut old = Vec::new();
            let mut new = Vec::new();
            for i in 0..90 {
                for slot in 0..2 {
                    let is_new = (i + slot) % 2 == 1;
                    let (t, s) = if is_new {
                        (&mut after, &mut b)
                    } else {
                        (&mut before, &mut a)
                    };
                    let mut band = (0.0, 0.0);
                    let started = Instant::now();
                    let allocations = crate::allocation_probe::measure(|| {
                        band = frame(
                            t,
                            s,
                            &mut scene,
                            time + i as f64 * 8.333,
                            11000.0 + i as f64 * 8.333,
                        );
                    });
                    let scene_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let started = Instant::now();
                    let stats = gpu.render_appearance(&scene, band, true, false).unwrap();
                    let sample = Sample {
                        scene_ms,
                        encode_ms: stats.cpu_encode_ms,
                        wall_ms: started.elapsed().as_secs_f64() * 1000.0,
                        wait_readback_ms: stats.wait_readback_ms,
                        gpu_interval_including_queue_gaps_ms: stats.gpu_interval_ms,
                        allocations,
                    };
                    if is_new {
                        new.push(sample)
                    } else {
                        old.push(sample)
                    }
                }
            }
            let sa = percentile(&old, |s| s.scene_ms, 0.5);
            let sb = percentile(&new, |s| s.scene_ms, 0.5);
            let ea = percentile(&old, |s| s.encode_ms, 0.95);
            let eb = percentile(&new, |s| s.encode_ms, 0.95);
            let accepted = sb <= sa * 1.25 + 0.01
                && eb <= ea * 1.25 + 0.5
                && new.iter().all(|s| s.allocations == 0);
            reports.push(serde_json::json!({"style":item["style"],"landscape":item["landscape"],"fixture_line":item["fixture_line"],"adapter":gpu.adapter,"scene_p50_ms":[sa,sb],"encode_p95_ms":[ea,eb],"accepted":accepted,"before":old,"after":new}));
        }
        let all = reports.iter().all(|r| r["accepted"] == true);
        std::fs::write("/tmp/rust-aux-budget.json",serde_json::to_string_pretty(&serde_json::json!({"scope":"debug-profile Linux host proxy; one subtitle visibility effect; before/after actual same source packets except subtitle visibility; no native present/phone proof","native_present_calls_per_second":null,"warmup":8,"samples":90,"thresholds":{"scene_p50_ms":"before*1.25+0.01","encode_p95_ms":"before*1.25+0.5","allocations":0},"reports":reports})).unwrap()).unwrap();
        assert!(
            all,
            "auxiliary feature rejected; inspect /tmp/rust-aux-budget.json"
        );
    }
}
