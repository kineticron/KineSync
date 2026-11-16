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

/// One shaped row voice: the lead, then any background voices, in source order.
pub(crate) struct CachedVoice {
    pub(crate) white: Scene,
    pub(crate) plain: Scene,
    pub(crate) idle: Option<Scene>,
    pub(crate) translation: Option<crate::auxiliary::Translation>,
    /// Shaped paragraph height, excluding this voice's padding and translation.
    pub(crate) height: f64,
    /// One or more visual fragments for each timed atom, including wrapped syllables.
    atoms: Vec<Vec<Rect>>,
    pub(crate) words: Vec<crate::typography::WordRange>,
    pub(crate) layout: Option<parley::Layout<()>>,
    pub(crate) detailed: bool,
    pub(crate) timed: Option<Vec<crate::timed_scene::TimedWord>>,
    pub(crate) size: f64,
    pub(crate) lane: f64,
    pub(crate) right: bool,
    /// Absolute surface x of the shaped paragraph.
    pub(crate) x: f64,
    /// Offset from the row content top to this voice's padding box.
    pub(crate) offset: f64,
    /// Inner padding above and below the paragraph (Skia AMLL background).
    pub(crate) padding: f64,
    /// Voice alpha multiplier (Skia AMLL background container opacity).
    pub(crate) alpha: f64,
    /// Spicy vertical motion unit: the parent row type size for backgrounds.
    pub(crate) unit: f64,
    pub(crate) background: bool,
}
impl CachedVoice {
    /// Everything this voice adds to its row, including padding and translation.
    pub(crate) fn box_height(&self) -> f64 {
        self.padding * 2.0 + self.height + self.translation.as_ref().map_or(0.0, |t| t.extra_height)
    }
    fn placeholder(voice: &crate::typography::VoiceBox) -> Self {
        Self {
            white: Scene::new(),
            plain: Scene::new(),
            idle: None,
            translation: None,
            height: 0.0,
            atoms: Vec::new(),
            words: Vec::new(),
            layout: None,
            detailed: false,
            timed: None,
            size: f64::from(voice.geometry.font_size),
            lane: f64::from(voice.geometry.text_width),
            right: voice.geometry.right,
            x: f64::from(voice.geometry.x),
            offset: 0.0,
            padding: f64::from(voice.padding),
            alpha: f64::from(voice.alpha),
            unit: f64::from(voice.unit),
            background: voice.background,
        }
    }
    fn clear_geometry(&mut self) {
        self.layout = None;
        self.white = Scene::new();
        self.plain = Scene::new();
        self.idle = None;
        self.translation = None;
        self.atoms = Vec::new();
        self.words = Vec::new();
        self.detailed = false;
        self.timed = None;
    }
}

pub(crate) struct CachedLine {
    pub(crate) voices: Vec<CachedVoice>,
    pub(crate) height: f64,
    pub(crate) top: f64,
    /// Total measured height of every voice box in this row, background voices
    /// included. Drives row measurement and the AMLL lead scale pivot.
    pub(crate) content_height: f64,
    /// Lead voice mirrors used by the interlude dot styling.
    pub(crate) size: f64,
    pub(crate) lane: f64,
    pub(crate) x: f64,
    pub(crate) right: bool,
}
impl CachedLine {
    pub(crate) fn lead(&self) -> &CachedVoice {
        &self.voices[0]
    }
    pub(crate) fn layout_ready(&self) -> bool {
        self.voices.iter().all(|voice| voice.layout.is_some())
    }
    pub(crate) fn timed_ready(&self) -> bool {
        self.voices
            .iter()
            .all(|voice| voice.detailed && voice.timed.is_some())
    }
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
    pub(crate) interludes: Vec<Option<crate::interlude::Interlude>>,
    pub(crate) dot_glyph: Option<crate::interlude::DotGlyph>,
    pub diagnostics: Vec<serde_json::Value>,
    fonts: Option<crate::typography::Fonts>,
    settings: Option<crate::typography::Settings>,
    pub(crate) scale: f32,
    pub plain_preparations: usize,
    pub detailed_preparations: usize,
    pub(crate) footer: Option<crate::credits::Footer>,
    prepared_signature: Option<(usize, usize, usize, usize)>,
}

