//! Shape whole lines once. Frames reuse encoded white glyph scenes and byte-range clips.
use crate::{Line, focus, progress};
use parley::{
    Alignment, AlignmentOptions, FontFamily, FontWeight, LayoutContext, LineHeight,
    PositionedLayoutItem, StyleProperty,
};
use vello::{
    Glyph, Scene,
    kurbo::{Affine, Rect},
    peniko::{BlendMode, Color, Fill},
};

type Error = Box<dyn std::error::Error>;

pub(crate) struct CachedLine {
    pub(crate) white: Scene,
    pub(crate) plain: Scene,
    pub(crate) height: f64,
    /// One or more visual fragments for each timed atom, including wrapped syllables.
    atoms: Vec<Vec<Rect>>,
    pub(crate) words: Vec<crate::typography::WordRange>,
    pub(crate) top: f64,
    pub(crate) x: f64,
    pub(crate) layout: Option<parley::Layout<()>>,
    pub(crate) detailed: bool,
    pub(crate) timed: Option<Vec<crate::timed_scene::TimedWord>>,
    pub(crate) size: f64,
    pub(crate) lane: f64,
    pub(crate) right: bool,
    pub(crate) content_height: f64,
}

pub struct TrackScene {
    pub lines: Vec<Line>,
    pub(crate) cached: Vec<CachedLine>,
    pub width: u32,
    pub height: u32,
    pub font_size: f64,
    pub glyph_count: usize,
    pub missing_glyphs: usize,
    pub(crate) prefix: Vec<f64>,
    pub diagnostics: Vec<serde_json::Value>,
    fonts: Option<crate::typography::Fonts>,
    settings: Option<crate::typography::Settings>,
    pub(crate) scale: f32,
    pub plain_preparations: usize,
    pub detailed_preparations: usize,
    prepared_signature: Option<(usize, usize, usize)>,
}

#[allow(
    clippy::too_many_arguments,
    reason = "Static shaping parameters are explicit"
)]
fn shape(
    text: &str,
    fonts: &mut parley::FontContext,
    layouts: &mut LayoutContext<()>,
    size: f32,
    line_height: f32,
    weight: f32,
    family: &str,
    words: &[crate::typography::WordRange],
    spacing: f32,
) -> parley::Layout<()> {
    let mut builder = layouts.ranged_builder(fonts, text, 1.0, true);
    builder.push_default(StyleProperty::FontFamily(FontFamily::Source(family.into())));
    builder.push_default(StyleProperty::FontSize(size));
    builder.push_default(StyleProperty::FontWeight(FontWeight::new(weight)));
    builder.push_default(StyleProperty::LineHeight(LineHeight::Absolute(line_height)));
    for word in words {
        if word.gap && text.get(word.bytes.end..word.bytes.end + 1) == Some(" ") {
            builder.push(
                StyleProperty::LetterSpacing(spacing),
                word.bytes.end..word.bytes.end + 1,
            );
        }
    }
    let mut layout = builder.build(text);
    layout.break_all_lines(None);
    layout
}
fn cluster_widths(layout: &parley::Layout<()>) -> Vec<(std::ops::Range<usize>, f64)> {
    layout
        .lines()
        .flat_map(|l| {
            l.runs().flat_map(|r| {
                r.visual_clusters()
                    .map(|c| (c.text_range(), c.advance() as f64))
            })
        })
        .collect()
}
fn measure(clusters: &[(std::ops::Range<usize>, f64)], range: std::ops::Range<usize>) -> f64 {
    clusters
        .iter()
        .filter(|(r, _)| r.start < range.end && r.end > range.start)
        .map(|(_, width)| width)
        .sum()
}

pub(crate) fn fragments(
    layout: &parley::Layout<()>,
    words: &[crate::typography::WordRange],
) -> Vec<Vec<Rect>> {
    let mut atoms: Vec<Vec<Rect>> = vec![Vec::new(); words.len()];
    for row in layout.lines() {
        let metrics = row.metrics();
        let mut x = metrics.offset as f64;
        for run in row.runs() {
            for cluster in run.visual_clusters() {
                let advance = cluster.advance() as f64;
                let range = cluster.text_range();
                for (i, word) in words.iter().enumerate() {
                    if range.start < word.bytes.end && range.end > word.bytes.start {
                        let rect = Rect::new(
                            x,
                            metrics.block_min_coord as f64,
                            x + advance,
                            metrics.block_max_coord as f64,
                        );
                        if let Some(last) = atoms[i].last_mut().filter(|r: &&mut Rect| {
                            (r.y0 - rect.y0).abs() < 0.1 && (r.x1 - rect.x0).abs() < 0.1
                        }) {
                            *last = last.union(rect);
                        } else {
                            atoms[i].push(rect);
                        }
                    }
                }
                x += advance;
            }
        }
    }
    atoms
}

impl TrackScene {
    pub fn new(width: u32, height: u32) -> Result<Self, Error> {
        Self::from_lines(crate::fixture()?, width, height, 1.0)
    }

    pub fn from_lines(
        lines: Vec<Line>,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, Error> {
        if lines.is_empty()
            || width == 0
            || height == 0
            || !scale.is_finite()
            || scale <= 0.0
            || scale > 4.0
        {
            return Err("Invalid layout size, scale or empty lyrics".into());
        }
        let mut fonts = crate::typography::Fonts::default();
        Self::with_fonts(lines, width, height, scale, None, &mut fonts)
    }

    pub fn with_fonts(
        lines: Vec<Line>,
        width: u32,
        height: u32,
        scale: f32,
        settings: Option<&crate::typography::Settings>,
        fonts: &mut crate::typography::Fonts,
    ) -> Result<Self, Error> {
        let Some(settings) = settings else {
            return Self::with_fonts_eager(lines, width, height, scale, None, fonts, true);
        };
        if lines.is_empty()
            || width == 0
            || height == 0
            || !scale.is_finite()
            || !(0.5..=4.0).contains(&scale)
            || !fonts.ready
            || !settings.font_scale.is_finite()
            || !(0.5..=2.0).contains(&settings.font_scale)
        {
            return Err("Invalid lazy layout settings or fonts".into());
        }
        let mut cached = Vec::with_capacity(lines.len());
        let mut prefix = Vec::with_capacity(lines.len());
        let mut offset = 0.0;
        for line in &lines {
            let voice = line
                .paint
                .as_ref()
                .ok_or("Prepared style voice is missing")?;
            voice.validate(line.start, line.end)?;
            let g = settings.geometry(width, scale, voice);
            let height = if settings.style == crate::typography::Style::Spicy {
                84.0
            } else {
                72.0
            } * settings.font_scale
                * scale;
            prefix.push(offset);
            offset += f64::from(height);
            cached.push(CachedLine {
                white: Scene::new(),
                plain: Scene::new(),
                height: height.into(),
                atoms: Vec::new(),
                words: Vec::new(),
                top: 0.0,
                x: g.x.into(),
                layout: None,
                detailed: false,
                timed: None,
                size: f64::from(g.font_size),
                lane: f64::from(g.text_width),
                right: g.right,
                content_height: 0.0,
            });
        }
        let count = lines.len();
        let primary_size = settings
            .geometry(
                width,
                scale,
                lines[0].paint.as_ref().expect("validated paint"),
            )
            .font_size;
        Ok(Self {
            lines,
            cached,
            width,
            height,
            font_size: f64::from(primary_size),
            glyph_count: 0,
            missing_glyphs: 0,
            prefix,
            diagnostics: vec![serde_json::Value::Null; count],
            fonts: Some(fonts.clone()),
            settings: Some(settings.clone()),
            scale,
            plain_preparations: 0,
            detailed_preparations: 0,
            prepared_signature: None,
        })
    }

    /// Static preparation only when a row enters the visible/near-active window.
    /// Inactive rows retain a plain paragraph; only active + next2 build timed fragments.
    pub fn prepare(&mut self, time: f64) -> Result<(), Error> {
        if self.settings.is_none() {
            return Ok(());
        }
        let active = focus(&self.lines, time);
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
        let detail_end = (last + 2).min(self.lines.len() - 1);
        let signature = (active, first, detail_end);
        if self.prepared_signature == Some(signature) {
            return Ok(());
        }
        // Overscan covers scrolling into/out of the focused viewport. Plain rows are
        // prepared only here, never the whole future track, and do not build slices.
        let mut start = first;
        let mut extent = 0.0;
        while start > 0 && extent < f64::from(self.height) {
            start -= 1;
            extent += self.cached[start].height;
        }
        let mut end = detail_end;
        extent = 0.0;
        while end + 1 < self.lines.len() && extent < f64::from(self.height) * 1.5 {
            end += 1;
            extent += self.cached[end].height;
        }
        let mut changed = false;
        for i in start..=end {
            let detailed = i >= first && i <= detail_end;
            if self.cached[i].layout.is_none() {
                let mut prepared = Self::with_fonts_eager(
                    vec![self.lines[i].clone()],
                    self.width,
                    self.height,
                    self.scale,
                    self.settings.as_ref(),
                    self.fonts.as_mut().expect("lazy fonts"),
                    detailed,
                )?;
                self.glyph_count += prepared.glyph_count;
                self.missing_glyphs += prepared.missing_glyphs;
                self.cached[i] = prepared.cached.remove(0);
                self.diagnostics[i] = prepared.diagnostics.remove(0);
                self.plain_preparations += 1;
                self.detailed_preparations += usize::from(detailed);
                changed = true;
            } else if detailed && !self.cached[i].detailed {
                let cached = &mut self.cached[i];
                if cached.atoms.is_empty() {
                    cached.atoms = fragments(
                        cached.layout.as_ref().expect("prepared layout"),
                        &cached.words,
                    );
                    self.detailed_preparations += 1;
                }
                if cached.timed.is_none() {
                    cached.timed = self.lines[i].paint.as_ref().map(|voice| {
                        crate::timed_scene::geometry(
                            cached.layout.as_ref().expect("prepared"),
                            &cached.words,
                            voice,
                        )
                    });
                }
                cached.detailed = true;
            }
            if !detailed && self.cached[i].detailed {
                // Retain immutable paragraph geometry but no per-word slice processing.
                self.cached[i].detailed = false;
            }
        }
        // Bound glyph/paragraph ownership while preserving measured row heights.
        // Cached track variants are bounded separately by the native owner.
        for i in 0..self.cached.len() {
            if !(first..=detail_end).contains(&i) {
                self.cached[i].detailed = false;
            }
            if i.abs_diff(active) > 32 && (i < start || i > end) && self.cached[i].layout.is_some()
            {
                self.cached[i].layout = None;
                self.cached[i].white = Scene::new();
                self.cached[i].plain = Scene::new();
                self.cached[i].atoms = Vec::new();
                self.cached[i].words = Vec::new();
                self.cached[i].detailed = false;
                self.cached[i].timed = None;
                self.diagnostics[i] = serde_json::Value::Null;
            }
        }
        if changed {
            let mut offset = 0.0;
            for (i, cached) in self.cached.iter().enumerate() {
                self.prefix[i] = offset;
                offset += cached.height;
            }
        }
        self.prepared_signature = Some(signature);
        Ok(())
    }

    fn with_fonts_eager(
        lines: Vec<Line>,
        width: u32,
        height: u32,
        scale: f32,
        settings: Option<&crate::typography::Settings>,
        fonts: &mut crate::typography::Fonts,
        detailed: bool,
    ) -> Result<Self, Error> {
        if lines.is_empty()
            || width == 0
            || height == 0
            || !scale.is_finite()
            || !(0.5..=4.0).contains(&scale)
        {
            return Err("Invalid layout size or scale".into());
        }
        if settings.is_some() && !fonts.ready {
            return Err("Bundled fonts are not registered".into());
        }
        let mut layouts = LayoutContext::<()>::new();
        let font_size = 34.0 * scale;
        let mut cached = Vec::new();
        let mut glyph_count = 0;
        let mut missing_glyphs = 0;
        let mut prefix = Vec::new();
        let mut offset = 0.0;
        let mut diagnostics = Vec::new();
        for line in &lines {
            let geometry = settings
                .zip(line.paint.as_ref())
                .map(|(settings, voice)| settings.geometry(width, scale, voice));
            if settings.is_some() && geometry.is_none() {
                return Err("Style packet requires prepared voice metadata".into());
            }
            let size = geometry.as_ref().map_or(font_size, |g| g.font_size);
            let lane = geometry.as_ref().map_or_else(
                || {
                    if width < height {
                        (width as f32 - 64.0 * scale).max(size)
                    } else {
                        width as f32 * 0.67
                    }
                },
                |g| g.text_width,
            );
            let line_height = geometry.as_ref().map_or(size * 1.35, |g| g.line_height);
            let weight = geometry.as_ref().map_or(800.0, |g| g.weight);
            let family = if settings.is_some() {
                "'SF Pro Display', sans-serif"
            } else if cfg!(target_vendor = "apple") {
                "sans-serif"
            } else {
                "Noto Sans CJK KR"
            };
            let mut spacing = 0.0;
            let (text, words) = if let (Some(settings), Some(voice)) =
                (settings, line.paint.as_ref())
            {
                let probe = shape(
                    "0 ",
                    &mut fonts.context,
                    &mut layouts,
                    size,
                    line_height,
                    weight,
                    family,
                    &[],
                    0.0,
                );
                let advances = cluster_widths(&probe);
                let ch = measure(&advances, 0..1);
                let space = measure(&advances, 1..2);
                spacing = ch as f32 * 0.32 - space as f32;
                let raw_words: Vec<_> = voice
                    .words
                    .iter()
                    .map(|w| {
                        let start = crate::typography::byte_index(&voice.text, w.offset)
                            .expect("validated voice");
                        crate::typography::WordRange {
                            bytes: start..start + w.text.len(),
                            start: w.start,
                            end: w.end,
                            gap: w.gap_after,
                        }
                    })
                    .collect();
                let unwrapped = shape(
                    &voice.text,
                    &mut fonts.context,
                    &mut layouts,
                    size,
                    line_height,
                    weight,
                    family,
                    &raw_words,
                    spacing,
                );
                let advances = cluster_widths(&unwrapped);
                crate::typography::wrap(voice, settings.style, f64::from(lane / scale), |range| {
                    measure(&advances, range) / f64::from(scale)
                })
            } else {
                (
                    line.text.clone(),
                    line.atoms
                        .iter()
                        .map(|a| crate::typography::WordRange {
                            bytes: a.bytes.clone(),
                            start: a.start,
                            end: a.end,
                            gap: false,
                        })
                        .collect(),
                )
            };
            let mut layout = shape(
                &text,
                &mut fonts.context,
                &mut layouts,
                size,
                line_height,
                weight,
                family,
                &words,
                spacing,
            );
            layout.break_all_lines(Some(lane));
            layout.align(
                if geometry.as_ref().is_some_and(|g| g.right) {
                    Alignment::End
                } else {
                    Alignment::Start
                },
                AlignmentOptions::default(),
            );
            let mut white = Scene::new();
            let mut plain = Scene::new();
            let mut atoms = Vec::new();
            let mut faces = Vec::new();
            for row in layout.lines() {
                for item in row.items() {
                    if let PositionedLayoutItem::GlyphRun(gr) = item {
                        let run = gr.run();
                        let face = fonts.describe(run.font());
                        faces.push(serde_json::json!({"face":face,"text_bytes":[run.text_range().start,run.text_range().end],
                            "requested_attributes":format!("{:?}",run.font_attrs()), "size":run.font_size(),
                            "normalized_coords":run.normalized_coords().iter().map(|c|c.to_bits()).collect::<Vec<_>>() }));
                        let glyphs: Vec<Glyph> = gr
                            .positioned_glyphs()
                            .map(|g| {
                                glyph_count += 1;
                                missing_glyphs += usize::from(g.id == 0);
                                Glyph {
                                    id: g.id,
                                    x: g.x,
                                    y: g.y,
                                }
                            })
                            .collect();
                        if settings.is_some() {
                            plain
                                .draw_glyphs(run.font())
                                .font_size(run.font_size())
                                .normalized_coords(
                                    &run.normalized_coords()
                                        .iter()
                                        .map(|c| c.to_bits())
                                        .collect::<Vec<_>>(),
                                )
                                .brush(Color::new([1.0, 0.0, 0.0, 1.0]))
                                .draw(Fill::NonZero, glyphs.iter().copied());
                        }
                        white
                            .draw_glyphs(run.font())
                            .font_size(run.font_size())
                            .normalized_coords(
                                &run.normalized_coords()
                                    .iter()
                                    .map(|c| c.to_bits())
                                    .collect::<Vec<_>>(),
                            )
                            .brush(Color::WHITE)
                            .draw(Fill::NonZero, glyphs.into_iter());
                    }
                }
            }
            if detailed {
                atoms = fragments(&layout, &words);
            }
            let content_height = layout.height() as f64;
            let (height, top, x, gap) = if let Some(g) = &geometry {
                let settings = settings.expect("geometry has settings");
                let min = if settings.style == crate::typography::Style::Spicy {
                    84.0
                } else {
                    72.0
                } * settings.font_scale
                    * scale;
                let height = (content_height + 2.0 * g.row_padding as f64).max(min as f64);
                let top = if settings.style == crate::typography::Style::Spicy {
                    (height - content_height) / 2.0
                } else {
                    g.row_padding as f64
                };
                (height, top, g.x as f64, 0.0)
            } else {
                (
                    content_height,
                    0.0,
                    if width < height {
                        32.0 * scale as f64
                    } else {
                        width as f64 * 0.165
                    },
                    font_size as f64 * 0.7,
                )
            };
            prefix.push(offset);
            offset += height + gap;
            diagnostics.push(serde_json::json!({"geometry":geometry,"text":text,"height":height,"content_top":top,
                "content_height":content_height,"faces":faces,"line_count":layout.len(),
                "word_ranges":words.iter().map(|w|vec![w.bytes.start,w.bytes.end]).collect::<Vec<_>>() }));
            let timed = if detailed {
                line.paint
                    .as_ref()
                    .map(|voice| crate::timed_scene::geometry(&layout, &words, voice))
            } else {
                None
            };
            cached.push(CachedLine {
                white,
                plain,
                height,
                atoms,
                words,
                top,
                x,
                layout: Some(layout),
                detailed,
                timed,
                size: f64::from(size),
                lane: f64::from(lane),
                right: geometry.as_ref().is_some_and(|g| g.right),
                content_height,
            });
        }
        if missing_glyphs > 0 {
            return Err(
                format!("{missing_glyphs} missing glyphs (tofu); install Noto Sans CJK").into(),
            );
        }
        Ok(Self {
            lines,
            cached,
            width,
            height,
            font_size: font_size as f64,
            glyph_count,
            missing_glyphs,
            prefix,
            diagnostics,
            fonts: None,
            settings: None,
            scale,
            plain_preparations: 0,
            detailed_preparations: 0,
            prepared_signature: None,
        })
    }

    pub fn style(&self) -> Option<crate::typography::Style> {
        self.settings.as_ref().map(|s| s.style)
    }
    pub fn timed_ready(&self, index: usize) -> bool {
        self.cached
            .get(index)
            .is_some_and(|c| c.detailed && c.timed.is_some())
    }
    pub fn geometry_ready(&self, index: usize) -> bool {
        self.cached.get(index).is_some_and(|c| c.layout.is_some())
    }

    /// Returns protected band in output pixels, including the entire next line.
    pub fn frame(&mut self, time: f64, scene: &mut Scene) -> (f32, f32) {
        self.frame_at(time, self.scroll_target(time), scene)
    }

    pub fn scroll_target(&self, time: f64) -> f64 {
        self.prefix[focus(&self.lines, time)]
    }

    pub fn frame_at(&mut self, time: f64, scroll: f64, scene: &mut Scene) -> (f32, f32) {
        let old_target = self.scroll_target(time);
        self.prepare(time).expect("validated on-demand layout");
        let scroll = scroll + self.scroll_target(time) - old_target;
        self.frame_prepared(time, scroll, scene)
    }

    pub(crate) fn frame_prepared(&self, time: f64, scroll: f64, scene: &mut Scene) -> (f32, f32) {
        scene.reset();
        let active = focus(&self.lines, time);
        let scale = f64::from(self.scale);
        let anchor = self.height as f64 * 0.37;
        let position = |index: usize| anchor + self.prefix[index] - scroll;
        for (i, cached) in self.cached.iter().enumerate() {
            let y = position(i);
            if y + cached.height < -40.0 || y > self.height as f64 + 40.0 {
                continue;
            }
            let transform = Affine::translate((cached.x, y + cached.top));
            let bounds = Rect::new(-8.0, -8.0, self.width as f64, cached.height + 8.0);
            let singing = time >= self.lines[i].start && time < self.lines[i].end;
            let opacity = if i == active || singing {
                0.4
            } else if i == active + 1 {
                0.5
            } else {
                0.38
            };
            scene.push_layer(
                Fill::NonZero,
                BlendMode::default(),
                opacity,
                transform,
                &bounds,
            );
            scene.append(&cached.white, Some(transform));
            scene.pop_layer();
            if i == active || singing {
                for (atom, fragments) in cached.words.iter().zip(&cached.atoms) {
                    let mut remaining = fragments.iter().map(|r| r.width()).sum::<f64>()
                        * progress(time, atom.start, atom.end);
                    for rect in fragments {
                        let fill = remaining.clamp(0.0, rect.width());
                        remaining -= rect.width();
                        if fill <= 0.0 {
                            continue;
                        }
                        let clip = Rect::new(rect.x0, rect.y0, rect.x0 + fill, rect.y1);
                        scene.push_clip_layer(Fill::NonZero, transform, &clip);
                        scene.append(&cached.white, Some(transform));
                        scene.pop_layer();
                    }
                }
            }
        }
        let first = self
            .lines
            .iter()
            .position(|line| time >= line.start && time < line.end)
            .unwrap_or(active);
        let last = self
            .lines
            .iter()
            .rposition(|line| time >= line.start && time < line.end)
            .unwrap_or(active);
        let next = (last.max(active) + 1).min(self.lines.len() - 1);
        (
            (position(first.min(active)) - 10.0 * scale) as f32,
            (position(next) + self.cached[next].height + 10.0 * scale) as f32,
        )
    }
}

/// Per-native-owner cache. Font bytes are immutable and exact-role validated;
/// source, timings, paint mappings, settings, DPR and extent all participate.
#[derive(Default)]
pub struct LayoutCache {
    entries: std::collections::VecDeque<(String, TrackScene)>,
}
impl LayoutCache {
    pub fn key(
        track_id: &str,
        lines: &[Line],
        settings: &crate::typography::Settings,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<String, serde_json::Error> {
        use sha2::Digest;
        let bytes = serde_json::to_vec(&(
            track_id,
            lines,
            settings,
            width,
            height,
            scale,
            crate::typography::BUNDLED_FONT_HASHES,
        ))?;
        Ok(format!("{:x}", sha2::Sha256::digest(bytes)))
    }
    pub fn take(&mut self, key: &str) -> Option<TrackScene> {
        self.entries
            .iter()
            .position(|(k, _)| k == key)
            .and_then(|i| self.entries.remove(i))
            .map(|(_, scene)| scene)
    }
    pub fn insert(&mut self, key: String, scene: TrackScene) {
        if let Some(i) = self.entries.iter().position(|(k, _)| *k == key) {
            self.entries.remove(i);
        }
        self.entries.push_back((key, scene));
        while self.entries.len() > 3 {
            self.entries.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn line_boundary_scroll_is_continuous_and_protection_follows_motion() {
        let mut track = TrackScene::new(390, 600).unwrap();
        let boundary = track.lines[1].start;
        let old_target = track.scroll_target(boundary - 0.01);
        let new_target = track.scroll_target(boundary);
        assert!(new_target > old_target + track.font_size);
        let mut scroll = crate::motion::Scroll::default();
        scroll.sample(old_target, 1000.0);
        let at_change = scroll.sample(new_target, 1000.0);
        assert_eq!(at_change, old_target);
        let mut scene = Scene::new();
        let initial = track.frame_at(boundary, at_change, &mut scene);
        let moving = scroll.sample(new_target, 1016.0);
        assert!(moving > old_target && moving < new_target);
        let advanced = track.frame_at(boundary, moving, &mut scene);
        assert!((initial.0 - advanced.0 - (moving - old_target) as f32).abs() < 0.001);
        assert!((initial.1 - advanced.1 - (moving - old_target) as f32).abs() < 0.001);
    }
    #[test]
    fn overlapping_live_leads_keep_both_in_protected_band() {
        let mut track = TrackScene::new(390, 844).unwrap();
        let mut scene = Scene::new();
        let overlapping = track.frame(88_200.0, &mut scene);
        let after = track.frame(88_500.0, &mut scene);
        assert!(overlapping.0 < 844.0 * 0.37 - 40.0);
        assert!((after.0 - (844.0 * 0.37 - 10.0)).abs() < 0.1);
    }
}

#[cfg(test)]
mod lazy_tests {
    use super::*;
    use crate::typography::{Fonts, PaintVoice, PaintWord, Settings, Style};
    fn source(count: usize) -> Vec<Line> {
        (0..count)
            .map(|i| {
                let text = format!("line {i} office");
                let start = i as f64 * 1000.0;
                let boundaries: Vec<_> = icu_segmenter::GraphemeClusterSegmenter::new()
                    .segment_str(&text)
                    .collect();
                let graphemes = boundaries
                    .windows(2)
                    .map(|r| text[r[0]..r[1]].to_string())
                    .collect();
                Line {
                    text: text.clone(),
                    start,
                    end: start + 1000.0,
                    atoms: vec![crate::Atom {
                        bytes: 0..text.len(),
                        start,
                        end: start + 1000.0,
                    }],
                    paint: Some(PaintVoice {
                        text: text.clone(),
                        words: vec![PaintWord {
                            appearance: None,
                            text,
                            offset: 0,
                            start,
                            end: start + 1000.0,
                            joined: false,
                            gap_after: false,
                            group: None,
                            graphemes,
                        }],
                        cjk_breaks: vec![],
                        opposite: false,
                        duet: false,
                    }),
                }
            })
            .collect()
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
    #[test]
    fn lazy_plain_rows_near_active_slices_and_zero_steady_scene_allocations() {
        let mut fonts = fonts();
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(source(100), 390, 640, 1.0, Some(&settings), &mut fonts)
                .unwrap();
        assert_eq!(track.plain_preparations, 0);
        assert_eq!(track.detailed_preparations, 0);
        track.prepare(500.0).unwrap();
        assert!(track.plain_preparations < 25);
        assert_eq!(track.detailed_preparations, 3);
        assert!(track.cached[0].detailed && track.cached[2].detailed);
        assert!(!track.cached[3].detailed && track.cached[3].atoms.is_empty());
        assert!(
            track.diagnostics[0]["faces"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["face"]["sha256"]
                    == "a981001f6d4e70292fd26fa8e05437c4a9f0f8c5981027ff0ceead01bb30311f")
        );
        let prepared = (track.plain_preparations, track.detailed_preparations);
        let mut scene = Scene::new();
        track.frame(999.0, &mut scene);
        track.frame(999.0, &mut scene);
        let allocations = crate::allocation_probe::measure(|| {
            for i in 0..120 {
                track.frame(500.0 + i as f64, &mut scene);
            }
        });
        assert_eq!(
            allocations, 0,
            "steady application scene construction must reuse buffers"
        );
        assert_eq!(
            prepared,
            (track.plain_preparations, track.detailed_preparations)
        );
        track.prepare(50_500.0).unwrap();
        assert!(track.cached[0].layout.is_none());
        assert!(!track.cached[0].detailed);
        assert!(track.cached[50].detailed);
        assert!(track.cached.iter().filter(|r| r.detailed).count() <= 3);
    }
    #[test]
    fn source_style_font_scale_extent_dpr_and_alignment_invalidate_and_rotation_reuses() {
        let lines = source(20);
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let key = LayoutCache::key("test-track", &lines, &settings, 390, 640, 1.0).unwrap();
        assert_ne!(
            key,
            LayoutCache::key("different-track", &lines, &settings, 390, 640, 1.0).unwrap()
        );
        let mut settings2 = settings.clone();
        settings2.style = Style::Amll;
        assert_ne!(
            key,
            LayoutCache::key("test-track", &lines, &settings2, 390, 640, 1.0).unwrap()
        );
        settings2 = settings.clone();
        settings2.font_scale = 0.9;
        assert_ne!(
            key,
            LayoutCache::key("test-track", &lines, &settings2, 390, 640, 1.0).unwrap()
        );
        assert_ne!(
            key,
            LayoutCache::key("test-track", &lines, &settings, 640, 390, 1.0).unwrap()
        );
        assert_ne!(
            key,
            LayoutCache::key("test-track", &lines, &settings, 390, 640, 2.0).unwrap()
        );
        let mut changed = lines.clone();
        changed[0].paint.as_mut().unwrap().opposite = true;
        assert_ne!(
            key,
            LayoutCache::key("test-track", &changed, &settings, 390, 640, 1.0).unwrap()
        );
        changed = lines.clone();
        changed[0].atoms[0].end -= 1.0;
        assert_ne!(
            key,
            LayoutCache::key("test-track", &changed, &settings, 390, 640, 1.0).unwrap()
        );
        let mut fonts = fonts();
        let mut scene =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
        scene.prepare(500.0).unwrap();
        let count = scene.plain_preparations;
        let mut cache = LayoutCache::default();
        cache.insert(key.clone(), scene);
        let mut restored = cache.take(&key).unwrap();
        restored.prepare(500.0).unwrap();
        assert_eq!(count, restored.plain_preparations);
        assert!(cache.take(&key).is_none());
    }
}