#[allow(
    clippy::too_many_arguments,
    reason = "Static shaping parameters are explicit"
)]
pub(crate) fn shape(
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

/// Skia row voice boxes: the lead first, then its background voices in source
/// order. The legacy fixture path keeps its single anonymous voice.
/// Source: `native-lyric-row.tsx:112-129`, `native-skia-voice.tsx:143-152`.
fn row_voice_boxes(
    line: &Line,
    width: u32,
    height: u32,
    scale: f32,
    settings: Option<&crate::typography::Settings>,
    font_size: f32,
) -> Vec<crate::typography::VoiceBox> {
    let Some(settings) = settings else {
        let text_width = if width < height {
            (width as f32 - 64.0 * scale).max(font_size)
        } else {
            width as f32 * 0.67
        };
        return vec![crate::typography::VoiceBox {
            unit: font_size,
            margin_top: 0.0,
            padding: 0.0,
            alpha: 1.0,
            background: false,
            geometry: crate::typography::Geometry {
                font_size,
                line_height: font_size * 1.35,
                weight: 800.0,
                lane_width: text_width,
                text_width,
                x: if width < height {
                    32.0 * scale
                } else {
                    width as f32 * 0.165
                },
                row_padding: 0.0,
                right: false,
            },
        }];
    };
    let Some(lead_voice) = line.paint.as_ref() else {
        return Vec::new();
    };
    let lead = settings.row_voice(width, scale, lead_voice);
    line.voices()
        .enumerate()
        .map(|(index, source)| {
            if index == 0 {
                lead.clone()
            } else {
                settings.background_voice(source, &lead.geometry, scale)
            }
        })
        .collect()
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
        Self::with_fonts_credits(lines, width, height, scale, settings, None, fonts)
    }

    /// Track layout plus the optional Skia footer. Credits are part of the
    /// prepared content (scroll extent, auto-scroll target and blur band), so
    /// they are built with the same fonts in the same layout pass.
    pub(crate) fn with_fonts_credits(
        lines: Vec<Line>,
        width: u32,
        height: u32,
        scale: f32,
        settings: Option<&crate::typography::Settings>,
        credits: Option<&crate::live::Credits>,
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
            for background in &line.backgrounds {
                let (start, end) = background.interval();
                background.validate(start, end)?;
            }
            let lead = settings.row_voice(width, scale, voice);
            let mut voices = Vec::with_capacity(line.voice_count());
            for (index, source) in line.voices().enumerate() {
                let voice_box = if index == 0 {
                    lead.clone()
                } else {
                    settings.background_voice(source, &lead.geometry, scale)
                };
                voices.push(CachedVoice::placeholder(&voice_box));
            }
            let height = if settings.style == crate::typography::Style::Spicy {
                84.0
            } else {
                72.0
            } * settings.font_scale
                * scale;
            prefix.push(offset);
            offset += f64::from(height);
            let mut cached_line = CachedLine {
                voices,
                height: height.into(),
                top: 0.0,
                content_height: 0.0,
                size: f64::from(lead.geometry.font_size),
                lane: f64::from(lead.geometry.text_width),
                x: f64::from(lead.geometry.x),
                right: lead.geometry.right,
            };
            cached_line.voices.shrink_to_fit();
            cached.push(cached_line);
        }
        let count = lines.len();
        let interludes = crate::interlude::slots(&lines);
        let footer = credits.and_then(|credits| {
            crate::credits::build(credits, settings, width, scale, offset, fonts)
        });
        let primary_size = settings
            .geometry(
                width,
                scale,
                lines[0].paint.as_ref().expect("validated paint"),
            )
            .font_size;
        let dot_glyph = (settings.style == crate::typography::Style::Spicy)
            .then(|| crate::interlude::DotGlyph::prepare(fonts, f64::from(primary_size)));
        Ok(Self {
            lines,
            cached,
            width,
            height,
            font_size: f64::from(primary_size),
            glyph_count: 0,
            missing_glyphs: 0,
            prefix,
            interludes,
            dot_glyph,
            diagnostics: vec![serde_json::Value::Null; count],
            fonts: Some(fonts.clone()),
            settings: Some(settings.clone()),
            scale,
            plain_preparations: 0,
            detailed_preparations: 0,
            footer,
            prepared_signature: None,
        })
    }

    /// Static preparation only when a row enters the visible/near-active window.
    /// Inactive rows retain a plain paragraph; only active + next2 build timed fragments.
    pub fn prepare(&mut self, time: f64) -> Result<(), Error> {
        if self.settings.is_none() {
            return Ok(());
        }
        // Overlap-safe window; long pauses prepare the previous package and the
        // upcoming lyric, which is where Skia's interlude row and dots live.
        let window = crate::window(&self.lines, time);
        let active = window.focus.max(0) as usize;
        let first = window.active().map_or(active, |(start, _)| start);
        let last = window.active().map_or(first, |(_, end)| end);
        let detail_end = (last + 2).min(self.lines.len() - 1);
        // Skia retains an outgoing voice's exact animation owner after its cell
        // was promoted (`NativeFastVoice`: retain until cell retirement), and
        // keeps it within its own interval. Keep the previous package detailed
        // for its AMLL bright/dark and spring release window; dropping the
        // reveal gradient on the first inactive frame made the fill tail snap
        // to flat grey instead of fading.
        let retention_ms = 1000.0;
        let mut detail_first = first;
        while detail_first > 0 && self.lines[detail_first - 1].background_end + retention_ms >= time
        {
            detail_first -= 1;
        }
        let signature = (active, detail_first, first.min(detail_end), detail_end);
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
            let detailed = i >= detail_first && i <= detail_end;
            if !self.cached[i].layout_ready() {
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
            } else if detailed && !self.cached[i].lead().detailed {
                self.detailed_preparations += 1;
                let line = &self.lines[i];
                for (index, voice) in self.cached[i].voices.iter_mut().enumerate() {
                    if voice.atoms.is_empty() {
                        voice.atoms = fragments(
                            voice.layout.as_ref().expect("prepared layout"),
                            &voice.words,
                        );
                    }
                    if voice.timed.is_none() {
                        voice.timed = line.voice(index).map(|source| {
                            crate::timed_scene::geometry(
                                voice.layout.as_ref().expect("prepared"),
                                &voice.words,
                                source,
                            )
                        });
                    }
                    voice.detailed = true;
                }
            }
            if !detailed {
                // Retain immutable paragraph geometry but no per-word slice processing.
                for voice in &mut self.cached[i].voices {
                    voice.detailed = false;
                }
            }
        }
        // Bound glyph/paragraph ownership while preserving measured row heights.
        // Cached track variants are bounded separately by the native owner.
        for i in 0..self.cached.len() {
            if !(detail_first..=detail_end).contains(&i) {
                for voice in &mut self.cached[i].voices {
                    voice.detailed = false;
                }
            }
            if i.abs_diff(active) > 32 && (i < start || i > end) && self.cached[i].layout_ready() {
                for voice in &mut self.cached[i].voices {
                    voice.clear_geometry();
                }
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

    /// Manual scrolling can leave the playback overscan entirely. Prepare only
    /// the visible destination rows, not every row between it and playback.
    pub(crate) fn prepare_viewport(&mut self, scroll: f64) -> Result<(), Error> {
        if self.settings.is_none() {
            return Ok(());
        }
        let visible = self.visible_rows(scroll);
        let mut changed = false;
        for i in visible.clone() {
            if !self.cached[i].layout_ready() {
                let mut prepared = Self::with_fonts_eager(
                    vec![self.lines[i].clone()],
                    self.width,
                    self.height,
                    self.scale,
                    self.settings.as_ref(),
                    self.fonts.as_mut().expect("lazy fonts"),
                    false,
                )?;
                self.glyph_count += prepared.glyph_count;
                self.missing_glyphs += prepared.missing_glyphs;
                self.cached[i] = prepared.cached.remove(0);
                self.diagnostics[i] = prepared.diagnostics.remove(0);
                self.plain_preparations += 1;
                changed = true;
            }
        }
        // Bound retained manual-scroll geometry while keeping playback's cache.
        let focus = self.prepared_signature.map_or(0, |s| s.0);
        for i in 0..self.cached.len() {
            if !visible.contains(&i) && i.abs_diff(focus) > 32 && self.cached[i].layout_ready() {
                for voice in &mut self.cached[i].voices {
                    voice.clear_geometry();
                }
                self.diagnostics[i] = serde_json::Value::Null;
            }
        }
        if changed {
            let mut offset = 0.0;
            for (i, cached) in self.cached.iter().enumerate() {
                self.prefix[i] = offset;
                offset += cached.height;
            }
            // Newly measured rows may change playback's overscan boundaries.
            self.prepared_signature = None;
        }
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
            if settings.is_some() && line.paint.is_none() {
                return Err("Style packet requires prepared voice metadata".into());
            }
            let boxes = row_voice_boxes(line, width, height, scale, settings, font_size);
            let mut voices = Vec::with_capacity(boxes.len());
            let mut voice_diagnostics = Vec::with_capacity(boxes.len());
            // Row content grows by each voice's own margin and padding box, so a
            // background voice is part of the measured line height used by
            // scrolling, the blur ramp and the protected band.
            let mut cursor = 0.0;
            for (index, voice_box) in boxes.iter().enumerate() {
                let geometry = Some(voice_box.geometry.clone());
                let size = voice_box.geometry.font_size;
                let lane = voice_box.geometry.text_width;
                let line_height = voice_box.geometry.line_height;
                let weight = voice_box.geometry.weight;
                let family = if settings.is_some() {
                    "'SF Pro Display', sans-serif"
                } else if cfg!(target_vendor = "apple") {
                    "sans-serif"
                } else {
                    "Noto Sans CJK KR"
                };
                let mut spacing = 0.0;
                let (text, words) =
                    if let (Some(settings), Some(voice)) = (settings, line.voice(index)) {
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
                        crate::typography::wrap(
                            voice,
                            settings.style,
                            f64::from(lane / scale),
                            |range| measure(&advances, range) / f64::from(scale),
                        )
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
                let translation = if let (Some(settings), Some(geometry), Some(text)) = (
                    settings,
                    geometry.as_ref(),
                    line.voice(index)
                        .and_then(|v| v.translation.as_deref())
                        .filter(|t| !t.is_empty()),
                ) {
                    let policy = crate::auxiliary::Policy::voice(
                        settings,
                        geometry,
                        scale,
                        voice_box.background,
                        voice_box.geometry.font_size,
                        voice_box.geometry.text_width,
                    );
                    let t = crate::auxiliary::Translation::prepare(
                        text,
                        &policy,
                        voice_box.geometry.right,
                        f64::from(voice_box.padding) + content_height,
                        fonts,
                        &mut layouts,
                    );
                    glyph_count += t.glyph_count;
                    missing_glyphs += t.missing_glyphs;
                    Some(t)
                } else {
                    None
                };
                let spicy = settings.is_some_and(|s| s.style == crate::typography::Style::Spicy);
                let timed = if detailed || spicy {
                    line.voice(index)
                        .map(|source| crate::timed_scene::geometry(&layout, &words, source))
                } else {
                    None
                };
                let idle = if spicy {
                    timed
                        .as_ref()
                        .zip(line.voice(index))
                        .map(|(timed, source)| {
                            crate::timed_scene::spicy_idle(timed, source, f64::from(voice_box.unit))
                        })
                } else {
                    None
                };
                let timed = if detailed { timed } else { None };
                let voice = CachedVoice {
                    white,
                    plain,
                    idle,
                    translation,
                    height: layout.height() as f64,
                    atoms,
                    words,
                    layout: Some(layout),
                    detailed,
                    timed,
                    size: f64::from(size),
                    lane: f64::from(lane),
                    right: geometry.as_ref().is_some_and(|g| g.right),
                    x: f64::from(voice_box.geometry.x),
                    offset: cursor + f64::from(voice_box.margin_top),
                    padding: f64::from(voice_box.padding),
                    alpha: f64::from(voice_box.alpha),
                    unit: f64::from(voice_box.unit),
                    background: voice_box.background,
                };
                cursor = voice.offset + voice.box_height();
                voice_diagnostics.push(serde_json::json!({"geometry":voice_box.geometry,"text":text,
                "voice_height":voice.height,"background":voice_box.background,"offset":voice.offset,
                "faces":faces,"line_count":voice.layout.as_ref().map_or(0usize, |l| l.len()),
                "translation":voice.translation.as_ref().map(|t| &t.diagnostics),
                "word_ranges":voice.words.iter().map(|w|vec![w.bytes.start,w.bytes.end]).collect::<Vec<_>>() }));
                voices.push(voice);
            }
            let lead_size = voices[0].size;
            let lead_lane = voices[0].lane;
            let lead_x = voices[0].x;
            let lead_right = voices[0].right;
            let (height, top, gap) = if let Some(settings) = settings {
                let row_padding = f64::from(boxes[0].geometry.row_padding);
                let min = if settings.style == crate::typography::Style::Spicy {
                    84.0
                } else {
                    72.0
                } * settings.font_scale
                    * scale;
                let height = (cursor + 2.0 * row_padding).max(f64::from(min));
                let top = if settings.style == crate::typography::Style::Spicy {
                    (height - cursor) / 2.0
                } else {
                    row_padding
                };
                (height, top, 0.0)
            } else {
                (cursor, 0.0, f64::from(font_size) * 0.7)
            };
            prefix.push(offset);
            offset += height + gap;
            let mut row = voice_diagnostics[0].clone();
            if let Some(fields) = row.as_object_mut() {
                fields.insert("height".into(), serde_json::json!(height));
                fields.insert("content_top".into(), serde_json::json!(top));
                fields.insert("content_height".into(), serde_json::json!(cursor));
                fields.insert("voices".into(), serde_json::Value::Array(voice_diagnostics));
            }
            diagnostics.push(row);
            cached.push(CachedLine {
                voices,
                height,
                top,
                content_height: cursor,
                size: lead_size,
                lane: lead_lane,
                x: lead_x,
                right: lead_right,
            });
        }
        if missing_glyphs > 0 {
            return Err(
                format!("{missing_glyphs} missing glyphs (tofu); install Noto Sans CJK").into(),
            );
        }
        let interludes = crate::interlude::slots(&lines);
        Ok(Self {
            lines,
            cached,
            width,
            height,
            font_size: font_size as f64,
            glyph_count,
            missing_glyphs,
            prefix,
            interludes,
            // Scratch row preparation does not own the interlude renderer.
            dot_glyph: None,
            diagnostics,
            fonts: None,
            settings: None,
            scale,
            plain_preparations: 0,
            detailed_preparations: 0,
            footer: None,
            prepared_signature: None,
        })
    }

    pub fn style(&self) -> Option<crate::typography::Style> {
        self.settings.as_ref().map(|s| s.style)
    }
    pub fn timed_ready(&self, index: usize) -> bool {
        self.cached.get(index).is_some_and(CachedLine::timed_ready)
    }
    pub fn geometry_ready(&self, index: usize) -> bool {
        self.cached.get(index).is_some_and(CachedLine::layout_ready)
    }

    /// Returns protected band in output pixels, including the entire next line.
    pub fn frame(&mut self, time: f64, scene: &mut Scene) -> (f32, f32) {
        self.frame_at(time, self.scroll_target(time), scene)
    }

    /// Skia native `scrollTo` anchor: AMLL lands at 8% of the list plus 8 pt,
    /// landscape Spicy at 32 pt, portrait Spicy directly below the top bar.
    /// The pre-ABI7 fixture path keeps its historical center anchor.
    pub(crate) fn scroll_anchor(&self) -> f64 {
        let scale = f64::from(self.scale);
        match self.settings.as_ref() {
            None => self.height as f64 * 0.37,
            Some(settings) if settings.style == crate::typography::Style::Amll => {
                self.height as f64 * 0.08 + 8.0 * scale
            }
            Some(settings) if settings.landscape => 32.0 * scale,
            Some(_) => 0.0,
        }
    }

    fn fit_scroll(&self, top: f64, bottom: f64) -> f64 {
        // `prefix` starts at zero and rendering adds `scroll_anchor`, so the
        // target for a row at the anchor is the row prefix itself.
        let padding = crate::ACTIVE_RANGE_BOTTOM_PADDING * f64::from(self.scale);
        let height = f64::from(self.height);
        if bottom - top <= height - self.scroll_anchor() - padding {
            top.max(0.0)
        } else {
            (bottom - height + padding).max(0.0)
        }
    }

    fn target_at(&self, window: &crate::Window, time: f64) -> Option<f64> {
        // Skia's `maxEndTimeByIndex[last]` gate: once the track is over the
        // list scrolls to the credits footer instead of holding the last row.
        let song_end = self
            .lines
            .iter()
            .map(|line| line.background_end)
            .fold(0.0, f64::max);
        if time >= song_end
            && let Some(target) = self.credits_scroll()
        {
            return Some(target);
        }
        let (start, end) = crate::auto_scroll_range(window)?;
        let last = self.lines.len() - 1;
        let start = crate::follow_index(&self.lines, start.min(last), time);
        let end = end.min(last).max(start);
        // The interlude slot is inside the upcoming row: its top stays put while
        // its content and every later row move down by the expanded height.
        let (interlude_row, extra) = self.interlude_shift(time);
        let shifted = |index: usize, own_slot: bool| {
            interlude_row.map_or(0.0, |row| {
                if index > row || (own_slot && index == row) {
                    extra
                } else {
                    0.0
                }
            })
        };
        Some(self.fit_scroll(
            self.prefix[start] + shifted(start, false),
            self.prefix[end] + self.cached[end].height + shifted(end, true),
        ))
    }

    /// Interlude whose break contains `time`, with the expanded slot height.
    pub(crate) fn interlude_at(&self, time: f64) -> Option<(usize, crate::interlude::Interlude)> {
        self.settings.as_ref()?;
        self.interludes.iter().enumerate().find_map(|(row, slot)| {
            slot.as_ref()
                .filter(|slot| time >= slot.start && time < slot.end)
                .map(|slot| (row, *slot))
        })
    }

    pub(crate) fn interlude_shift(&self, time: f64) -> (Option<usize>, f64) {
        let Some((row, slot)) = self.interlude_at(time) else {
            return (None, 0.0);
        };
        let extra = crate::interlude::slot_height(
            &slot,
            self.style() == Some(crate::typography::Style::Spicy),
            self.cached[row].size,
            f64::from(self.width),
            time,
        );
        (Some(row), extra)
    }

    pub fn scroll_target(&self, time: f64) -> f64 {
        if self.settings.is_none() {
            return self.prefix[focus(&self.lines, time)];
        }
        let window = crate::window(&self.lines, time);
        self.target_at(&window, time)
            .unwrap_or(self.prefix[window.focus.max(0) as usize])
    }

    /// Highest scroll offset Skia allows: the last row can reach the top
    /// anchor, and the credits footer can reach the bottom padding.
    pub fn max_scroll(&self) -> f64 {
        let last = self.lines.len().saturating_sub(1);
        let mut max = self.prefix[last].max(0.0);
        if let Some(footer) = &self.footer {
            let padding = crate::ACTIVE_RANGE_BOTTOM_PADDING * f64::from(self.scale);
            max = max.max(self.scroll_anchor() + footer.bottom - f64::from(self.height) + padding);
        }
        max
    }

    /// Skia footer target: the whole credits block ends at the viewport bottom
    /// minus the same 24 pt bottom padding used by fit-scroll.
    fn credits_scroll(&self) -> Option<f64> {
        let footer = self.footer.as_ref()?;
        let last = self.lines.len() - 1;
        let padding = crate::ACTIVE_RANGE_BOTTOM_PADDING * f64::from(self.scale);
        let target = self.scroll_anchor() + footer.bottom - f64::from(self.height) + padding;
        Some(target.max(self.prefix[last]).clamp(0.0, self.max_scroll()))
    }

    /// First row intersecting `scroll` (Skia `getFirstVisibleIndex`).
    fn first_visible(&self, scroll: f64) -> usize {
        self.prefix
            .partition_point(|top| *top <= scroll)
            .saturating_sub(1)
            .min(self.lines.len() - 1)
    }

    /// Rows that can be drawn near `scroll`, including the interlude overscan.
    pub fn visible_rows(&self, scroll: f64) -> std::ops::Range<usize> {
        let height = f64::from(self.height);
        let first = self
            .prefix
            .partition_point(|top| *top + 200.0 < scroll - height);
        let last = self
            .prefix
            .partition_point(|top| *top < scroll + height * 2.0)
            .max(first + 1)
            .min(self.lines.len());
        first.min(self.lines.len() - 1)..last
    }

    /// Per-frame follow command. `position` is the current visual offset, used
    /// for Skia's first-visible row, duration interval and interlude flag.
    pub fn scroll_command(&self, time: f64, position: f64) -> crate::motion::Command {
        let window = crate::window(&self.lines, time);
        let target = self
            .target_at(&window, time)
            .unwrap_or(self.prefix[window.focus.max(0) as usize]);
        let index = crate::auto_scroll_range(&window)
            .map(|(start, _)| start)
            .unwrap_or_else(|| window.focus.max(0) as usize)
            .min(self.lines.len() - 1);
        let index = crate::follow_index(&self.lines, index, time);
        let interval = if index > 0 {
            self.lines[index].start - self.lines[index - 1].start
        } else {
            800.0
        };
        crate::motion::Command {
            offset: target,
            interval,
            interlude: time > self.lines[index].end,
            first_visible: self.first_visible(position),
            index,
            visible: self.visible_rows(position),
            scale: f64::from(self.scale),
            style: self.style().unwrap_or(crate::typography::Style::Spicy),
        }
    }

    /// Line row under a logical surface point. Skia rows are full-width targets
    /// and the expanded interlude slot belongs to its row's press target.
    pub fn hit_test(&self, y: f64, scroll: f64, adjust: &[f64], time: f64) -> Option<usize> {
        let anchor = self.scroll_anchor();
        let (interlude_row, extra) = self.interlude_shift(time);
        for (index, cached) in self.cached.iter().enumerate() {
            let top = anchor + self.prefix[index] - scroll
                + adjust.get(index).copied().unwrap_or(0.0)
                + interlude_row.map_or(0.0, |row| if index > row { extra } else { 0.0 });
            let height = cached.height
                + interlude_row.map_or(0.0, |row| if index == row { extra } else { 0.0 });
            if y >= top && y < top + height {
                return Some(index);
            }
        }
        None
    }

    pub fn frame_at(&mut self, time: f64, scroll: f64, scene: &mut Scene) -> (f32, f32) {
        let old_target = self.scroll_target(time);
        self.prepare(time).expect("validated on-demand layout");
        let scroll = scroll + self.scroll_target(time) - old_target;
        self.frame_prepared(time, scroll, scene)
    }

    pub(crate) fn frame_prepared(&self, time: f64, scroll: f64, scene: &mut Scene) -> (f32, f32) {
        self.frame_prepared_adjusted(time, scroll, &[], scene)
    }

    /// `adjust` carries AMLL's per-row cascade residual; Skia translates each
    /// row relative to the shared viewport, so the row offset is additive.
    pub(crate) fn frame_prepared_adjusted(
        &self,
        time: f64,
        scroll: f64,
        adjust: &[f64],
        scene: &mut Scene,
    ) -> (f32, f32) {
        scene.reset();
        let window = crate::window(&self.lines, time);
        let active = window.active();
        let active_end = active.map_or(window.focus.max(0) as usize, |(_, end)| end);
        let scale = f64::from(self.scale);
        let anchor = self.scroll_anchor();
        let (interlude_row, extra) = self.interlude_shift(time);
        let position = |index: usize| {
            anchor + self.prefix[index] - scroll
                + adjust.get(index).copied().unwrap_or(0.0)
                + interlude_row.map_or(0.0, |row| if index >= row { extra } else { 0.0 })
        };
        for (i, cached) in self.cached.iter().enumerate() {
            let y = position(i);
            if y + cached.height < -40.0 || y > self.height as f64 + 40.0 {
                continue;
            }
            let bounds = Rect::new(-8.0, -8.0, self.width as f64, cached.height + 8.0);
            let singing = time >= self.lines[i].start && time < self.lines[i].end;
            let active_row = active.is_some_and(|(start, end)| i >= start && i <= end);
            let opacity = if active_row || singing {
                0.4
            } else if i == active_end + 1 {
                0.5
            } else {
                0.38
            };
            for voice in &cached.voices {
                let transform =
                    Affine::translate((voice.x, y + cached.top + voice.offset + voice.padding));
                scene.push_layer(
                    Fill::NonZero,
                    BlendMode::default(),
                    (opacity * voice.alpha) as f32,
                    transform,
                    &bounds,
                );
                scene.append(&voice.white, Some(transform));
                scene.pop_layer();
                if active_row || singing {
                    for (atom, fragments) in voice.words.iter().zip(&voice.atoms) {
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
                            scene.append(&voice.white, Some(transform));
                            scene.pop_layer();
                        }
                    }
                }
            }
        }
        let first = active.map_or(window.focus.max(0) as usize, |(start, _)| start);
        let last = active.map_or(first, |(_, end)| end);
        let next = (last.max(first) + 1).min(self.lines.len() - 1);
        let mut band_top = position(first) - 10.0 * scale;
        let mut band_bottom = position(next) + self.cached[next].height + 10.0 * scale;
        if let Some(footer) = &self.footer {
            let y = anchor + footer.text_top - scroll + interlude_row.map_or(0.0, |_| extra);
            if let Some((top, bottom)) =
                footer.draw(scene, y, self.width, f64::from(self.height), scale)
            {
                // Skia ignores attribution when deciding whether to blur
                // (`hasAttribution`), so keep the footer outside the band.
                band_top = band_top.min(top);
                band_bottom = band_bottom.max(bottom);
            }
        }
        (band_top as f32, band_bottom as f32)
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
        Self::key_with_credits(track_id, lines, settings, width, height, scale, None)
    }
    /// Credits change the measured content, so they participate in the key.
    pub fn key_with_credits(
        track_id: &str,
        lines: &[Line],
        settings: &crate::typography::Settings,
        width: u32,
        height: u32,
        scale: f32,
        credits: Option<&crate::live::Credits>,
    ) -> Result<String, serde_json::Error> {
        use sha2::Digest;
        let bytes = serde_json::to_vec(&(
            track_id,
            lines,
            settings,
            width,
            height,
            scale,
            credits,
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
                    background_end: start + 1000.0,
                    atoms: vec![crate::Atom {
                        bytes: 0..text.len(),
                        start,
                        end: start + 1000.0,
                    }],
                    paint: Some(PaintVoice {
                        translation: None,
                        start,
                        end: start + 1000.0,
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
                    backgrounds: Vec::new(),
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
        assert!(track.cached[0].lead().detailed && track.cached[2].lead().detailed);
        assert!(!track.cached[3].lead().detailed && track.cached[3].lead().atoms.is_empty());
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
        assert!(track.cached[0].lead().layout.is_none());
        assert!(!track.cached[0].lead().detailed);
        assert!(track.cached[50].lead().detailed);
        assert!(
            track
                .cached
                .iter()
                .filter(|row| row.voices.iter().any(|voice| voice.detailed))
                .count()
                <= 4 // current/next rows plus the one-second outgoing owner
        );
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
    #[test]
    fn prepared_future_rows_start_at_their_placeholder_alpha() {
        use crate::appearance::AppearanceState;
        let lines = source(6);
        let mut fonts = fonts();
        for (style, bright, dark, outer) in
            [(Style::Amll, 0.2, 0.2, 1.0), (Style::Spicy, 1.0, 0.4, 0.51)]
        {
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut track =
                TrackScene::with_fonts(lines.clone(), 390, 640, 1.0, Some(&settings), &mut fonts)
                    .unwrap();
            track.prepare(500.0).unwrap();
            assert!(track.timed_ready(1), "future row must be shape-ready");
            let mut state = AppearanceState::default();
            state.prepare(&track, 500.0, 1000.0);
            let row = state.row(1).unwrap();
            // The raw placeholder painted this alpha; the first prepared frame
            // must start there instead of at active white.
            assert!((row.bright - bright).abs() < 1e-12, "{style:?} bright");
            assert!((row.dark - dark).abs() < 1e-12, "{style:?} dark");
            assert!((row.outer - outer).abs() < 1e-12, "{style:?} outer");
            assert!(!row.active);
        }
    }

    #[test]
    fn both_styles_prime_the_upcoming_line_before_it_starts() {
        use crate::appearance::{AppearanceState, Effect};
        for style in [Style::Spicy, Style::Amll] {
            let mut lines = source(2);
            let shift = 4000.0;
            let line = &mut lines[1];
            line.start += shift;
            line.end += shift;
            line.background_end += shift;
            for atom in &mut line.atoms {
                atom.start += shift;
                atom.end += shift;
            }
            if let Some(paint) = &mut line.paint {
                paint.start += shift;
                paint.end += shift;
                for word in &mut paint.words {
                    word.start += shift;
                    word.end += shift;
                }
            }
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut fonts = fonts();
            let mut track =
                TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
            let mut state = AppearanceState::default();
            // During the interlude itself the next row keeps its dim future alpha.
            track.prepare(1500.0).unwrap();
            state.prepare(&track, 1500.0, 1000.0);
            state.advance(&track, 1500.0, 1000.0, true, Effect::Motion);
            assert!(
                (state.row(1).unwrap().outer - if style == Style::Spicy { 0.51 } else { 1.0 })
                    .abs()
                    < 1e-9
            );
            // The visual window promotes it for the last 500 ms of the gap, giving
            // Skia's 200 ms opacity timing time to reach full strength.
            track.prepare(4600.0).unwrap();
            state.prepare(&track, 4600.0, 3000.0);
            state.advance(&track, 4600.0, 3000.0, true, Effect::Motion);
            for step in 1..=120 {
                state.advance(
                    &track,
                    4600.0,
                    3000.0 + step as f64 * 40.0,
                    true,
                    Effect::Motion,
                );
            }
            let row = state.row(1).unwrap();
            if style == Style::Spicy {
                assert_eq!(row.outer, 1.0);
            } else {
                assert_eq!(row.outer, 0.85);
                assert_eq!(row.scale.p, 1.0);
                assert!((row.bright - 1.0).abs() < 0.001);
                assert!((row.dark - 0.4).abs() < 0.001);
            }
            assert!(!row.active);
        }
    }

    #[test]
    fn outgoing_line_keeps_its_timed_completion_owner() {
        use crate::appearance::{AppearanceState, Effect};
        let mut lines = source(6);
        for line in &mut lines {
            for word in &mut line.paint.as_mut().unwrap().words {
                word.appearance = Some(crate::typography::WordAppearance {
                    emphasized: false,
                    origin: 0.5,
                    rtl: false,
                    last: true,
                    emphasis: None,
                });
            }
        }
        let mut fonts = fonts();
        for style in [Style::Amll, Style::Spicy] {
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut track =
                TrackScene::with_fonts(lines.clone(), 390, 640, 1.0, Some(&settings), &mut fonts)
                    .unwrap();
            let end = track.lines[0].end;
            track.prepare(end).unwrap();
            assert!(track.timed_ready(0));
            // The next row is already focused, but the outgoing row's timed
            // reveal must survive so bright/dark can fade instead of snapping.
            track.prepare(end + 1.0).unwrap();
            assert!(
                track.timed_ready(0),
                "{style:?} outgoing row lost its timed completion owner"
            );
            if style == Style::Amll {
                let mut state = AppearanceState::default();
                let mut scene = Scene::new();
                // Establish the active white state before the boundary; a row
                // first prepared after its line ended starts at the inactive
                // placeholder alpha by design.
                state.prepare(&track, end - 100.0, 900.0);
                state.advance(&track, end - 100.0, 900.0, true, Effect::Glow);
                let before = state.row(0).unwrap().bright;
                assert!(before > 0.9, "active AMLL row must be white");
                for step in 0..=4 {
                    let wall = 1000.0 + step as f64 * 16.0;
                    state.advance(&track, end + step as f64 * 16.0, wall, true, Effect::Glow);
                }
                let after = state.row(0).unwrap().bright;
                assert!(before > after, "AMLL completion colour must fade");
                track.frame_appearance(
                    end + 64.0,
                    track.scroll_target(end + 64.0),
                    &[],
                    &state,
                    &mut scene,
                    Effect::Glow,
                );
                assert!(state.row(0).unwrap().bright < 1.0);
            }
        }
    }

    #[test]
    fn credits_footer_extends_content_and_owns_the_final_scroll() {
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let credits = crate::live::Credits {
            songwriters: vec!["A".into(), "B".into()],
            attribution: Some(crate::live::Attribution {
                provider: Some("Spicy".into()),
                community: true,
                maker: Some("maker".into()),
                uploader: Some("uploader".into()),
            }),
        };
        let mut fonts = fonts();
        let mut track = TrackScene::with_fonts_credits(
            source(6),
            390,
            640,
            1.0,
            Some(&settings),
            Some(&credits),
            &mut fonts,
        )
        .unwrap();
        assert!(track.footer.is_some());
        let end = track.lines.last().unwrap().background_end;
        assert!((track.scroll_target(end + 1000.0) - track.max_scroll()).abs() < 1e-9);
        assert!(track.max_scroll() >= track.prefix[track.lines.len() - 1]);
        let mut scene = Scene::new();
        let (_, bottom) = track.frame(end + 1000.0, &mut scene);
        assert!(bottom > 0.0);
        track.frame(end + 1000.0, &mut scene);
        let allocations = crate::allocation_probe::measure(|| {
            for _ in 0..120 {
                track.frame(end + 1000.0, &mut scene);
            }
        });
        assert_eq!(allocations, 0, "steady credits frames must reuse buffers");
    }

    #[test]
    fn manual_scroll_prepares_distant_rows_and_reuses_them() {
        let mut fonts = fonts();
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(source(200), 390, 640, 1.0, Some(&settings), &mut fonts)
                .unwrap();
        track.prepare(500.0).unwrap();
        assert!(!track.geometry_ready(150));
        let scroll = track.prefix[150];
        track.prepare_viewport(scroll).unwrap();
        assert!(track.geometry_ready(150));
        track.prepare_viewport(track.prefix[150]).unwrap();
        let count = track.plain_preparations;
        track.prepare_viewport(track.prefix[150]).unwrap();
        assert_eq!(track.plain_preparations, count);
        assert!(track.cached.iter().filter(|row| row.layout_ready()).count() < 60);
    }

    fn long_gap_lines() -> Vec<Line> {
        let mut lines = source(4);
        for (index, line) in lines.iter_mut().enumerate() {
            let start = [0.0, 1000.0, 6000.0, 7000.0][index];
            let end = start + 1000.0;
            line.start = start;
            line.end = end;
            line.background_end = end;
            for atom in &mut line.atoms {
                atom.start = start;
                atom.end = end;
            }
            if let Some(voice) = line.paint.as_mut() {
                for word in &mut voice.words {
                    word.start = start;
                    word.end = end;
                }
            }
        }
        lines
    }
    #[test]
    fn interlude_slot_shifts_rows_and_owns_the_expanded_press_target() {
        use crate::appearance::{AppearanceState, Effect};
        let lines = long_gap_lines();
        let mut fonts = fonts();
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
        track.prepare(2600.0).unwrap();
        let (row, slot) = track.interlude_at(2600.0).unwrap();
        assert_eq!((row, slot.start, slot.end), (2, 2000.0, 6000.0));
        assert_eq!(track.interlude_shift(1999.0), (None, 0.0));
        let full = track.cached[2].size * 1.3 * 0.65;
        assert!((track.interlude_shift(2500.0).1 - full).abs() < 1e-9);
        assert!(track.interlude_shift(2050.0).1 < full);
        assert_eq!(track.interlude_shift(6000.0), (None, 0.0));
        let target = track.scroll_target(2600.0);
        assert!((target - track.prefix[2]).abs() < 1e-9);
        let anchor = track.scroll_anchor();
        let top = anchor + track.prefix[2] - target;
        // The expanded slot belongs to row 2; the row text starts one slot lower.
        assert_eq!(track.hit_test(top + 1.0, target, &[], 2600.0), Some(2));
        assert_eq!(
            track.hit_test(
                top + track.interlude_shift(2600.0).1 + track.cached[2].height + 2.0,
                target,
                &[],
                2600.0,
            ),
            Some(3)
        );
        let mut state = AppearanceState::default();
        state.prepare(&track, 2600.0, 1000.0);
        state.advance(&track, 2600.0, 1000.0, false, Effect::Motion);
        state.advance(&track, 2616.0, 1016.0, false, Effect::Motion);
        let dot = track.dot_glyph.as_ref().unwrap();
        // Bundled SF Pro Display Bold: bullet advance 994/2048 em;
        // ink bounds (141,210)-(854,923). Skia uses this glyph at 1.3x.
        assert!((dot.width - f64::from(dot.size) * 994.0 / 2048.0).abs() < 0.02);
        assert!((dot.ink.width() - f64::from(dot.size) * 713.0 / 2048.0).abs() < 0.02);
        assert_eq!(
            fonts.describe(&dot.font).sha256,
            crate::typography::BUNDLED_FONT_HASHES[1]
        );
        assert_eq!(state.interlude.row(), Some(2));
        assert!(state.interlude.dot(0).0 >= 0.75);
        let mut scene = Scene::new();
        let band = track.frame_appearance(2600.0, target, &[], &state, &mut scene, Effect::Motion);
        assert!(band.1 > band.0);
        let allocations = crate::allocation_probe::measure(|| {
            for i in 0..120 {
                let time = 2600.0 + i as f64;
                let scroll = track.scroll_target(time);
                state.advance(
                    &track,
                    time,
                    2000.0 + i as f64 * 8.333,
                    false,
                    Effect::Motion,
                );
                track.frame_appearance(time, scroll, &[], &state, &mut scene, Effect::Motion);
            }
        });
        assert_eq!(allocations, 0, "interlude dots must reuse scene buffers");
    }
    #[test]
    #[ignore = "GPU real-gap glyph transition; requires a GPU adapter"]
    fn spicy_gap_priming_to_active_preserves_word_and_letter_geometry() {
        use crate::appearance::{AppearanceState, Effect};
        let mut fonts = fonts();
        for emphasized in [false, true] {
            let mut lines = long_gap_lines();
            for line in &mut lines {
                for voice in line.paint.iter_mut() {
                    voice.start = line.start;
                    voice.end = line.end;
                    for word in &mut voice.words {
                        word.appearance = Some(crate::typography::WordAppearance {
                            emphasized,
                            origin: 0.5,
                            rtl: false,
                            last: true,
                            emphasis: None,
                        });
                    }
                }
            }
            let settings = Settings {
                style: Style::Spicy,
                font_scale: 1.0,
                landscape: false,
            };
            let mut track =
                TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
            track.prepare(5500.0).unwrap();
            let mut state = AppearanceState::default();
            state.prepare(&track, 5500.0, 5500.0);
            for i in 0..32 {
                state.advance(
                    &track,
                    5500.0 + i as f64 * 16.0,
                    5500.0 + i as f64 * 16.0,
                    true,
                    Effect::Glow,
                );
            }
            assert_eq!(state.row(2).unwrap().outer, 1.0);
            assert!(!state.row(2).unwrap().active);
            let mut scene = Scene::new();
            let scroll = track.scroll_target(5999.0);
            let mut gpu = pollster::block_on(crate::gpu::Gpu::new(390, 640)).unwrap();
            let band =
                track.frame_appearance(5999.0, scroll, &[], &state, &mut scene, Effect::Glow);
            gpu.render_appearance(&scene, band, true, true).unwrap();
            let primed = gpu.read_pixels().unwrap();
            state.advance(&track, 6000.0, 6012.0, true, Effect::Glow);
            let band =
                track.frame_appearance(6000.0, scroll, &[], &state, &mut scene, Effect::Glow);
            gpu.render_appearance(&scene, band, true, true).unwrap();
            let active = gpu.read_pixels().unwrap();
            let delta = primed
                .iter()
                .zip(active)
                .map(|(a, b)| a.abs_diff(b))
                .max()
                .unwrap();
            // Layer alpha and the active gradient quantize at different
            // RGBA8 stages; tolerate two levels, not a geometry change.
            assert!(
                delta <= 2,
                "emphasized={emphasized}: max pixel delta {delta}"
            );
        }
    }

    #[test]
    #[ignore = "GPU interlude draw regression; requires a GPU adapter"]
    fn both_interlude_styles_render_entry_breathing_and_exit() {
        use crate::appearance::{AppearanceState, Effect};
        let mut fonts = fonts();
        for style in [Style::Amll, Style::Spicy] {
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut track = TrackScene::with_fonts(
                long_gap_lines(),
                390,
                640,
                1.0,
                Some(&settings),
                &mut fonts,
            )
            .unwrap();
            let mut gpu = pollster::block_on(crate::gpu::Gpu::new(390, 640)).unwrap();
            let mut scene = Scene::new();
            let mut state = AppearanceState::default();
            for time in [
                2000.0, 2150.0, 2600.0, 5499.0, 5500.0, 5560.0, 5640.0, 5900.0,
            ] {
                track.prepare(time).unwrap();
                state.prepare(&track, time, time);
                state.advance(&track, time, time, true, Effect::Glow);
                let scroll = track.scroll_target(time);
                let band =
                    track.frame_appearance(time, scroll, &[], &state, &mut scene, Effect::Glow);
                gpu.render_appearance(&scene, band, true, true).unwrap();
                let pixels = gpu.read_pixels().unwrap();
                assert!(
                    pixels.chunks_exact(4).any(|p| p[3] > 0),
                    "{style:?} at {time}"
                );
                if time == 5500.0 {
                    let top =
                        track.scroll_anchor() + track.prefix[2] + track.cached[2].top - scroll;
                    assert!(
                        f64::from(band.0) <= top - 31.0,
                        "priming must not blur the dot group"
                    );
                }
            }
        }
    }

    #[test]
    fn amll_interlude_slot_uses_full_width_and_keeps_breathing_dots_in_budget() {
        use crate::appearance::{AppearanceState, Effect};
        let lines = long_gap_lines();
        let mut fonts = fonts();
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
        track.prepare(2600.0).unwrap();
        let (row, _slot) = track.interlude_at(2600.0).unwrap();
        assert_eq!(row, 2);
        let full = track.cached[2].size * 1.3 + 390.0 * 0.05;
        assert!((track.interlude_shift(2500.0).1 - full).abs() < 1e-9);
        assert_eq!(track.interlude_shift(6500.0), (None, 0.0));
        let mut state = AppearanceState::default();
        state.prepare(&track, 2600.0, 1000.0);
        state.advance(&track, 2600.0, 1000.0, false, Effect::Motion);
        let mut scene = Scene::new();
        let target = track.scroll_target(2600.0);
        assert!((target - track.prefix[2]).abs() < 1e-9);
        let band = track.frame_appearance(2600.0, target, &[], &state, &mut scene, Effect::Motion);
        assert!(band.1 > band.0);
        let allocations = crate::allocation_probe::measure(|| {
            for i in 0..120 {
                let time = 2600.0 + i as f64;
                state.advance(
                    &track,
                    time,
                    2000.0 + i as f64 * 8.333,
                    false,
                    Effect::Motion,
                );
                track.frame_appearance(time, target, &[], &state, &mut scene, Effect::Motion);
            }
        });
        assert_eq!(allocations, 0, "amll interlude must reuse scene buffers");
    }
}
