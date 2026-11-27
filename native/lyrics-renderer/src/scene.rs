//! Shape whole lines once. Frames reuse encoded white glyph scenes and byte-range clips.
use crate::{Line, progress};
use parley::{
    Alignment, AlignmentOptions, FontFamily, FontWeight, LayoutContext, LineHeight,
    PositionedLayoutItem, StyleProperty,
};
use std::ops::Range;
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
    lines: Vec<Line>,
    pub(crate) cached: Vec<CachedLine>,
    resident: std::collections::BTreeSet<usize>,
    cues: crate::scheduling::VisualCues,
    pub width: u32,
    pub height: u32,
    pub font_size: f64,
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub glyph_count: usize,
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub missing_glyphs: usize,
    prefix: RowOffsets,
    interludes: Vec<(usize, crate::interlude::Interlude)>,
    timing: TimingIndex,
    pub(crate) dot_glyph: Option<crate::interlude::DotGlyph>,
    /// Last explicitly requested receipts. Unprepared or evicted rows are null.
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub diagnostics: Vec<serde_json::Value>,
    #[cfg(any(test, feature = "dev-render-metrics"))]
    diagnostics_json: Option<Vec<u8>>,
    fonts: Option<crate::typography::Fonts>,
    settings: Option<crate::typography::Settings>,
    pub(crate) scale: f32,
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub plain_preparations: usize,
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub detailed_preparations: usize,
    pub(crate) footer: Option<crate::credits::Footer>,
    prepared_signature: Option<PreparationKey>,
    return_timing_cache: Option<(usize, ReturnTiming)>,
    #[cfg(test)]
    return_timing_misses: usize,
    manual_anchor: Option<ManualAnchor>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FrameWork {
    height_updates: usize,
    geometry_steps: usize,
    timing_steps: usize,
    preparation_rows: usize,
    retention_rows: usize,
    drawing_rows: usize,
    pub(crate) appearance_rows: usize,
    pub(crate) cascade_rows: usize,
    schedule_rows: usize,
}

#[cfg(test)]
thread_local! {
    static FRAME_WORK: std::cell::Cell<FrameWork> =
        std::cell::Cell::new(FrameWork::default());
}

#[cfg(test)]
pub(crate) fn count_frame_work(record: impl FnOnce(&mut FrameWork)) {
    FRAME_WORK.with(|cell| {
        let mut work = cell.get();
        record(&mut work);
        cell.set(work);
    });
}

/// Fenwick tree of measured or estimated row heights. Row starts are
/// exclusive sums. A measurement updates only the ancestors of its row.
#[derive(Clone, Debug, PartialEq)]
struct RowOffsets(Vec<f64>, f64);

impl RowOffsets {
    fn new(rows: &[CachedLine], gap: f64) -> Self {
        let mut tree = vec![0.0; rows.len() + 1];
        for (row, cached) in rows.iter().enumerate() {
            let i = row + 1;
            tree[i] += cached.height + gap;
            let parent = i + (i & i.wrapping_neg());
            if parent < tree.len() {
                tree[parent] += tree[i];
            }
        }
        Self(tree, gap)
    }

    fn add(&mut self, row: usize, delta: f64) {
        #[cfg(test)]
        count_frame_work(|work| work.height_updates += 1);
        let mut i = row + 1;
        while i < self.0.len() {
            #[cfg(test)]
            count_frame_work(|work| work.geometry_steps += 1);
            self.0[i] += delta;
            i += i & i.wrapping_neg();
        }
    }

    fn top(&self, row: usize) -> f64 {
        if row == 0 {
            return 0.0;
        }
        #[cfg(test)]
        count_frame_work(|work| work.geometry_steps += 1);
        // Same addition order as the tree search at an exact row boundary.
        self.top(row & (row - 1)) + self.0[row]
    }

    /// Count matching row starts by descending the tree in one pass.
    fn partition_point(&self, matches: impl Fn(f64) -> bool) -> usize {
        let count = self.0.len() - 1;
        if count == 0 || !matches(0.0) {
            return 0;
        }
        let mut bit = 1 << count.ilog2();
        let mut row = 0;
        let mut top = 0.0;
        while bit > 0 {
            #[cfg(test)]
            count_frame_work(|work| work.geometry_steps += 1);
            let next = row + bit;
            if next < count && matches(top + self.0[next]) {
                row = next;
                top += self.0[next];
            }
            bit >>= 1;
        }
        row + 1
    }
}

#[derive(Clone, Copy)]
struct TimingFacts {
    window: crate::Window,
    key: PreparationKey,
    previous: i32,
}

/// Source-order facts change only at line, gap, and retention boundaries.
/// Sweep once at layout creation so playback, appearance, and drawing share
/// the same indexed window even for out-of-order and overlapping packages.
struct TimingIndex {
    boundaries: Vec<f64>,
    facts: Vec<TimingFacts>,
    song_end: f64,
}

impl TimingIndex {
    fn new(lines: &[Line]) -> Self {
        use std::collections::BTreeSet;

        let mut starts: Vec<_> = (0..lines.len()).collect();
        let mut ends = starts.clone();
        starts.sort_by(|&a, &b| lines[a].start.total_cmp(&lines[b].start));
        ends.sort_by(|&a, &b| lines[a].background_end.total_cmp(&lines[b].background_end));
        let mut boundaries = Vec::with_capacity(4 * lines.len());
        let mut song_end: f64 = 0.0;
        for &row in &starts {
            let line = &lines[row];
            boundaries.extend([
                line.start,
                line.background_end,
                (line.background_end + 1000.0).next_up(),
            ]);
            let gap = line.start - song_end;
            if gap >= crate::LONG_PAUSE_THRESHOLD_MS {
                let pause = (gap - crate::PAUSE_DOTS_EARLY_EXIT_MS).max(1.0);
                boundaries.push(song_end + pause);
            }
            song_end = song_end.max(line.background_end);
        }
        boundaries.sort_unstable_by(f64::total_cmp);
        boundaries.dedup();

        let mut facts = Vec::with_capacity(boundaries.len() + 1);
        let mut active = BTreeSet::new();
        let mut expired = BTreeSet::new();
        let (mut start, mut end, mut expire) = (0, 0, 0);
        let mut previous = -1;
        let mut covered_end: f64 = 0.0;
        for time in std::iter::once(f64::NEG_INFINITY).chain(boundaries.iter().copied()) {
            while let Some(&row) = starts.get(start).filter(|&&row| lines[row].start <= time) {
                let line = &lines[row];
                previous = previous.max(row as i32);
                covered_end = covered_end.max(line.background_end);
                if line.background_end > time {
                    active.insert(row);
                }
                start += 1;
            }
            while let Some(&row) = ends
                .get(end)
                .filter(|&&row| lines[row].background_end <= time)
            {
                active.remove(&row);
                end += 1;
            }
            while let Some(&row) = ends
                .get(expire)
                .filter(|&&row| lines[row].background_end + 1000.0 < time)
            {
                expired.insert(row);
                expire += 1;
            }

            let window = if let (Some(&first), Some(&last)) = (active.first(), active.last()) {
                crate::Window {
                    active_start: first as i32,
                    active_end: last as i32,
                    focus: first as i32,
                    ..crate::Window::default()
                }
            } else {
                let next = starts.get(start).map(|&row| (row, lines[row].start));
                crate::window_without_active(previous, next, covered_end, time)
            };
            let focus = window.focus.max(0) as usize;
            let (first, last) = window.active().unwrap_or((focus, focus));
            let detail_first = expired.range(..first).next_back().map_or(0, |row| row + 1);
            let detail_end = (last + 2).min(lines.len().saturating_sub(1));
            facts.push(TimingFacts {
                window,
                key: (focus, detail_first, first.min(detail_end), detail_end),
                previous,
            });
        }
        Self {
            boundaries,
            facts,
            song_end,
        }
    }

    fn boundary(&self, time: f64) -> usize {
        self.boundaries.partition_point(|cue| {
            #[cfg(test)]
            count_frame_work(|work| work.timing_steps += 1);
            *cue <= time
        })
    }

    fn contains(&self, boundary: usize, time: f64) -> bool {
        (boundary == 0 || time >= self.boundaries[boundary - 1])
            && self.boundaries.get(boundary).is_none_or(|end| time < *end)
    }

    fn at(&self, time: f64) -> TimingFacts {
        self.facts[self.boundary(time)]
    }
}

pub(crate) type PreparationKey = (usize, usize, usize, usize);
type InterludeSlot = Option<(usize, crate::interlude::Interlude)>;

#[derive(Clone, Copy, Debug)]
enum TargetRows {
    Row(usize),
    Lyrics(usize, usize),
    Credits,
}

/// A target's timing identity survives measurements in the prefix table.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ReturnTarget {
    rows: TargetRows,
    slot: InterludeSlot,
    pub(crate) time: f64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ReturnTiming {
    pub key: PreparationKey,
    pub target: ReturnTarget,
}

#[derive(Clone, Copy)]
struct ManualAnchor {
    row: usize,
    fraction: f64,
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
    shape_with_wrap(
        text,
        fonts,
        layouts,
        size,
        line_height,
        weight,
        family,
        words,
        spacing,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn shape_with_wrap(
    text: &str,
    fonts: &mut parley::FontContext,
    layouts: &mut LayoutContext<()>,
    size: f32,
    line_height: f32,
    weight: f32,
    family: &str,
    words: &[crate::typography::WordRange],
    spacing: f32,
    wrap_anywhere: bool,
) -> parley::Layout<()> {
    #[cfg(target_os = "android")]
    let family = crate::android_fonts::family_stack(fonts, family);
    #[cfg(target_os = "android")]
    let family = family.as_str();
    let mut builder = layouts.ranged_builder(fonts, text, 1.0, true);
    builder.push_default(StyleProperty::FontFamily(FontFamily::Source(family.into())));
    builder.push_default(StyleProperty::FontSize(size));
    builder.push_default(StyleProperty::FontWeight(FontWeight::new(weight)));
    builder.push_default(StyleProperty::LineHeight(LineHeight::Absolute(line_height)));
    if wrap_anywhere {
        builder.push_default(StyleProperty::OverflowWrap(parley::OverflowWrap::Anywhere));
    }
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
    /// prepared content (scroll extent and auto-scroll target), so
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
            let mut track = Self::with_fonts_eager(
                lines,
                width,
                height,
                scale,
                None,
                fonts,
                true,
                #[cfg(any(test, feature = "dev-render-metrics"))]
                false,
            )?;
            track.fonts = Some(fonts.clone());
            track.cues = crate::scheduling::VisualCues::new(&track.lines);
            return Ok(track);
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
        #[cfg(any(test, feature = "dev-render-metrics"))]
        let diagnostics = vec![serde_json::Value::Null; lines.len()];
        let cues = crate::scheduling::VisualCues::new(&lines);
        let interludes = crate::interlude::slots(&lines)
            .into_iter()
            .enumerate()
            .filter_map(|(row, slot)| slot.map(|slot| (row, slot)))
            .collect();
        let footer = credits
            .and_then(|credits| crate::credits::build(credits, settings, width, scale, fonts));
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
            timing: TimingIndex::new(&lines),
            lines,
            prefix: RowOffsets::new(&cached, 0.0),
            cached,
            resident: std::collections::BTreeSet::new(),
            cues,
            width,
            height,
            font_size: f64::from(primary_size),
            #[cfg(any(test, feature = "dev-render-metrics"))]
            glyph_count: 0,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            missing_glyphs: 0,
            interludes,
            dot_glyph,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            diagnostics,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            diagnostics_json: None,
            fonts: Some(fonts.clone()),
            settings: Some(settings.clone()),
            scale,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            plain_preparations: 0,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            detailed_preparations: 0,
            footer,
            prepared_signature: None,
            return_timing_cache: None,
            #[cfg(test)]
            return_timing_misses: 0,
            manual_anchor: None,
        })
    }

    /// Immutable key for the geometry/retention window. Acquisition can test
    /// freshness without shaping, promoting rows, or advancing animation.
    pub(crate) fn preparation_key(&self, time: f64) -> PreparationKey {
        self.timing.at(time).key
    }

    pub(crate) fn window(&self, time: f64) -> crate::Window {
        let mut window = self.timing.at(time).window;
        if window.long_pause {
            window.pause_progress =
                ((time - window.pause_start) / window.pause_duration).clamp(0.0, 1.0);
        }
        window
    }

    fn playback_rows(&self, first: usize, detail_end: usize) -> std::ops::Range<usize> {
        let viewport = f64::from(self.height);
        // The two following rows are prepared for appearance, but must not
        // move the playback band off a short active range above tall rows.
        let last_active = detail_end.saturating_sub(2).max(first);
        let target_band = self.first_visible(self.row_top(last_active) - viewport * 2.0);
        let mut start = first.max(target_band);
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
        start..end + 1
    }

    /// Static preparation only when a row enters the visible/near-active window.
    /// Inactive rows retain a plain paragraph; only active + next2 build timed fragments.
    pub fn prepare(&mut self, time: f64) -> Result<(), Error> {
        if self.settings.is_none() {
            return Ok(());
        }
        self.prepare_playback(self.preparation_key(time), &[])
    }

    fn prepare_playback(
        &mut self,
        signature: PreparationKey,
        protected: &[Range<usize>],
    ) -> Result<(), Error> {
        let (active, detail_first, first, detail_end) = signature;
        if self.prepared_signature == Some(signature) {
            return Ok(());
        }
        let playback = self.playback_rows(first, detail_end);
        for i in playback.clone() {
            #[cfg(test)]
            count_frame_work(|work| work.preparation_rows += 1);
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
                    #[cfg(any(test, feature = "dev-render-metrics"))]
                    false,
                )?;
                let measured = prepared.cached.remove(0);
                if measured.height != self.cached[i].height {
                    self.prefix.add(i, measured.height - self.cached[i].height);
                }
                self.cached[i] = measured;
                self.resident.insert(i);
                #[cfg(any(test, feature = "dev-render-metrics"))]
                {
                    self.glyph_count += prepared.glyph_count;
                    self.missing_glyphs += prepared.missing_glyphs;
                    self.diagnostics[i] = prepared.diagnostics.remove(0);
                    self.diagnostics_json = None;
                    self.plain_preparations += 1;
                    self.detailed_preparations += usize::from(detailed);
                }
            } else if detailed && !self.cached[i].lead().detailed {
                #[cfg(any(test, feature = "dev-render-metrics"))]
                {
                    self.detailed_preparations += 1;
                }
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
        self.resident.retain(|&i| {
            #[cfg(test)]
            count_frame_work(|work| work.retention_rows += 1);
            let voices = &mut self.cached[i].voices;
            if !(detail_first..=detail_end).contains(&i) {
                for voice in &mut *voices {
                    voice.detailed = false;
                }
            }
            let keep = i.abs_diff(active) <= 32
                || playback.contains(&i)
                || protected.iter().any(|rows| rows.contains(&i));
            if !keep {
                for voice in voices {
                    voice.clear_geometry();
                }
                #[cfg(any(test, feature = "dev-render-metrics"))]
                {
                    self.diagnostics[i] = serde_json::Value::Null;
                    self.diagnostics_json = None;
                }
            }
            keep
        });
        self.prepared_signature = Some(signature);
        Ok(())
    }

    /// Manual scrolling can leave the playback overscan entirely. Prepare only
    /// the visible destination rows, not every row between it and playback.
    pub(crate) fn prepare_viewport(&mut self, scroll: f64) -> Result<(), Error> {
        self.prepare_viewport_rows(self.visible_rows(scroll), &[])
    }

    fn prepare_viewport_rows(
        &mut self,
        visible: std::ops::Range<usize>,
        protected: &[std::ops::Range<usize>],
    ) -> Result<(), Error> {
        if self.settings.is_none() {
            return Ok(());
        }
        let mut evicted = false;
        for i in visible.clone() {
            #[cfg(test)]
            count_frame_work(|work| work.preparation_rows += 1);
            if !self.cached[i].layout_ready() {
                let mut prepared = Self::with_fonts_eager(
                    vec![self.lines[i].clone()],
                    self.width,
                    self.height,
                    self.scale,
                    self.settings.as_ref(),
                    self.fonts.as_mut().expect("lazy fonts"),
                    false,
                    #[cfg(any(test, feature = "dev-render-metrics"))]
                    false,
                )?;
                let measured = prepared.cached.remove(0);
                if measured.height != self.cached[i].height {
                    self.prefix.add(i, measured.height - self.cached[i].height);
                }
                self.cached[i] = measured;
                self.resident.insert(i);
                #[cfg(any(test, feature = "dev-render-metrics"))]
                {
                    self.glyph_count += prepared.glyph_count;
                    self.missing_glyphs += prepared.missing_glyphs;
                    self.diagnostics[i] = prepared.diagnostics.remove(0);
                    self.diagnostics_json = None;
                    self.plain_preparations += 1;
                }
            }
        }
        // Bound retained manual-scroll geometry while keeping playback's cache.
        let focus = self.prepared_signature.map_or(0, |s| s.0);
        self.resident.retain(|&i| {
            #[cfg(test)]
            count_frame_work(|work| work.retention_rows += 1);
            let keep = visible.contains(&i)
                || i.abs_diff(focus) <= 32
                || protected.iter().any(|rows| rows.contains(&i));
            if !keep {
                evicted = true;
                for voice in &mut self.cached[i].voices {
                    voice.clear_geometry();
                }
                #[cfg(any(test, feature = "dev-render-metrics"))]
                {
                    self.diagnostics[i] = serde_json::Value::Null;
                    self.diagnostics_json = None;
                }
            }
            keep
        });
        // A return viewport protects the already measured playback band.
        // Manual preparation can evict that band and must recheck it.
        if protected.is_empty() && evicted {
            self.prepared_signature = None;
        }
        Ok(())
    }

    /// Source lines and their indexes are replaced together by constructing a layout.
    pub fn lines(&self) -> &[Line] {
        &self.lines
    }

    pub(crate) fn row_top(&self, row: usize) -> f64 {
        self.prefix.top(row)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Explicit row preparation and receipt collection modes"
    )]
    fn with_fonts_eager(
        lines: Vec<Line>,
        width: u32,
        height: u32,
        scale: f32,
        settings: Option<&crate::typography::Settings>,
        fonts: &mut crate::typography::Fonts,
        detailed: bool,
        #[cfg(any(test, feature = "dev-render-metrics"))] collect_diagnostics: bool,
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
        #[cfg(any(test, feature = "dev-render-metrics"))]
        let mut glyph_count = 0;
        #[cfg(any(test, feature = "dev-render-metrics"))]
        let mut missing_glyphs = 0;
        #[cfg(any(test, feature = "dev-render-metrics"))]
        let mut diagnostics = Vec::new();
        for line in &lines {
            if settings.is_some() && line.paint.is_none() {
                return Err("Style packet requires prepared voice metadata".into());
            }
            let boxes = row_voice_boxes(line, width, height, scale, settings, font_size);
            let mut voices = Vec::with_capacity(boxes.len());
            #[cfg(any(test, feature = "dev-render-metrics"))]
            let mut voice_diagnostics = Vec::new();
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
                #[cfg(any(test, feature = "dev-render-metrics"))]
                let mut faces = Vec::new();
                for row in layout.lines() {
                    for item in row.items() {
                        if let PositionedLayoutItem::GlyphRun(gr) = item {
                            let run = gr.run();
                            #[cfg(any(test, feature = "dev-render-metrics"))]
                            if collect_diagnostics {
                                let face = fonts.describe(run.font());
                                faces.push(serde_json::json!({"face":face,"text_bytes":[run.text_range().start,run.text_range().end],
                            "requested_attributes":format!("{:?}",run.font_attrs()), "size":run.font_size(),
                            "normalized_coords":run.normalized_coords().iter().map(|c|c.to_bits()).collect::<Vec<_>>() }));
                            }
                            let glyphs: Vec<Glyph> = gr
                                .positioned_glyphs()
                                .map(|g| {
                                    #[cfg(any(test, feature = "dev-render-metrics"))]
                                    {
                                        glyph_count += 1;
                                        missing_glyphs += usize::from(g.id == 0);
                                    }
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
                let translation = if let (Some(settings), Some(text)) = (
                    settings,
                    line.voice(index)
                        .and_then(|v| v.translation.as_deref())
                        .filter(|t| !t.is_empty()),
                ) {
                    let policy = crate::auxiliary::Policy::voice(
                        settings,
                        scale,
                        voice_box.background,
                        voice_box.geometry.font_size,
                        voice_box.geometry.text_width,
                    );
                    // Spicy translations inherit the physical edge of the source's
                    // logical Start/End alignment. AMLL keeps its logical flag.
                    let right = voice_box.geometry.right
                        ^ (settings.style == crate::typography::Style::Spicy && layout.is_rtl());
                    let t = crate::auxiliary::Translation::prepare(
                        text,
                        &policy,
                        right,
                        f64::from(voice_box.padding) + content_height,
                        fonts,
                        &mut layouts,
                        #[cfg(any(test, feature = "dev-render-metrics"))]
                        collect_diagnostics,
                        line.voice(index),
                    );
                    #[cfg(any(test, feature = "dev-render-metrics"))]
                    {
                        glyph_count += t.glyph_count;
                        missing_glyphs += t.missing_glyphs;
                    }
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
                #[cfg(any(test, feature = "dev-render-metrics"))]
                if collect_diagnostics {
                    voice_diagnostics.push(serde_json::json!({"geometry":voice_box.geometry,"text":text,
                "voice_height":voice.height,"background":voice_box.background,"offset":voice.offset,
                "faces":faces,"line_count":voice.layout.as_ref().map_or(0usize, |l| l.len()),
                "translation":voice.translation.as_ref().map(|t| &t.diagnostics),
                "word_ranges":voice.words.iter().map(|w|vec![w.bytes.start,w.bytes.end]).collect::<Vec<_>>() }));
                }
                voices.push(voice);
            }
            let lead_size = voices[0].size;
            let lead_lane = voices[0].lane;
            let lead_x = voices[0].x;
            let lead_right = voices[0].right;
            let (height, top) = if let Some(settings) = settings {
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
                (height, top)
            } else {
                (cursor, 0.0)
            };
            #[cfg(any(test, feature = "dev-render-metrics"))]
            {
                let mut row = voice_diagnostics
                    .first()
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                if let Some(fields) = row.as_object_mut() {
                    fields.insert("height".into(), serde_json::json!(height));
                    fields.insert("content_top".into(), serde_json::json!(top));
                    fields.insert("content_height".into(), serde_json::json!(cursor));
                    fields.insert("voices".into(), serde_json::Value::Array(voice_diagnostics));
                }
                diagnostics.push(row);
            }
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
        // Keep drawable clusters and diagnostics when no installed face covers a glyph.
        let interludes = crate::interlude::slots(&lines)
            .into_iter()
            .enumerate()
            .filter_map(|(row, slot)| slot.map(|slot| (row, slot)))
            .collect();
        let resident = (0..cached.len()).collect();
        Ok(Self {
            timing: TimingIndex::new(&lines),
            lines,
            prefix: RowOffsets::new(
                &cached,
                if settings.is_none() {
                    f64::from(font_size) * 0.7
                } else {
                    0.0
                },
            ),
            cached,
            resident,
            cues: crate::scheduling::VisualCues::default(),
            width,
            height,
            font_size: font_size as f64,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            glyph_count,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            missing_glyphs,
            interludes,
            // Scratch row preparation does not own the interlude renderer.
            dot_glyph: None,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            diagnostics,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            diagnostics_json: None,
            fonts: None,
            settings: None,
            scale,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            plain_preparations: 0,
            #[cfg(any(test, feature = "dev-render-metrics"))]
            detailed_preparations: 0,
            footer: None,
            prepared_signature: None,
            return_timing_cache: None,
            #[cfg(test)]
            return_timing_misses: 0,
            manual_anchor: None,
        })
    }

    /// Materialize layout receipts only on request. The owned byte snapshot is
    /// reused by the C ABI's size query and copy until row residency changes.
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub fn layout_json(&mut self) -> Result<&[u8], Error> {
        if self.diagnostics_json.is_none() {
            let mut fonts = None;
            for i in 0..self.cached.len() {
                if !self.cached[i].layout_ready() || !self.diagnostics[i].is_null() {
                    continue;
                }
                let fonts =
                    fonts.get_or_insert_with(|| self.fonts.as_ref().expect("track fonts").clone());
                let mut receipt = Self::with_fonts_eager(
                    vec![self.lines[i].clone()],
                    self.width,
                    self.height,
                    self.scale,
                    self.settings.as_ref(),
                    fonts,
                    false,
                    true,
                )?;
                self.diagnostics[i] = receipt.diagnostics.remove(0);
                for (index, voice) in self.cached[i].voices.iter_mut().enumerate() {
                    if let Some(translation) = &mut voice.translation {
                        translation.diagnostics =
                            self.diagnostics[i]["voices"][index]["translation"].clone();
                    }
                }
            }
            self.diagnostics_json = Some(serde_json::to_vec(&self.diagnostics)?);
        }
        Ok(self
            .diagnostics_json
            .as_deref()
            .expect("materialized receipt"))
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

    /// Ordinary attribution pixels bypass lyric emission and shared blur.
    pub(crate) fn frame_overlay(&self, time: f64, scroll: f64, scene: &mut Scene) {
        scene.reset();
        if let Some(footer) = &self.footer {
            let y = self.footer_y(
                footer,
                self.scroll_anchor(),
                scroll,
                self.interlude_shift(time).1,
            );
            footer.draw(
                scene,
                y,
                self.width,
                f64::from(self.height),
                f64::from(self.scale),
            );
        }
    }

    pub(crate) fn footer_hit(&self, x: f64, y: f64, scroll: f64, time: f64) -> i32 {
        self.footer.as_ref().map_or(-1, |footer| {
            let top = self.footer_y(
                footer,
                self.scroll_anchor(),
                scroll,
                self.interlude_shift(time).1,
            );
            footer.hit_test(x, y - top, f64::from(self.scale))
        })
    }

    /// Placement shared by drawing and hit-testing, below the measured final row.
    pub(crate) fn footer_y(
        &self,
        footer: &crate::credits::Footer,
        anchor: f64,
        scroll: f64,
        extra: f64,
    ) -> f64 {
        anchor + self.content_bottom() + footer.inset - scroll + extra
    }

    /// Skia scroll anchor in surface pixels. Legacy fixtures retain their center anchor.
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
        if time >= self.timing.song_end
            && let Some(target) = self.credits_scroll()
        {
            return Some(target);
        }
        let (start, end) = crate::auto_scroll_range(window)?;
        let last = self.lines.len() - 1;
        let start = self
            .interlude_at(time)
            .map_or(start.min(last), |(row, _)| row);
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
            self.row_top(start) + shifted(start, false),
            self.row_top(end) + self.cached[end].height + shifted(end, true),
        ))
    }

    /// Interlude whose break contains `time`, with the expanded slot height.
    pub(crate) fn interlude_at(&self, time: f64) -> Option<(usize, crate::interlude::Interlude)> {
        self.settings.as_ref()?;
        self.interlude_slot_at(time)
    }

    fn interlude_slot_at(&self, time: f64) -> InterludeSlot {
        let i = self
            .interludes
            .partition_point(|(_, slot)| slot.start <= time);
        let entry = self.interludes.get(i.checked_sub(1)?)?;
        (time < entry.1.end).then_some(*entry)
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
            return self.row_top(self.timing.at(time).previous.max(0) as usize);
        }
        let window = self.window(time);
        self.target_at(&window, time)
            .unwrap_or(self.row_top(window.focus.max(0) as usize))
    }

    /// Bottom of the final row using current (measured) heights.
    pub(crate) fn content_bottom(&self) -> f64 {
        let last = self.lines.len().saturating_sub(1);
        self.row_top(last) + self.cached[last].height
    }

    /// Highest scroll offset Skia allows: the last row can reach the top
    /// anchor, and the credits footer can reach the bottom padding.
    pub fn max_scroll(&self) -> f64 {
        let last = self.lines.len().saturating_sub(1);
        let mut max = self.row_top(last).max(0.0);
        if let Some(footer) = &self.footer {
            let padding = crate::ACTIVE_RANGE_BOTTOM_PADDING * f64::from(self.scale);
            max = max.max(
                self.scroll_anchor() + self.content_bottom() + footer.tail - f64::from(self.height)
                    + padding,
            );
        }
        max
    }

    /// Skia footer target: the whole credits block ends at the viewport bottom
    /// minus the same 24 pt bottom padding used by fit-scroll.
    fn credits_scroll(&self) -> Option<f64> {
        let footer = self.footer.as_ref()?;
        let last = self.lines.len() - 1;
        let padding = crate::ACTIVE_RANGE_BOTTOM_PADDING * f64::from(self.scale);
        let target = self.scroll_anchor() + self.content_bottom() + footer.tail
            - f64::from(self.height)
            + padding;
        Some(target.max(self.row_top(last)).clamp(0.0, self.max_scroll()))
    }

    /// First row intersecting `scroll` (Skia `getFirstVisibleIndex`).
    fn first_visible(&self, scroll: f64) -> usize {
        self.prefix
            .partition_point(|top| top <= scroll)
            .saturating_sub(1)
            .min(self.lines.len() - 1)
    }

    /// Keep a manual viewport on the same row across style geometry changes.
    /// The final interval ends at the footer scroll limit, so a visible footer
    /// stays visible even when AMLL and Spicy have different row heights.
    pub(crate) fn remap_manual_scroll(
        &mut self,
        previous: &Self,
        scroll: f64,
        time: f64,
    ) -> Result<f64, Error> {
        self.prepare(time)?;
        let scroll = scroll.clamp(0.0, previous.max_scroll());
        let row = previous.first_visible(scroll);
        let old_top = previous.row_top(row);
        let old_end = if row + 1 < previous.lines.len() {
            previous.row_top(row + 1)
        } else {
            previous.max_scroll()
        };
        let fraction = if old_end > old_top {
            ((scroll - old_top) / (old_end - old_top)).clamp(0.0, 1.0)
        } else {
            f64::from(row + 1 == previous.lines.len())
        };
        self.manual_anchor = previous
            .manual_anchor
            .or(Some(ManualAnchor { row, fraction }));
        self.prepare_manual_viewport(scroll)
    }

    fn manual_anchor_offset(&self, anchor: ManualAnchor) -> f64 {
        let top = self.row_top(anchor.row);
        let end = if anchor.row + 1 < self.lines.len() {
            self.row_top(anchor.row + 1)
        } else {
            self.max_scroll()
        };
        (top + anchor.fraction * (end - top)).clamp(0.0, self.max_scroll())
    }

    /// Resolve again after each render-order preparation pass. Measuring rows
    /// before the anchor can change its pixel offset without changing ownership.
    pub(crate) fn prepare_manual_viewport(&mut self, scroll: f64) -> Result<f64, Error> {
        let offset = self
            .manual_anchor
            .map_or(scroll, |a| self.manual_anchor_offset(a));
        self.prepare_viewport(offset)?;
        Ok(self
            .manual_anchor
            .map_or(scroll, |a| self.manual_anchor_offset(a)))
    }

    /// Preserve the manual viewport in the old geometry while both preparation
    /// passes replace estimated row heights with measured ones.
    pub(crate) fn prepare_manual_frame(&mut self, time: f64, scroll: f64) -> Result<f64, Error> {
        if self.manual_anchor.is_some() {
            self.prepare(time)?;
            return self.prepare_manual_viewport(scroll);
        }

        let row = self.first_visible(scroll);
        let old_max = self.max_scroll();
        let origin = |scene: &Self| {
            if scroll >= old_max {
                scene.max_scroll()
            } else {
                scene.row_top(row)
            }
        };
        let before = origin(self);
        let rebase = |scene: &Self| scroll + (origin(scene) - before);
        self.prepare(time)?;
        self.prepare_viewport(rebase(self))?;
        Ok(rebase(self))
    }

    /// Match slopes at shared row boundaries. The harmonic mean adapts to
    /// uneven heights while keeping both endpoint slopes below twice the
    /// interval's secant, a monotone region for the Hermite cubic.
    fn return_slopes(&self, row: usize) -> (f64, f64) {
        let height = self.cached[row].height;
        let slope = |adjacent: f64| 2.0 * height * adjacent / (height + adjacent);
        let before = row
            .checked_sub(1)
            .map_or(height, |i| slope(self.cached[i].height));
        let after = self
            .cached
            .get(row + 1)
            .map_or(height, |other| slope(other.height));
        (before, after)
    }

    fn return_row_pose(&self, row: usize, fraction: f64) -> (f64, f64) {
        let height = self.cached[row].height;
        let (first, last) = self.return_slopes(row);
        if fraction <= 0.0 {
            return (fraction * first, first);
        }
        if fraction >= 1.0 {
            return (height + (fraction - 1.0) * last, last);
        }
        let t = fraction;
        let u = 1.0 - t;
        let offset = height * t * t * (3.0 - 2.0 * t) + first * t * u * u - last * t * t * u;
        let slope = 6.0 * height * t * u + first * u * (1.0 - 3.0 * t) + last * t * (3.0 * t - 2.0);
        (offset, slope)
    }

    /// Invert only the intersecting row, with linear overscroll at either end.
    pub(crate) fn return_coordinate(&self, offset: f64) -> (f64, f64) {
        let row = self.first_visible(offset);
        let local = offset - self.row_top(row);
        let height = self.cached[row].height;
        let (first, last) = self.return_slopes(row);
        let fraction = if local <= 0.0 {
            local / first
        } else if local >= height {
            1.0 + (local - height) / last
        } else {
            let (mut lo, mut hi) = (0.0, 1.0);
            for _ in 0..42 {
                let mid = (lo + hi) * 0.5;
                if self.return_row_pose(row, mid).0 < local {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            (lo + hi) * 0.5
        };
        (row as f64 + fraction, self.return_row_pose(row, fraction).1)
    }

    pub(crate) fn return_offset(&self, coordinate: f64) -> f64 {
        let row = (coordinate.floor() as usize).min(self.lines.len() - 1);
        self.row_top(row) + self.return_row_pose(row, coordinate - row as f64).0
    }

    pub(crate) fn return_anchor_row(&self, offset: f64) -> usize {
        self.first_visible(offset)
    }

    pub(crate) fn painted_row_top(&self, time: f64, row: usize) -> f64 {
        let (slot, extra) = self.interlude_shift(time);
        let cached = &self.cached[row];
        let lead = cached.lead();
        self.scroll_anchor()
            + self.row_top(row)
            + cached.top
            + lead.offset
            + lead.padding
            + if slot.is_some_and(|slot| row >= slot) {
                extra
            } else {
                0.0
            }
    }

    /// Word cues wake the renderer without invalidating playback geometry.
    pub(crate) fn return_timing(&mut self, time: f64) -> ReturnTiming {
        if let Some((cached, mut timing)) = self.return_timing_cache
            && self.timing.contains(cached, time)
        {
            timing.target.time = time;
            return timing;
        }
        #[cfg(test)]
        {
            self.return_timing_misses += 1;
        }
        let timing = ReturnTiming {
            key: self.timing.at(time).key,
            target: self.return_target_at(time),
        };
        self.return_timing_cache = Some((self.timing.boundary(time), timing));
        timing
    }

    pub(crate) fn return_target_at(&self, time: f64) -> ReturnTarget {
        let window = self.window(time);
        let slot = self.interlude_at(time);
        let last = self.lines.len() - 1;
        let ended = self.footer.is_some() && time >= self.timing.song_end;
        let rows = if ended {
            TargetRows::Credits
        } else if let Some((start, end)) = crate::auto_scroll_range(&window) {
            let start = slot.map_or(start.min(last), |(row, _)| row);
            TargetRows::Lyrics(start, end.min(last).max(start))
        } else {
            TargetRows::Row(window.focus.max(0) as usize)
        };
        ReturnTarget { rows, slot, time }
    }

    pub(crate) fn resolve_return_target(&self, target: ReturnTarget) -> f64 {
        match target.rows {
            TargetRows::Row(row) => self.row_top(row),
            TargetRows::Lyrics(start, end) => {
                let extra = self.return_interlude_height(target);
                let slot_row = target.slot.map_or(usize::MAX, |(row, _)| row);
                let top = self.row_top(start) + if start > slot_row { extra } else { 0.0 };
                let bottom = self.row_top(end)
                    + self.cached[end].height
                    + if end >= slot_row { extra } else { 0.0 };
                self.fit_scroll(top, bottom)
            }
            TargetRows::Credits => self.credits_scroll().unwrap_or_else(|| self.max_scroll()),
        }
    }

    fn return_interlude_height(&self, target: ReturnTarget) -> f64 {
        target.slot.map_or(0.0, |(row, slot)| {
            crate::interlude::slot_height(
                &slot,
                false,
                self.cached[row].size,
                f64::from(self.width),
                target.time,
            )
        })
    }

    /// Include the intersecting row above the window. Interlude displacement
    /// can move rows into view, so extend the lower search by its full height.
    fn return_rows(&self, extra: f64, scroll: f64, lookahead: f64) -> Range<usize> {
        let origin = scroll - self.scroll_anchor();
        let lower = origin - extra.max(0.0) - 40.0 - lookahead;
        let upper = origin + f64::from(self.height) + 40.0 + lookahead;
        let first = self
            .prefix
            .partition_point(|top| top < lower)
            .saturating_sub(1);
        let end = self.prefix.partition_point(|top| top <= upper).max(first);
        first..end
    }

    pub(crate) fn prepare_return_resize(
        &mut self,
        time: f64,
        row: usize,
        screen_y: f64,
    ) -> Result<(), Error> {
        let timing = self.return_timing(time);
        let offset = self.painted_row_top(time, row) - screen_y;
        let playback = self.prepare_return_playback(timing, offset, offset)?;
        let offset = self.painted_row_top(time, row) - screen_y;
        self.prepare_return_viewport(timing, offset, offset, &playback, 0..0)
    }

    pub(crate) fn prepare_return_playback(
        &mut self,
        timing: ReturnTiming,
        displayed: f64,
        next: f64,
    ) -> Result<Range<usize>, Error> {
        let lookahead = f64::from(self.height) * 0.5;
        let extra = self.return_interlude_height(timing.target);
        let protected = [
            self.return_rows(extra, displayed, lookahead),
            self.return_rows(extra, next, lookahead),
        ];
        let (_, _, first, detail_end) = timing.key;
        let playback = self.playback_rows(first, detail_end);
        self.prepare_playback(timing.key, &protected)?;
        Ok(playback)
    }

    pub(crate) fn prepare_return_endpoint(
        &mut self,
        target: ReturnTarget,
        current: ReturnTiming,
        displayed: f64,
        transit: f64,
        playback: &Range<usize>,
    ) -> Result<Range<usize>, Error> {
        let offset = self.resolve_return_target(target);
        let extra = self.return_interlude_height(target);
        let endpoint = self.return_rows(extra, offset, 0.0);
        if !endpoint.clone().all(|row| self.geometry_ready(row)) {
            let current_extra = self.return_interlude_height(current.target);
            let protected = [
                playback.clone(),
                self.return_rows(current_extra, displayed, 0.0),
                self.return_rows(current_extra, transit, 0.0),
            ];
            let band = self.return_rows(extra, offset, f64::from(self.height) * 0.5);
            self.prepare_viewport_rows(band, &protected)?;
        }
        Ok(endpoint)
    }

    pub(crate) fn prepare_return_viewport(
        &mut self,
        timing: ReturnTiming,
        displayed: f64,
        next: f64,
        playback: &Range<usize>,
        endpoint: Range<usize>,
    ) -> Result<(), Error> {
        let lookahead = f64::from(self.height) * 0.5;
        let extra = self.return_interlude_height(timing.target);
        let visible = self.return_rows(extra, next, lookahead);
        let protected = [
            playback.clone(),
            self.return_rows(extra, displayed, 0.0),
            endpoint,
        ];
        self.prepare_viewport_rows(visible, &protected)
    }

    pub(crate) fn return_viewport_ready(&self, timing: ReturnTiming, scroll: f64) -> bool {
        self.return_rows(self.return_interlude_height(timing.target), scroll, 0.0)
            .all(|index| self.cached[index].layout_ready())
    }

    pub(crate) fn clear_manual_anchor(&mut self) {
        self.manual_anchor = None;
    }

    #[cfg(test)]
    pub(crate) fn has_manual_anchor(&self) -> bool {
        self.manual_anchor.is_some()
    }

    /// Rows that can be drawn near `scroll`, including the interlude overscan.
    pub fn visible_rows(&self, scroll: f64) -> std::ops::Range<usize> {
        let height = f64::from(self.height);
        let first = self
            .prefix
            .partition_point(|top| top + 200.0 < scroll - height);
        let last = self
            .prefix
            .partition_point(|top| top < scroll + height * 2.0)
            .max(first + 1)
            .min(self.lines.len());
        first.min(self.lines.len() - 1)..last
    }

    pub(crate) fn resident_rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.resident.iter().copied()
    }

    /// Conservative prefix search, then only resident rows in that range.
    /// Offset extrema are bounded by resident geometry, not the source length.
    /// The exact historical row rejection remains in each painter.
    pub(crate) fn drawing_rows(
        &self,
        time: f64,
        scroll: f64,
        adjust: &[f64],
    ) -> impl Iterator<Item = (usize, f64)> + '_ {
        let (mut min_adjust, mut max_adjust) = (0.0_f64, 0.0_f64);
        for &index in &self.resident {
            #[cfg(test)]
            count_frame_work(|work| work.retention_rows += 1);
            let value = adjust.get(index).copied().unwrap_or(0.0);
            min_adjust = min_adjust.min(value);
            max_adjust = max_adjust.max(value);
        }
        let extra = self.interlude_shift(time).1;
        let margin = (64.0 * f64::from(self.scale)).max(40.0);
        let origin = scroll - self.scroll_anchor();
        let lower = origin - max_adjust - extra.max(0.0) - margin;
        let upper = origin - min_adjust - extra.min(0.0) + f64::from(self.height) + margin;
        let first = self
            .prefix
            .partition_point(|top| top < lower)
            .saturating_sub(1);
        let last = self.prefix.partition_point(|top| top <= upper).max(first);
        let mut next = first;
        let mut top = self.row_top(first);
        self.resident.range(first..last).copied().map(move |row| {
            // A cascade can expand the conservative range across cold rows.
            // Jump over each gap and walk resident bands sequentially.
            if row != next {
                top = self.row_top(row);
            }
            let start = top;
            top += self.cached[row].height + self.prefix.1;
            next = row + 1;
            #[cfg(test)]
            count_frame_work(|work| work.drawing_rows += 1);
            (row, start)
        })
    }

    pub(crate) fn frame_schedule(
        &self,
        time: f64,
        scroll: f64,
        adjust: &[f64],
        state: &crate::appearance::AppearanceState,
        scroll_animating: bool,
        advancing: bool,
    ) -> crate::scheduling::FrameSchedule {
        let (interlude_row, extra) = self.interlude_shift(time);
        let mut visible_changes = scroll_animating;
        let mut next_cue = if advancing {
            self.cues.next(time)
        } else {
            None
        };
        for (i, top) in self.drawing_rows(time, scroll, adjust) {
            #[cfg(test)]
            count_frame_work(|work| work.schedule_rows += 1);
            let row = &self.cached[i];
            let y = self.scroll_anchor() + top - scroll
                + adjust.get(i).copied().unwrap_or(0.0)
                + interlude_row.map_or(0.0, |r| if i >= r { extra } else { 0.0 });
            if y + row.height < -40.0 || y > f64::from(self.height) + 40.0 {
                continue;
            }
            let line = &self.lines[i];
            visible_changes = visible_changes
                || state.row(i).is_some_and(|r| r.animating)
                || (advancing && time >= line.start && time <= line.background_end);
            if advancing && !visible_changes {
                for (voice, source) in row.voices.iter().zip(line.voices()) {
                    let Some((start, finish)) = voice
                        .translation
                        .as_ref()
                        .and_then(|t| t.animation_window(source))
                    else {
                        continue;
                    };
                    if time < start {
                        next_cue = Some(next_cue.map_or(start, |cue| cue.min(start)));
                    } else if time < finish {
                        // A frame inside the window requests the next frame.
                        // The first sample at or after finish paints the settled mask before idling.
                        visible_changes = true;
                        break;
                    }
                }
            }
        }
        let interlude = self.interlude_at(time);
        if let Some((i, _)) = interlude {
            let top = self.scroll_anchor() + self.row_top(i) + self.cached[i].top - scroll
                + adjust.get(i).copied().unwrap_or(0.0);
            visible_changes |= (advancing || state.interlude_animating())
                && top + extra >= -40.0
                && top <= f64::from(self.height) + 40.0;
        }
        // Do not freeze hidden owners whose history affects their return or
        // outgoing release. Sleeping is safe only after those owners settle.
        let retained_changes = state.animating()
            || state.interlude_animating()
            || (advancing
                && (interlude.is_some()
                    || self.resident_rows().any(|i| {
                        state.row(i).is_some()
                            && time >= self.lines[i].start
                            && time <= self.lines[i].background_end
                    })));
        crate::scheduling::FrameSchedule {
            #[cfg(any(test, feature = "dev-render-metrics"))]
            visible_changes,
            continuous: visible_changes || retained_changes,
            next_cue,
        }
    }

    /// Per-frame follow command. `position` is the current visual offset, used
    /// for Skia's first-visible row, duration interval and interlude flag.
    pub fn scroll_command(&self, time: f64, position: f64) -> crate::motion::Command {
        let window = self.window(time);
        let target = self
            .target_at(&window, time)
            .unwrap_or(self.row_top(window.focus.max(0) as usize));
        let index = crate::auto_scroll_range(&window)
            .map(|(start, _)| start)
            .unwrap_or_else(|| window.focus.max(0) as usize)
            .min(self.lines.len() - 1);
        let index = self.interlude_slot_at(time).map_or(index, |(row, _)| row);
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
            let top = anchor + self.row_top(index) - scroll
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
        let window = self.window(time);
        let active = window.active();
        let active_end = active.map_or(window.focus.max(0) as usize, |(_, end)| end);
        let scale = f64::from(self.scale);
        let anchor = self.scroll_anchor();
        let (interlude_row, extra) = self.interlude_shift(time);
        let position = |index: usize, top| {
            anchor + top - scroll
                + adjust.get(index).copied().unwrap_or(0.0)
                + interlude_row.map_or(0.0, |row| if index >= row { extra } else { 0.0 })
        };
        for (i, top) in self.drawing_rows(time, scroll, adjust) {
            let cached = &self.cached[i];
            let y = position(i, top);
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
        let band_top = position(first, self.row_top(first)) - 10.0 * scale;
        let band_bottom =
            position(next, self.row_top(next)) + self.cached[next].height + 10.0 * scale;
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
    pub fn insert(&mut self, key: String, mut scene: TrackScene) {
        for row in &mut scene.cached {
            for voice in &mut row.voices {
                if let Some(translation) = &mut voice.translation {
                    translation.reset_word_fill();
                }
            }
        }
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
    fn missing_clusters_preserve_available_glyphs_in_both_styles() {
        for style in [Style::Spicy, Style::Amll] {
            let text = "Latin 日本語 한글 العربية \u{10ffff}";
            let mut lines = source(1);
            lines[0].text = text.into();
            let voice = lines[0].paint.as_mut().unwrap();
            voice.text = text.into();
            voice.words[0].text = text.into();
            voice.words[0].graphemes = text.chars().map(|ch| ch.to_string()).collect();
            lines[0].atoms[0].bytes = 0..text.len();
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let track = TrackScene::with_fonts_eager(
                lines,
                390,
                640,
                1.0,
                Some(&settings),
                &mut fonts(),
                true,
                false,
            )
            .unwrap();
            assert!(track.missing_glyphs > 0);
            assert!(track.glyph_count > track.missing_glyphs);
            let layout = track.cached[0].voices[0].layout.as_ref().unwrap();
            let ids: Vec<_> = layout
                .lines()
                .flat_map(|line| {
                    line.runs().flat_map(|run| {
                        run.visual_clusters()
                            .flat_map(|cluster| cluster.glyphs().map(|glyph| glyph.id))
                    })
                })
                .collect();
            assert!(ids.contains(&0));
            assert!(ids.iter().any(|id| *id != 0));
            assert!(track.cached[0].height > 0.0);
        }
    }
    fn scheduling_lines(emphasized: bool) -> Vec<Line> {
        let mut lines = source(3);
        for line in &mut lines {
            line.start += 1500.0;
            line.end += 1500.0;
            line.background_end += 1500.0;
            for atom in &mut line.atoms {
                atom.start += 1500.0;
                atom.end += 1500.0;
            }
            for voice in line.paint.iter_mut() {
                voice.start += 1500.0;
                voice.end += 1500.0;
                for word in &mut voice.words {
                    word.start += 1500.0;
                    word.end += 1500.0;
                    word.appearance = Some(crate::typography::WordAppearance {
                        emphasized,
                        origin: 0.5,
                        rtl: false,
                        last: true,
                        emphasis: emphasized.then_some(crate::typography::EmphasisGroup {
                            start: word.start,
                            end: word.end,
                            index: 0,
                            count: word.graphemes.len(),
                            last: true,
                        }),
                    });
                }
            }
        }
        lines
    }

    #[test]
    fn idle_scheduling_preserves_continuous_animation_history() {
        schedule_replay(false);
    }

    #[test]
    #[ignore = "GPU pixel comparison for continuous and idle-scheduled histories"]
    fn idle_scheduling_preserves_continuous_pixels() {
        schedule_replay(true);
    }

    fn schedule_replay(pixels: bool) {
        use crate::{
            appearance::{AppearanceState, Effect},
            gpu::Gpu,
            motion::FollowScroll,
        };
        for (style, emphasized) in [Style::Spicy, Style::Amll]
            .into_iter()
            .flat_map(|style| [false, true].map(|emphasized| (style, emphasized)))
        {
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut full = TrackScene::with_fonts(
                scheduling_lines(emphasized),
                390,
                640,
                1.0,
                Some(&settings),
                &mut fonts(),
            )
            .unwrap();
            let mut scheduled = TrackScene::with_fonts(
                scheduling_lines(emphasized),
                390,
                640,
                1.0,
                Some(&settings),
                &mut fonts(),
            )
            .unwrap();
            let (mut full_state, mut state) =
                (AppearanceState::default(), AppearanceState::default());
            let (mut full_scroll, mut scroll) = (FollowScroll::default(), FollowScroll::default());
            full_scroll.configure(style, 1.0, 3);
            scroll.configure(style, 1.0, 3);
            let (mut full_scene, mut scene) = (Scene::new(), Scene::new());
            let mut continuous = true;
            let mut next = None;
            let mut count = 0;
            for tick in 0..701 {
                let time = f64::from(tick) * 10.0;
                let native = time + 10_000.0;
                full.prepare(time).unwrap();
                let offset = full_scroll.sample(
                    &full.scroll_command(time, full_scroll.position()),
                    native,
                    true,
                );
                full_state.prepare(&full, time, native);
                full_state.advance(&full, time, native, true, Effect::Glow);
                let full_band = full.frame_appearance(
                    time,
                    offset,
                    full_scroll.row_adjustments(),
                    &full_state,
                    &mut full_scene,
                    Effect::Glow,
                );
                if tick > 0 && !continuous && next.is_none_or(|cue| time < cue) {
                    continue;
                }
                scheduled.prepare(time).unwrap();
                if !continuous {
                    state.resume(native, 10.0);
                    scroll.resume(native, 10.0);
                }
                let offset = scroll.sample(
                    &scheduled.scroll_command(time, scroll.position()),
                    native,
                    true,
                );
                state.prepare(&scheduled, time, native);
                state.advance(&scheduled, time, native, true, Effect::Glow);
                let band = scheduled.frame_appearance(
                    time,
                    offset,
                    scroll.row_adjustments(),
                    &state,
                    &mut scene,
                    Effect::Glow,
                );
                for (a, b) in [(band.0, full_band.0), (band.1, full_band.1)] {
                    assert!((a - b).abs() < 0.0001, "{style:?} time={time}");
                }
                assert_eq!(
                    scene.encoding().path_data,
                    full_scene.encoding().path_data,
                    "{style:?} time={time}"
                );
                assert_eq!(
                    scene.encoding().draw_data,
                    full_scene.encoding().draw_data,
                    "{style:?} time={time}"
                );
                assert_eq!(
                    scene.encoding().resources.color_stops,
                    full_scene.encoding().resources.color_stops,
                    "{style:?} time={time}"
                );
                if pixels && [150, 251, 450, 600].contains(&tick) {
                    let mut a = pollster::block_on(Gpu::new(390, 640)).unwrap();
                    let mut b = pollster::block_on(Gpu::new(390, 640)).unwrap();
                    a.render_appearance(&full_scene, full_band, true, true)
                        .unwrap();
                    b.render_appearance(&scene, band, true, true).unwrap();
                    let (a, b) = (a.read_pixels().unwrap(), b.read_pixels().unwrap());
                    assert!(
                        a == b,
                        "{style:?} time={time} pixel differences={}",
                        a.iter().zip(&b).filter(|(a, b)| a != b).count()
                    );
                }
                let schedule = scheduled.frame_schedule(
                    time,
                    offset,
                    scroll.row_adjustments(),
                    &state,
                    scroll.animating(),
                    true,
                );
                continuous = schedule.continuous;
                next = schedule.next_cue;
                count += 1;
                if (1500.0..2500.0).contains(&time) {
                    assert!(
                        schedule.visible_changes && continuous,
                        "fills must stay live"
                    );
                }
            }
            assert!(count < 600, "settled playback must actually suspend frames");
            assert!(
                !continuous && next.is_none(),
                "settled final frame must sleep indefinitely"
            );
        }
    }

    #[test]
    fn stateless_dots_and_hidden_animation_history_keep_their_required_cadence() {
        use crate::appearance::{AppearanceState, Effect};
        for style in [Style::Spicy, Style::Amll] {
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
                &mut fonts(),
            )
            .unwrap();
            track.prepare(2600.0).unwrap();
            let mut state = AppearanceState::default();
            state.prepare(&track, 2600.0, 10_000.0);
            state.advance(&track, 2600.0, 10_000.0, true, Effect::Glow);
            let schedule = track.frame_schedule(
                2600.0,
                track.scroll_target(2600.0),
                &[],
                &state,
                false,
                true,
            );
            assert!(
                schedule.continuous && schedule.visible_changes,
                "dot breathing is not a spring velocity test"
            );
            let hidden = track.frame_schedule(2600.0, 1_000_000.0, &[], &state, false, true);
            assert!(
                !hidden.visible_changes && hidden.continuous,
                "retain hidden dot history"
            );
        }
    }

    #[test]
    fn conservative_drawing_range_matches_full_scan_with_offsets_and_interludes() {
        for style in [Style::Spicy, Style::Amll] {
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut lines = source(1000);
            lines[0].paint.as_mut().unwrap().translation = Some("Tall translated row ".repeat(40));
            let mut track =
                TrackScene::with_fonts(lines, 390, 640, 2.0, Some(&settings), &mut fonts())
                    .unwrap();
            for time in [500.0, 50_500.0, 80_500.0, 500.0] {
                track.prepare(time).unwrap();
                for index in [0, 50, 80, 999] {
                    let scroll = track.row_top(index);
                    track.prepare_viewport(scroll).unwrap();
                    let mut adjust = vec![0.0; track.lines.len()];
                    for &i in &track.resident {
                        adjust[i] = if i % 2 == 0 { -2400.0 } else { 1600.0 };
                    }
                    for dy in [-640.0, 0.0, 640.0] {
                        assert_drawing_matches_full_scan(&track, time, scroll + dy, &adjust);
                        assert_drawing_matches_full_scan(&track, time, scroll + dy, &[]);
                    }
                }
            }
            let mut interlude = TrackScene::with_fonts(
                long_gap_lines(),
                390,
                640,
                1.0,
                Some(&settings),
                &mut fonts(),
            )
            .unwrap();
            for time in [999.0, 1000.0, 2600.0, 5499.0, 5500.0, 5999.0, 6000.0] {
                interlude.prepare(time).unwrap();
                let scroll = interlude.scroll_target(time);
                for delta in [-1000.0, 0.0, 1000.0] {
                    assert_drawing_matches_full_scan(
                        &interlude,
                        time,
                        scroll + delta,
                        &[500.0, -400.0, 200.0],
                    );
                }
            }
        }
    }

    fn assert_drawing_matches_full_scan(
        track: &TrackScene,
        time: f64,
        scroll: f64,
        adjust: &[f64],
    ) {
        let (row, extra) = track.interlude_shift(time);
        let accepted = |i: usize| {
            let cached = &track.cached[i];
            let y = track.scroll_anchor() + track.row_top(i) - scroll
                + adjust.get(i).copied().unwrap_or(0.0)
                + row.map_or(0.0, |r| if i >= r { extra } else { 0.0 });
            cached.layout_ready()
                && y + cached.height >= -40.0
                && y <= f64::from(track.height) + 40.0
        };
        let old: Vec<_> = (0..track.lines.len()).filter(|&i| accepted(i)).collect();
        let candidates: Vec<_> = track
            .drawing_rows(time, scroll, adjust)
            .map(|(row, _)| row)
            .collect();
        assert!(candidates.len() <= track.resident.len());
        assert!(candidates.iter().all(|i| track.resident.contains(i)));
        let selected: Vec<_> = candidates.into_iter().filter(|&i| accepted(i)).collect();
        assert_eq!(selected, old, "time={time} scroll={scroll}");
        if track.lines.len() == 1000 {
            assert!(
                track.resident.len() < 100,
                "work must follow residency, not source count"
            );
        }
    }

    #[test]
    fn diagnostics_snapshot_matches_pre_deferral_receipts() {
        use sha2::{Digest, Sha256};
        for style in [Style::Spicy, Style::Amll] {
            let mut hashes = Vec::new();
            let mut lines = source(100);
            for line in &mut lines {
                line.paint.as_mut().unwrap().translation = Some("Translation office".into());
                line.backgrounds.push(line.paint.clone().unwrap());
            }
            let mut fonts = fonts();
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let mut track =
                TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
            assert!(track.diagnostics.iter().all(serde_json::Value::is_null));
            assert!(track.diagnostics_json.is_none());
            for stage in 0..6 {
                match stage {
                    0 => {}
                    1 => {
                        track.prepare(500.0).unwrap();
                        assert!(track.diagnostics.iter().all(serde_json::Value::is_null));
                        assert!(
                            track
                                .cached
                                .iter()
                                .flat_map(|r| &r.voices)
                                .filter_map(|v| v.translation.as_ref())
                                .all(|t| t.diagnostics.is_null())
                        );
                    }
                    2 => track.prepare(1500.0).unwrap(),
                    3 => track.prepare(50_500.0).unwrap(),
                    4 => track.prepare_viewport(track.row_top(80)).unwrap(),
                    _ => track.prepare(500.0).unwrap(),
                }
                hashes.push(format!(
                    "{:x}",
                    Sha256::digest(track.layout_json().unwrap())
                ));
                if style == Style::Spicy && stage > 0 {
                    for cached in track.cached.iter().filter(|row| row.layout_ready()) {
                        for (voice, weight) in cached.voices.iter().zip([900.0, 700.0]) {
                            let translation = voice.translation.as_ref().unwrap();
                            assert_eq!(translation.diagnostics["text"], "Translation office");
                            assert_eq!(
                                translation.diagnostics["policy"]["weight"].as_f64(),
                                Some(weight)
                            );
                        }
                    }
                }
                let address = track.layout_json().unwrap().as_ptr();
                let allocations = crate::allocation_probe::measure(|| {
                    assert_eq!(track.layout_json().unwrap().as_ptr(), address);
                });
                assert_eq!(
                    allocations, 0,
                    "repeat receipt requests must reuse the snapshot"
                );
            }
            if style == Style::Amll {
                // Captured at d6c1b2a before deferring receipts.
                assert_eq!(
                    hashes,
                    [
                        "8dc04e3207f48ae3e8cbc228c61c12bcd1a489f214b10a715eaf41823d00b945",
                        "981e4d29dc1c913aefa28868b6f9b92f25561f60ca73efe2b29a09e97c2f1adb",
                        "981e4d29dc1c913aefa28868b6f9b92f25561f60ca73efe2b29a09e97c2f1adb",
                        "24da06445c39d3eb1a765707e59a0a238cd934391289d66400ab1581202f9253",
                        "b2e189e13e03d8e4fe0520c923a0cc21314c13aa6ea6009c1045b49fa9edbd83",
                        "b4d4f697bdcfd0ff0ae535fb6b980c9822506699cd50b6af3f16d9b27524f317",
                    ]
                );
            } else {
                assert_eq!(
                    hashes[0],
                    "8dc04e3207f48ae3e8cbc228c61c12bcd1a489f214b10a715eaf41823d00b945"
                );
                assert_eq!(hashes[1], hashes[2]);
                assert_ne!(hashes[2], hashes[3]);
                assert_ne!(hashes[3], hashes[4]);
                assert_ne!(hashes[4], hashes[5]);
            }
        }
    }

    #[test]
    fn spicy_translation_follows_physical_source_edge_in_both_directions() {
        let mut lines = source(6);
        for line in &mut lines {
            line.paint.as_mut().unwrap().translation = Some("Latin translation".into());
        }
        let rtl = "שלום";
        for i in [0, 3, 4] {
            let line = &mut lines[i];
            line.text = rtl.into();
            line.atoms[0].bytes = 0..rtl.len();
            let voice = line.paint.as_mut().unwrap();
            voice.text = rtl.into();
            voice.words[0].text = rtl.into();
            voice.words[0].graphemes = rtl.chars().map(|c| c.to_string()).collect();
        }
        for i in [1, 3, 4] {
            lines[i].paint.as_mut().unwrap().opposite = true;
        }
        for i in [4, 5] {
            lines[i].paint.as_mut().unwrap().translation = Some("שלום translation".into());
        }
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts()).unwrap();
        track.prepare(500.0).unwrap();
        track.layout_json().unwrap();
        let inset = |i: usize| {
            track.cached[i]
                .lead()
                .translation
                .as_ref()
                .unwrap()
                .diagnostics["policy"]["x"]
                .as_f64()
                .unwrap()
        };
        for i in [0, 3, 4] {
            assert!(track.cached[i].lead().layout.as_ref().unwrap().is_rtl());
        }
        assert!(inset(0) > 0.0);
        assert_eq!(inset(0), inset(1));
        for i in [2, 3, 4, 5] {
            assert_eq!(inset(i), 0.0, "row {i} must stay left-aligned");
        }
    }

    #[test]
    fn spicy_translation_schedule_wakes_at_early_background_start_and_runs_to_settle() {
        let mut lines = source(2);
        lines.remove(0);
        let line = &mut lines[0];
        let mut background = line.paint.as_ref().unwrap().clone();
        background.start = 600.0;
        background.words[0].start = 700.0;
        background.translation = Some("Background translation".into());
        line.backgrounds.push(background);
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts()).unwrap();
        track.prepare(599.0).unwrap();
        let state = crate::appearance::AppearanceState::default();
        let scroll = track.scroll_target(599.0);
        let schedule = |time| track.frame_schedule(time, scroll, &[], &state, false, true);
        assert_eq!(schedule(599.0).next_cue, Some(600.0));
        assert!(schedule(600.0).continuous);
        assert!(schedule(651.0).visible_changes);
        assert!(schedule(2295.0).continuous);
        assert!(!schedule(2312.0).continuous);
    }

    #[test]
    #[ignore = "GPU pixel equivalence across explicit diagnostics request; requires Vulkan"]
    fn diagnostics_request_preserves_pixels_and_render_geometry() {
        use crate::{
            appearance::{AppearanceState, Effect},
            gpu::Gpu,
        };
        for (style, width, height, landscape) in [
            (Style::Spicy, 390, 640, false),
            (Style::Amll, 390, 640, false),
            (Style::Spicy, 844, 390, true),
            (Style::Amll, 844, 390, true),
        ] {
            let data: serde_json::Value =
                serde_json::from_str(include_str!("../test/appearance-track.json")).unwrap();
            let item = data["packets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| {
                    p["fixture_line"] == 11
                        && p["style"]
                            == if style == Style::Spicy {
                                "spicy"
                            } else {
                                "amll"
                            }
                        && p["landscape"] == landscape
                })
                .unwrap();
            let packet =
                crate::live::TrackPacket::parse(&serde_json::to_vec(&item["packet"]).unwrap())
                    .unwrap();
            let settings = packet.settings.clone().unwrap();
            let mut lines = packet.into_lines();
            let time = (lines[0].start + lines[0].end) * 0.5;
            for line in &mut lines {
                line.paint.as_mut().unwrap().translation = Some("Translation office".into());
                line.backgrounds.push(line.paint.clone().unwrap());
            }
            let mut track =
                TrackScene::with_fonts(lines, width, height, 1.0, Some(&settings), &mut fonts())
                    .unwrap();
            track.prepare(time).unwrap();
            let mut state = AppearanceState::default();
            state.prepare(&track, time, 1000.0);
            state.advance(&track, time, 1000.0, true, Effect::Glow);
            let mut scene = Scene::new();
            let scroll = track.scroll_target(time);
            let band = track.frame_appearance(time, scroll, &[], &state, &mut scene, Effect::Glow);
            let mut gpu = pollster::block_on(Gpu::new(width, height)).unwrap();
            gpu.render_appearance(&scene, band, true, true).unwrap();
            let before = gpu.read_pixels().unwrap();
            assert!(before.iter().any(|b| *b != 0));
            let before_scene = scene.clone();
            let prefix = track.prefix.clone();
            let preparations = (
                track.plain_preparations,
                track.detailed_preparations,
                track.glyph_count,
            );
            let layouts: Vec<_> = track
                .cached
                .iter()
                .flat_map(|r| &r.voices)
                .map(|v| v.layout.as_ref().unwrap() as *const _)
                .collect();
            track.layout_json().unwrap();
            assert_eq!(track.prefix, prefix);
            assert_eq!(
                (
                    track.plain_preparations,
                    track.detailed_preparations,
                    track.glyph_count
                ),
                preparations
            );
            assert_eq!(
                track
                    .cached
                    .iter()
                    .flat_map(|r| &r.voices)
                    .map(|v| v.layout.as_ref().unwrap() as *const _)
                    .collect::<Vec<_>>(),
                layouts
            );
            let after_band =
                track.frame_appearance(time, scroll, &[], &state, &mut scene, Effect::Glow);
            assert_eq!(band, after_band);
            let left = before_scene.encoding();
            let right = scene.encoding();
            assert!(left.path_tags == right.path_tags);
            assert_eq!(left.path_data, right.path_data);
            assert!(left.draw_tags == right.draw_tags);
            assert_eq!(left.draw_data, right.draw_data);
            assert_eq!(left.transforms, right.transforms);
            assert_eq!(left.styles, right.styles);
            assert_eq!(left.resources.color_stops, right.resources.color_stops);
            assert_eq!(
                left.resources.normalized_coords,
                right.resources.normalized_coords
            );
            assert_eq!(
                format!("{:?}", left.resources.glyphs),
                format!("{:?}", right.resources.glyphs)
            );
            // Match renderer cache history for an exact pixel comparison.
            let mut gpu = pollster::block_on(Gpu::new(width, height)).unwrap();
            gpu.render_appearance(&scene, after_band, true, true)
                .unwrap();
            let after = gpu.read_pixels().unwrap();
            assert!(
                before == after,
                "{style:?} landscape={landscape} different={} max={}",
                before.iter().zip(&after).filter(|(a, b)| a != b).count(),
                before
                    .iter()
                    .zip(&after)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap()
            );
        }
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
        track.layout_json().unwrap();
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
    fn credits_do_not_enter_lyric_emission_or_expand_protected_band() {
        use crate::appearance::{AppearanceState, Effect};
        for style in [Style::Spicy, Style::Amll] {
            let settings = Settings {
                style,
                font_scale: 1.0,
                landscape: false,
            };
            let credits = crate::live::Credits {
                songwriters: vec!["Writer".into()],
                attribution: Some(crate::live::Attribution {
                    maker: Some("maker".into()),
                    uploader: Some("uploader".into()),
                    ..Default::default()
                }),
            };
            let mut track = TrackScene::with_fonts_credits(
                source(6),
                390,
                640,
                1.0,
                Some(&settings),
                Some(&credits),
                &mut fonts(),
            )
            .unwrap();
            track.prepare(1000.0).unwrap();
            track.prepare_viewport(track.max_scroll()).unwrap();
            let mut state = AppearanceState::default();
            state.prepare(&track, 1000.0, 1000.0);
            state.advance(&track, 1000.0, 1000.0, true, Effect::Glow);
            let scroll = track.max_scroll();
            let top = track.footer_y(
                track.footer.as_ref().unwrap(),
                track.scroll_anchor(),
                scroll,
                track.interlude_shift(1000.0).1,
            );
            assert!(top > 0.0 && top < 640.0);
            let mut overlay = Scene::new();
            track.frame_overlay(1000.0, scroll, &mut overlay);
            assert!(!overlay.encoding().draw_data.is_empty());
            // Both the baseline and live RGB-emission paths must exclude credits.
            for effect in [Effect::Baseline, Effect::Glow] {
                let mut with = Scene::new();
                let band = track.frame_appearance(1000.0, scroll, &[], &state, &mut with, effect);
                let footer = track.footer.take();
                let mut without = Scene::new();
                let expected =
                    track.frame_appearance(1000.0, scroll, &[], &state, &mut without, effect);
                assert_eq!(band, expected, "footer must not protect intervening rows");
                assert_eq!(
                    with.encoding().draw_data,
                    without.encoding().draw_data,
                    "footer must not emit into glow channels"
                );
                track.footer = footer;
            }
            // Geometry uses the same placement, including the interlude insertion.
            assert_eq!(track.footer_hit(0.0, top, scroll, 1000.0), -2);
            assert_eq!(track.footer_hit(30.0, top + 19.0, scroll, 1000.0), -3);
            assert_eq!(track.footer_hit(30.0, top + 37.0, scroll, 1000.0), -4);
            assert_eq!(track.footer_hit(389.0, top + 19.0, scroll, 1000.0), -1);
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
                ..Default::default()
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
        assert!(track.max_scroll() >= track.row_top(track.lines.len() - 1));
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
    fn credits_footer_follows_measured_row_heights_after_incremental_layout() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let credits = crate::live::Credits {
            songwriters: vec!["A".into()],
            attribution: Some(crate::live::Attribution {
                provider: Some("Spicy".into()),
                community: true,
                maker: None,
                uploader: Some("uploader".into()),
                ..Default::default()
            }),
        };
        let mut fonts = fonts();
        let mut track = TrackScene::with_fonts_credits(
            source(40),
            200,
            640,
            1.0,
            Some(&settings),
            Some(&credits),
            &mut fonts,
        )
        .unwrap();
        let footer_top =
            |track: &TrackScene| track.content_bottom() + track.footer.as_ref().unwrap().inset;
        let estimated = footer_top(&track);
        let mut grew = false;
        let mut offset = 0.0;
        for row in &track.cached {
            offset += row.height;
        }
        assert!((estimated - offset - track.footer.as_ref().unwrap().inset).abs() < 1e-9);
        for scroll in [0.0, track.max_scroll() / 2.0, track.max_scroll()] {
            track.prepare_viewport(scroll).unwrap();
            let sum: f64 = track.cached.iter().map(|row| row.height).sum();
            let last = track.lines.len() - 1;
            assert!((track.row_top(last) + track.cached[last].height - sum).abs() < 1e-6);
            assert!(
                footer_top(&track) >= estimated,
                "wrapped rows grow past the lazy estimate"
            );
            assert!(
                footer_top(&track) >= track.row_top(last) + track.cached[last].height,
                "footer must stay below the final lyric row"
            );
            let tail = track.footer.as_ref().unwrap().tail;
            let expected = (track.scroll_anchor() + sum + tail - f64::from(track.height)
                + crate::ACTIVE_RANGE_BOTTOM_PADDING)
                .max(track.row_top(last));
            assert!(
                (track.max_scroll() - expected).abs() < 1e-6,
                "max scroll must follow measured content plus footer tail"
            );
            grew |= footer_top(&track) > estimated + 1e-6;
        }
        assert!(grew, "fixture must grow past the lazy estimate");
    }

    #[test]
    fn credits_footer_draw_path_stays_below_final_row_after_growth() {
        let settings = Settings {
            style: Style::Spicy,
            font_scale: 1.0,
            landscape: false,
        };
        let credits = crate::live::Credits {
            songwriters: vec!["A".into()],
            attribution: None,
        };
        let mut fonts = fonts();
        let mut track = TrackScene::with_fonts_credits(
            source(40),
            200,
            640,
            1.0,
            Some(&settings),
            Some(&credits),
            &mut fonts,
        )
        .unwrap();
        for scroll in [0.0, track.max_scroll() / 2.0, track.max_scroll()] {
            track.prepare_viewport(scroll).unwrap();
            let footer = track.footer.as_ref().unwrap();
            let y = track.footer_y(footer, track.scroll_anchor(), scroll, 0.0);
            let mut scene = vello::Scene::new();
            let Some((top, _)) =
                footer.draw(&mut scene, y, track.width, f64::from(track.height), 1.0)
            else {
                assert!(
                    scroll < track.max_scroll(),
                    "footer must be drawn at the final scroll"
                );
                continue;
            };
            let last = track.lines.len() - 1;
            let row_bottom =
                track.scroll_anchor() + track.row_top(last) + track.cached[last].height - scroll;
            assert!(
                top >= row_bottom - 1e-6,
                "drawn footer top {top} overlaps final row bottom {row_bottom}"
            );
        }
    }

    fn cold_return_fixture(
        count: usize,
        start: usize,
        destination: usize,
    ) -> (TrackScene, crate::motion::FollowScroll, f64) {
        cold_return_fixture_with_lines(source(count), start, destination)
    }

    fn cold_return_fixture_with_lines(
        mut lines: Vec<Line>,
        start: usize,
        destination: usize,
    ) -> (TrackScene, crate::motion::FollowScroll, f64) {
        for line in lines.iter_mut().skip(2).step_by(3) {
            line.paint.as_mut().unwrap().translation =
                Some("A longer translated lyric that wraps on a narrow screen. ".repeat(2));
        }
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts()).unwrap();
        let time = track.lines[destination].start + 500.0;
        track.prepare(time).unwrap();
        assert!(!track.geometry_ready((start + destination) / 2));
        let mut scroll = crate::motion::FollowScroll::default();
        scroll.configure(Style::Amll, 1.0, track.lines.len());
        let command = track.scroll_command(time, 0.0);
        scroll.sample(&command, 0.0, true);
        scroll.drag(
            track.row_top(start) - scroll.position(),
            track.max_scroll(),
            640.0,
        );
        crate::ffi::manual_frame_for_test(&mut track, &mut scroll, time, 16.0);
        (track, scroll, time)
    }

    #[test]
    fn continuous_return_prepares_cold_intermediate_rows_at_60_and_120_hz() {
        use crate::ffi::return_frame_for_test;

        for hz in [60, 120] {
            for (start, destination) in [(40, 310), (310, 40)] {
                let (mut track, mut scroll, time) = cold_return_fixture(360, start, destination);
                let mut measurements = Vec::new();
                let mut peak_resident = track.resident.len();
                let mut peak_prepared = 0;
                let mut height_changes = 0;
                let mut intermediate_frames = 0;
                for sample in 0..=hz * 7 / 10 + 1 {
                    let now = 100.0 + f64::from(sample) * 1000.0 / f64::from(hz);
                    let timing = track.return_timing(time);
                    let predicted = crate::ffi::preview_return(&track, &scroll, timing.target, now)
                        .unwrap()
                        .position;
                    let logical_pose = track.return_coordinate(predicted).0;
                    let count = track.plain_preparations;
                    FRAME_WORK.with(|cell| cell.set(FrameWork::default()));
                    let (offset, prep_ms, sampled_ms) = return_frame_for_test(
                        &mut track,
                        &mut scroll,
                        time,
                        || now,
                        || Ok(Some(())),
                    )
                    .expect("a simulated frame must be drawable at every sample");
                    assert_eq!(sampled_ms, now);
                    assert!((track.return_coordinate(offset).0 - logical_pose).abs() < 1e-7);
                    height_changes += FRAME_WORK.with(|cell| cell.get().height_updates);

                    let anchor = track.scroll_anchor();
                    let (interlude, extra) = track.interlude_shift(time);
                    let mut visible = 0;
                    for (row, cached) in track.cached.iter().enumerate() {
                        let top = anchor + track.row_top(row) - offset
                            + interlude.map_or(0.0, |index| if row >= index { extra } else { 0.0 });
                        if top + cached.height >= -40.0 && top <= f64::from(track.height) + 40.0 {
                            assert!(
                                cached.layout_ready(),
                                "unprepared visible row {row} at {now}ms"
                            );
                            assert!(track.resident.contains(&row));
                            visible += 1;
                        }
                    }
                    assert!(visible > 0);
                    assert!(track.geometry_ready(destination));
                    let row = track.first_visible(offset);
                    if row > start.min(destination) + 10 && row < start.max(destination) - 10 {
                        intermediate_frames += 1;
                    }
                    assert!(scroll.row_adjustments().iter().all(|&offset| offset == 0.0));
                    measurements.push(prep_ms);
                    peak_resident = peak_resident.max(track.resident.len());
                    peak_prepared = peak_prepared.max(track.plain_preparations - count);
                    if !scroll.animating() {
                        break;
                    }
                }
                assert!(
                    !scroll.animating(),
                    "fixed target still animating at {hz} Hz from {start} to {destination}, offset={}, target={}, motion={scroll:?}",
                    scroll.position(),
                    track.scroll_target(time)
                );
                assert!((scroll.position() - track.scroll_target(time)).abs() < 1e-7);
                assert!(height_changes > 0 && intermediate_frames > 10);
                assert!(peak_resident < 120 && peak_prepared < 120);
                measurements.sort_unstable_by(f64::total_cmp);
                let n = measurements.len();
                println!(
                    "{hz} Hz {start}->{destination}: peak resident={peak_resident}, \
                     peak prepared/frame={peak_prepared}, preparation median={:.3}ms p95={:.3}ms",
                    measurements[n / 2],
                    measurements[(n * 95 / 100).min(n - 1)],
                );
            }
        }
    }

    #[test]
    fn continuous_return_keeps_the_start_row_on_screen_when_lazy_geometry_changes() {
        use crate::ffi::return_frame_for_test;

        let (mut track, mut scroll, time) = cold_return_fixture(360, 40, 310);
        let row = track.first_visible(scroll.position());
        let estimated_row = row - 1;
        assert!(track.geometry_ready(estimated_row));
        track.cached[estimated_row].height += 80.0;
        for voice in &mut track.cached[estimated_row].voices {
            voice.clear_geometry();
        }
        track.resident.remove(&estimated_row);
        track.prefix.add(estimated_row, 80.0);
        let start = scroll.position() + 80.0;
        scroll.relocate_manual(start, track.max_scroll(), f64::from(track.height));
        let old_top = track.row_top(row);
        let (offset, _, _) =
            return_frame_for_test(&mut track, &mut scroll, time, || 100.0, || Ok(Some(())))
                .unwrap();
        assert!(track.geometry_ready(estimated_row));
        assert!((track.row_top(row) - old_top + 80.0).abs() < 1e-7);
        assert!((track.row_top(row) - offset - (old_top - start)).abs() < 1e-7);
    }

    #[test]
    fn continuous_return_late_height_update_preserves_visible_rows_and_deadline() {
        use crate::ffi::return_frame_for_test;

        let (mut track, mut scroll, time) = cold_return_fixture(360, 40, 310);
        let frame = |track: &mut TrackScene, scroll: &mut crate::motion::FollowScroll, ms| {
            return_frame_for_test(track, scroll, time, || ms, || Ok(Some(())))
                .unwrap()
                .0
        };
        frame(&mut track, &mut scroll, 100.0);
        let before = frame(&mut track, &mut scroll, 792.0);
        let rows = track.return_rows(0.0, before, 0.0);
        let changed = rows.start - 1;
        let relative_tops: Vec<_> = rows
            .clone()
            .map(|row| track.row_top(row) - before)
            .collect();

        // Inject the height update above all visible rows eight milliseconds
        // before the deadline. Its pixel delta belongs to the coordinate map.
        track.cached[changed].height += 80.0;
        track.prefix.add(changed, 80.0);
        let after = frame(&mut track, &mut scroll, 792.0);
        assert!((after - before - 80.0).abs() < 1e-7);
        for (row, old_top) in rows.zip(relative_tops) {
            assert!((track.row_top(row) - after - old_top).abs() < 1e-7);
        }

        let final_offset = frame(&mut track, &mut scroll, 800.0);
        assert!((final_offset - track.scroll_target(time)).abs() < 1e-7);
        assert!(!scroll.animating());
        assert!((final_offset - after).abs() < 16.0);
    }

    #[test]
    fn continuous_return_resize_preserves_the_row_anchor_and_original_deadline() {
        use crate::ffi::{resize_track_scroll, return_frame_for_test};

        let (mut old, mut scroll, time) = cold_return_fixture(360, 40, 310);
        for now in (100..=450).step_by(10) {
            return_frame_for_test(
                &mut old,
                &mut scroll,
                time,
                || f64::from(now),
                || Ok(Some(())),
            )
            .unwrap();
        }
        let row = old.return_anchor_row(scroll.position());
        let old_y = old.painted_row_top(time, row) - scroll.position();
        let mut resized = TrackScene::with_fonts(
            old.lines.clone(),
            650,
            390,
            1.0,
            old.settings.as_ref(),
            &mut fonts(),
        )
        .unwrap();
        resize_track_scroll(&mut scroll, &old, &mut resized, true, time, 1.0).unwrap();
        assert!(resized.plain_preparations < 100);
        assert!(scroll.returning());
        assert!((resized.scroll_anchor() - old.scroll_anchor()).abs() > 19.0);
        assert!((resized.painted_row_top(time, row) - scroll.position() - old_y).abs() < 1e-7);
        let same =
            return_frame_for_test(&mut resized, &mut scroll, time, || 450.0, || Ok(Some(())))
                .unwrap()
                .0;
        assert!((resized.painted_row_top(time, row) - same - old_y).abs() < 1e-7);
        let moving =
            return_frame_for_test(&mut resized, &mut scroll, time, || 460.0, || Ok(Some(())))
                .unwrap()
                .0;
        assert!(moving > same && moving < resized.scroll_target(time));
        let landed =
            return_frame_for_test(&mut resized, &mut scroll, time, || 800.0, || Ok(Some(())))
                .unwrap()
                .0;
        assert!((landed - resized.scroll_target(time)).abs() < 1e-7);
        assert!(!scroll.animating());
    }

    #[test]
    fn return_pixel_velocity_is_continuous_across_unequal_rows() {
        let (mut track, _, _) = cold_return_fixture(360, 40, 310);
        for (row, height) in [(100, 72.0), (101, 152.0)] {
            track.prefix.add(row, height - track.cached[row].height);
            track.cached[row].height = height;
        }
        let row_boundary = 101.0;
        let time_step = 0.001;
        let rows_per_ms = 0.15;
        let center = track.return_offset(row_boundary);
        let left =
            (center - track.return_offset(row_boundary - rows_per_ms * time_step)) / time_step;
        let right =
            (track.return_offset(row_boundary + rows_per_ms * time_step) - center) / time_step;
        let expected = rows_per_ms * 2.0 * 72.0 * 152.0 / (72.0 + 152.0);
        assert!((left - expected).abs() < 0.01, "{left} vs {expected}");
        assert!((right - expected).abs() < 0.01, "{right} vs {expected}");
        let mut previous = track.return_offset(99.0);
        for i in 1..=400 {
            let coordinate = 99.0 + f64::from(i) / 100.0;
            let pixel = track.return_offset(coordinate);
            assert!(pixel > previous);
            assert!((track.return_coordinate(pixel).0 - coordinate).abs() < 1e-8);
            previous = pixel;
        }
    }

    #[test]
    fn continuous_return_packet_reflow_preserves_the_painted_anchor_row_and_deadline() {
        use crate::ffi::{replace_track_scroll, return_frame_for_test};

        let (mut old, mut scroll, time) = cold_return_fixture(360, 40, 310);
        let step =
            |layout: &mut TrackScene, scroll: &mut crate::motion::FollowScroll, native_ms| {
                return_frame_for_test(layout, scroll, time, || native_ms, || Ok(Some(())))
                    .unwrap()
                    .0
            };
        step(&mut old, &mut scroll, 100.0);
        let previous = step(&mut old, &mut scroll, 440.0);
        let dt = 0.0001;
        let before = step(&mut old, &mut scroll, 440.0 + dt);
        let row = old.return_anchor_row(before);
        let old_y = old.painted_row_top(time, row) - before;
        let old_height = old.cached[row].height;
        let mut lines = old.lines().to_vec();
        lines[row].paint.as_mut().unwrap().translation =
            Some("An updated translation that wraps across several measured lines. ".repeat(12));
        let credits = crate::credits_switch_tests::track(Style::Amll, 390, 640, 1.0);
        assert!(credits.footer.is_some());
        let mut next =
            TrackScene::with_fonts(lines, 390, 640, 1.0, old.settings.as_ref(), &mut fonts())
                .unwrap();
        next.footer = credits.footer;
        replace_track_scroll(&mut scroll, Some(&old), &mut next, true, true, time).unwrap();
        assert_eq!(scroll.return_deadline(), Some(800.0));
        assert!(next.cached[row].height - old_height > 80.0);
        let same = step(&mut next, &mut scroll, 440.0 + dt);
        assert!((next.painted_row_top(time, row) - same - old_y).abs() < 1e-7);
        let after = step(&mut next, &mut scroll, 440.0 + 2.0 * dt);
        assert!(
            ((after - same) - (before - previous)).abs() / dt < 0.01,
            "before: {}, after: {}",
            (before - previous) / dt,
            (after - same) / dt
        );
        let landed = step(&mut next, &mut scroll, 800.0);
        assert!((landed - next.scroll_target(time)).abs() < 1e-7);
        assert!(!scroll.animating());
    }

    #[test]
    fn continuous_return_lands_on_line_and_credits_cues_at_the_original_deadline() {
        use crate::ffi::return_frame_with_timeline_for_test;
        use crate::live::Timeline;

        for credits in [false, true] {
            let destination = if credits { 359 } else { 310 };
            let (mut track, mut scroll, _) = cold_return_fixture(360, 40, destination);
            if credits {
                let credits = crate::live::Credits {
                    songwriters: (1..=100).map(|i| format!("Songwriter {i:03}")).collect(),
                    attribution: None,
                };
                track.footer = crate::credits::build(
                    &credits,
                    track.settings.as_ref().unwrap(),
                    track.width,
                    track.scale,
                    &mut fonts(),
                );
            }
            let boundary = track.lines[destination].background_end;
            let mut timeline = Timeline::default();
            timeline.replace(1);
            timeline
                .anchor(1, 1, boundary - 700.0, 100.0, 100.0, true, 1.0)
                .unwrap();
            assert_ne!(
                track.scroll_target(boundary - 8.0),
                track.scroll_target(boundary)
            );
            let frame =
                |track: &mut TrackScene, scroll: &mut crate::motion::FollowScroll, native_ms| {
                    return_frame_with_timeline_for_test(
                        track,
                        scroll,
                        &timeline,
                        || native_ms,
                        || Ok(Some(())),
                    )
                    .unwrap()
                    .0
                };
            frame(&mut track, &mut scroll, 100.0);
            assert_eq!(scroll.return_deadline(), Some(800.0));
            for at in (110..790).step_by(20) {
                frame(&mut track, &mut scroll, f64::from(at));
            }
            let before = frame(&mut track, &mut scroll, 792.0);
            let target_before = track.scroll_target(boundary);
            let landed = frame(&mut track, &mut scroll, 800.0);
            assert!((landed - track.scroll_target(boundary)).abs() < 1e-7);
            assert!(
                (landed - before).abs() < 35.0,
                "credits={credits}, before={before}, target_before={target_before}, landed={landed}"
            );
            let timing = track.return_timing(boundary);
            assert!(track.return_viewport_ready(timing, landed));
            assert!(!scroll.animating());
        }
    }

    #[test]
    fn continuous_return_hands_off_cues_observed_after_the_deadline_to_ordinary_follow() {
        use crate::ffi::return_frame_with_timeline_for_test;
        use crate::live::Timeline;

        for corrected in [false, true] {
            let (mut track, mut scroll, _) = cold_return_fixture(360, 40, 310);
            let cue = track.lines[311].start;
            let mut timeline = Timeline::default();
            timeline.replace(1);
            timeline
                .anchor(1, 1, cue - 704.0, 100.0, 100.0, true, 1.0)
                .unwrap();
            let frame = |track: &mut TrackScene,
                         scroll: &mut crate::motion::FollowScroll,
                         timeline: &Timeline,
                         native_ms| {
                return_frame_with_timeline_for_test(
                    track,
                    scroll,
                    timeline,
                    || native_ms,
                    || Ok(Some(())),
                )
                .unwrap()
                .0
            };
            frame(&mut track, &mut scroll, &timeline, 100.0);
            assert_eq!(scroll.return_deadline(), Some(800.0));
            for native_ms in (116..792).step_by(16) {
                frame(&mut track, &mut scroll, &timeline, f64::from(native_ms));
            }
            let before = frame(&mut track, &mut scroll, &timeline, 792.0);
            let arrival = timeline.position(800.0);
            assert_eq!(arrival, cue - 4.0);
            if corrected {
                timeline
                    .anchor(1, 2, cue + 1.0, 796.0, 796.0, true, 1.0)
                    .unwrap();
                assert!(timeline.position(800.0) > cue);
            }
            assert!(timeline.position(808.0) > cue);
            let handoff = frame(&mut track, &mut scroll, &timeline, 808.0);
            let endpoint = track.scroll_target(arrival);
            let next = track.scroll_target(timeline.position(808.0));
            assert!(next - endpoint > 40.0);
            assert!((handoff - endpoint).abs() < 1e-7);
            assert!((handoff - before).abs() < 35.0);
            assert_eq!(scroll.return_deadline(), None);
            assert!(scroll.animating());

            let moving = frame(&mut track, &mut scroll, &timeline, 824.0);
            assert!(moving > handoff && moving < next);
            assert!(!scroll.returning());
        }
    }

    #[test]
    fn continuous_return_latches_covered_pose_after_a_slow_acquisition() {
        use crate::ffi::return_frame_for_test;

        let (mut track, mut scroll, time) = cold_return_fixture(1_000, 40, 900);
        for ms in (100..400).step_by(10) {
            return_frame_for_test(
                &mut track,
                &mut scroll,
                time,
                || f64::from(ms),
                || Ok(Some(())),
            )
            .unwrap();
        }
        let mut clocks = [400.0, 420.0, 420.0, 440.0].into_iter();
        let mut acquisitions = 0;
        let (position, _, sampled_ms) = return_frame_for_test(
            &mut track,
            &mut scroll,
            time,
            || clocks.next().unwrap(),
            || {
                acquisitions += 1;
                Ok(Some(()))
            },
        )
        .expect("the acquired drawable can present the prepared viewport");
        assert_eq!(acquisitions, 1);
        assert_eq!(sampled_ms, 400.0);

        let timing = track.return_timing(time);
        let late = crate::ffi::preview_return(&track, &scroll, timing.target, 420.0)
            .unwrap()
            .position;
        assert!(!track.return_viewport_ready(timing, late));
        assert!(track.return_viewport_ready(timing, position));
        let anchor = track.return_coordinate(position).0;
        let (repeated, _, _) =
            return_frame_for_test(&mut track, &mut scroll, time, || 400.0, || Ok(Some(())))
                .unwrap();
        assert!((track.return_coordinate(repeated).0 - anchor).abs() < 1e-7);
    }

    #[test]
    fn continuous_return_drawable_stall_across_a_line_cue_keeps_the_prepared_frame() {
        use crate::ffi::{return_frame_for_test, return_frame_with_timeline_for_test};
        use crate::live::Timeline;

        let (mut track, mut scroll, time) = cold_return_fixture(1_000, 40, 900);
        return_frame_for_test(&mut track, &mut scroll, time, || 100.0, || Ok(Some(()))).unwrap();
        let before = track.lines[900].background_end - 8.0;
        let after = before + 20.0;
        assert_ne!(track.preparation_key(before), track.preparation_key(after));
        let mut timeline = Timeline::default();
        timeline.replace(1);
        timeline
            .anchor(1, 1, before, 400.0, 400.0, true, 1.0)
            .unwrap();
        let mut times = [400.0, 420.0].into_iter();
        let (offset, _, sampled) = return_frame_with_timeline_for_test(
            &mut track,
            &mut scroll,
            &timeline,
            || times.next().expect("one acquisition is sufficient"),
            || Ok(Some(())),
        )
        .expect("the prepared pose and playback cue still match");
        assert_eq!(sampled, 400.0);
        let timing = track.return_timing(before);
        assert!(track.return_viewport_ready(timing, offset));
    }

    #[test]
    fn continuous_return_cached_timing_matches_playback_across_gap_and_retention_cues() {
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track = TrackScene::with_fonts(
            long_gap_lines(),
            390,
            640,
            1.0,
            Some(&settings),
            &mut fonts(),
        )
        .unwrap();
        for time in [
            500.0, 501.0, 1_500.0, 2_000.0, 2_001.0, 3_000.0, 3_001.0, 5_499.0, 5_500.0, 5_501.0,
            5_999.0, 6_000.0, 6_001.0, 8_001.0, 500.0,
        ] {
            let timing = track.return_timing(time);
            assert_eq!(timing.key, track.preparation_key(time), "at {time}ms");
            assert_eq!(
                track.resolve_return_target(timing.target),
                track.scroll_target(time),
                "at {time}ms"
            );
        }
    }

    #[test]
    fn immutable_layout_sources_rebuild_indexes_and_keep_the_legacy_gap_command() {
        let mut source = long_gap_lines();
        let old = TrackScene::from_lines(source.clone(), 390, 640, 1.0).unwrap();
        let time = 2_600.0;
        let command = old.scroll_command(time, 0.0);
        let expected = crate::interlude_index(old.lines(), time).unwrap();
        assert_eq!(command.index, expected);
        assert_eq!(
            command.interval,
            old.lines()[expected].start - old.lines()[expected - 1].start
        );
        source.reverse();
        let revised = TrackScene::from_lines(source, 390, 640, 1.0).unwrap();
        for time in [1_500.0, 2_600.0, 5_999.0, 6_001.0, 8_001.0] {
            assert_eq!(revised.window(time), crate::window(revised.lines(), time));
            let focus = crate::focus(revised.lines(), time);
            assert_eq!(revised.scroll_target(time), revised.row_top(focus));
        }
        assert_ne!(old.lines()[0].start, revised.lines()[0].start);
    }

    #[test]
    fn warm_manual_viewport_eviction_invalidates_playback_readiness() {
        let mut lines = source(360);
        lines[0].background_end = lines[310].background_end;
        let time = lines[310].start + 500.0;
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts()).unwrap();
        let manual = track.row_top(40);
        track.prepare_viewport(manual).unwrap();
        let key = track.preparation_key(time);
        track
            .prepare_playback(key, &[track.visible_rows(manual)])
            .unwrap();
        assert!(track.geometry_ready(310));
        let shaped = track.plain_preparations;
        track.prepare_viewport(manual).unwrap();
        assert_eq!(track.plain_preparations, shaped);
        assert!(!track.geometry_ready(310));
        track.prepare(time).unwrap();
        assert!(track.geometry_ready(310));
        let timing = track.return_timing(time);
        assert!(track.return_viewport_ready(timing, track.scroll_target(time)));
    }

    #[test]
    fn ordinary_amll_far_follow_bounds_live_cascade_work() {
        use crate::ffi::{compose_live_frame, return_frame_for_test};
        use crate::motion::FollowScroll;

        for count in [360, 36_000] {
            let mut lines = source(count);
            for line in &mut lines {
                line.paint.as_mut().unwrap().words[0].appearance =
                    Some(crate::typography::WordAppearance {
                        emphasized: false,
                        origin: 0.5,
                        rtl: false,
                        last: true,
                        emphasis: None,
                    });
            }
            let mut track = TrackScene::with_fonts(
                lines,
                390,
                640,
                1.0,
                Some(&Settings {
                    style: Style::Amll,
                    font_scale: 1.0,
                    landscape: false,
                }),
                &mut fonts(),
            )
            .unwrap();
            let mut scroll = FollowScroll::default();
            scroll.configure(Style::Amll, 1.0, count);
            let time = track.lines[count - 50].start + 500.0;
            return_frame_for_test(&mut track, &mut scroll, 500.0, || 0.0, || Ok(Some(()))).unwrap();
            return_frame_for_test(&mut track, &mut scroll, time, || 20.0, || Ok(Some(()))).unwrap();
            assert!(!scroll.returning());
            let mut appearance = crate::appearance::AppearanceState::default();
            let (mut scene, mut overlay) = (Scene::new(), Scene::new());
            for now in [3_000_000.0, 3_000_016.0] {
                scroll.resume(now, 16.0);
                FRAME_WORK.with(|cell| cell.set(FrameWork::default()));
                return_frame_for_test(&mut track, &mut scroll, time, || now, || Ok(Some(())))
                    .unwrap();
                compose_live_frame(
                    &track,
                    &scroll,
                    &mut appearance,
                    (&mut scene, &mut overlay),
                    time,
                    now,
                    (true, 1.0),
                );
                assert!((scroll.position() - track.scroll_target(time)).abs() < 1e-7);
                assert!(!scene.encoding().is_empty());
                let work = FRAME_WORK.with(std::cell::Cell::get);
                assert!(
                    work.cascade_rows > 0 && work.cascade_rows < 60,
                    "{count}: {work:?}"
                );
                assert!(work.geometry_steps < 500, "{count}: {work:?}");
            }
        }
    }

    #[test]
    fn playback_prepares_a_bounded_band_when_active_source_rows_are_far_apart() {
        let mut lines = source(360);
        lines[0].background_end = lines[310].background_end;
        let time = lines[310].start + 500.0;
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts()).unwrap();
        assert_eq!(track.window(time).active(), Some((0, 310)));
        track.prepare(time).unwrap();
        assert!(track.geometry_ready(310));
        assert!(track.plain_preparations < 60);
        assert!(!track.geometry_ready(180));
    }

    #[test]
    fn indexed_timing_matches_source_order_for_overlaps_and_unsorted_gaps() {
        let input = [
            (0.0, 1_500.0),
            (7_000.0, 8_000.0),
            (900.0, 2_200.0),
            (7_000.0, 7_600.0),
            (12_000.0, 12_100.0),
            (3_000.0, 3_500.0),
        ];
        let mut lines = source(input.len());
        for (line, (start, end)) in lines.iter_mut().zip(input) {
            line.start = start;
            line.background_end = end;
        }
        let index = TimingIndex::new(&lines);
        for time in (0..=15_000).step_by(25).map(f64::from).chain(
            index
                .boundaries
                .iter()
                .flat_map(|&time| [time.next_down(), time, time.next_up()]),
        ) {
            let expected = crate::window(&lines, time);
            let mut actual = index.at(time).window;
            if actual.long_pause {
                actual.pause_progress =
                    ((time - actual.pause_start) / actual.pause_duration).clamp(0.0, 1.0);
            }
            assert_eq!(actual, expected, "at {time}ms");
            let focus = expected.focus.max(0) as usize;
            let (first, last) = expected.active().unwrap_or((focus, focus));
            let detail_first = (0..first)
                .rev()
                .find(|&row| lines[row].background_end + 1000.0 < time)
                .map_or(0, |row| row + 1);
            assert_eq!(
                index.at(time).key,
                (focus, detail_first, first, (last + 2).min(lines.len() - 1))
            );
        }
    }

    #[test]
    fn continuous_return_timing_cache_ignores_word_cues() {
        let mut lines = source(360);
        let line = &mut lines[180];
        let time = line.start + 100.0;
        let paint = line.paint.as_mut().unwrap();
        let mut word = paint.words[0].clone();
        word.start = time + 5.0;
        word.end = time + 10.0;
        paint.words = vec![word];
        let settings = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let mut track =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts()).unwrap();
        assert_eq!(track.cues.next(time), Some(time + 5.0));
        let first = track.return_timing(time);
        for at in [time + 5.0, time + 10.0, time + 15.0, time - 1.0] {
            let timing = track.return_timing(at);
            assert_eq!(timing.key, first.key);
            assert_eq!(timing.key, track.preparation_key(at));
            assert_eq!(timing.target.time, at);
        }
        assert_eq!(track.return_timing_misses, 1);
    }

    #[test]
    fn continuous_return_covers_a_late_far_reversal() {
        use crate::ffi::return_frame_for_test;

        for reverse_at in [310, 450, 660] {
            let (mut track, mut scroll, time) = cold_return_fixture(360, 40, 310);
            let reversed = track.lines[40].start + 500.0;
            for ms in (100..=800).step_by(10) {
                let playback = if ms < reverse_at { time } else { reversed };
                let (offset, _, _) = return_frame_for_test(
                    &mut track,
                    &mut scroll,
                    playback,
                    || f64::from(ms),
                    || Ok(Some(())),
                )
                .expect("every sampled return viewport must be drawable");
                let timing = track.return_timing(playback);
                assert!(track.return_viewport_ready(timing, offset), "at {ms}ms");
            }
            assert!((scroll.position() - track.scroll_target(reversed)).abs() < 1e-7);
            assert!(!scroll.animating());
        }
    }

    #[test]
    fn continuous_return_full_live_cpu_work_stays_bounded_across_track_sizes() {
        use crate::ffi::{compose_live_frame, return_frame_for_test};

        for count in [360, 3_600, 36_000] {
            let destination = count - 50;
            let mut lines = source(count);
            let line = &mut lines[destination];
            let paint = line.paint.as_mut().unwrap();
            let word = paint.words[0].clone();
            let text = format!("{} ", word.text).repeat(40);
            paint.words = (0..40)
                .map(|i| PaintWord {
                    offset: (word.text.len() + 1) * i as usize,
                    start: line.start + 480.0 + f64::from(i),
                    end: line.start + 480.5 + f64::from(i),
                    ..word.clone()
                })
                .collect();
            line.text.clone_from(&text);
            line.atoms[0].bytes = 0..text.len();
            paint.text = text;

            let (mut track, mut scroll, time) =
                cold_return_fixture_with_lines(lines, 40, destination);
            let mut appearance = crate::appearance::AppearanceState::default();
            let mut scene = Scene::new();
            let mut overlay = Scene::new();
            let mut step = |native_ms: f64, playback: f64| {
                FRAME_WORK.with(|cell| cell.set(FrameWork::default()));
                return_frame_for_test(
                    &mut track,
                    &mut scroll,
                    playback,
                    || native_ms,
                    || Ok(Some(())),
                )
                .unwrap();
                let (_, schedule) = compose_live_frame(
                    &track,
                    &scroll,
                    &mut appearance,
                    (&mut scene, &mut overlay),
                    playback,
                    native_ms,
                    (true, 1.0),
                );
                assert!(schedule.continuous);
                assert!(!scene.encoding().is_empty());
                FRAME_WORK.with(std::cell::Cell::get)
            };
            step(100.0, time);
            let cold = step(400.0, time);
            eprintln!("{count} cold: {cold:?}");
            assert!(
                cold.height_updates > 0 && cold.preparation_rows > 0,
                "{count}: {cold:?}"
            );
            for i in 1..=8 {
                let warm = step(400.0 + f64::from(i) * 0.0001, time + f64::from(i));
                if i == 1 {
                    eprintln!("{count} warm: {warm:?}");
                }
                assert_eq!(warm.preparation_rows, 0, "{count}: {warm:?}");
                assert_eq!(warm.height_updates, 0);
                for work in [cold, warm] {
                    assert!(work.preparation_rows < 100, "{count}: {work:?}");
                    assert!(work.retention_rows < 250, "{count}: {work:?}");
                    assert!(
                        work.appearance_rows > 0 && work.appearance_rows < 100,
                        "{count}: {work:?}"
                    );
                    assert!(
                        work.schedule_rows > 0 && work.drawing_rows < 80,
                        "{count}: {work:?}"
                    );
                    assert!(work.geometry_steps < 1800, "{count}: {work:?}");
                    assert!(work.timing_steps < 250, "{count}: {work:?}");
                }
            }
        }
    }

    #[test]
    fn continuous_return_warm_preparation_reuses_timing_across_track_sizes() {
        use crate::ffi::return_frame_for_test;

        for count in [360, 3_600, 36_000] {
            let (mut track, mut scroll, time) = cold_return_fixture(count, 40, 310);
            return_frame_for_test(&mut track, &mut scroll, time, || 100.0, || Ok(Some(())))
                .unwrap();
            let misses = track.return_timing_misses;
            let shaped = track.plain_preparations;
            let mut times = Vec::new();
            for sample in 1..=16 {
                let now = 100.0 + f64::from(sample);
                let (_, prep_ms, _) = return_frame_for_test(
                    &mut track,
                    &mut scroll,
                    time + f64::from(sample),
                    || now,
                    || Ok(Some(())),
                )
                .unwrap();
                times.push(prep_ms);
            }
            assert_eq!(
                track.return_timing_misses, misses,
                "warm timing lookups for {count} rows"
            );
            assert_eq!(
                track.plain_preparations, shaped,
                "warm shaping for {count} rows"
            );
            times.sort_unstable_by(f64::total_cmp);
            println!(
                "{count} rows: {} cached frames, no timing scans or shaping, preparation median={:.3}ms p95={:.3}ms",
                times.len(),
                times[times.len() / 2],
                times[times.len() * 95 / 100],
            );
        }
    }

    #[test]
    fn tiny_drag_after_track_switch_and_idle_measures_row_travel() {
        use crate::ffi::{manual_frame_for_test, replace_track_scroll};
        use crate::motion::FollowScroll;

        let data: serde_json::Value =
            serde_json::from_str(include_str!("../test/background-voices.json")).unwrap();
        let packet = crate::live::TrackPacket::parse(
            &serde_json::to_vec(&data["cases"][0]["packet"]).unwrap(),
        )
        .unwrap();
        let prepared_voice = packet
            .lines
            .into_iter()
            .filter_map(|line| line.paint)
            .filter(|voice| voice.end > voice.start)
            .max_by_key(|voice| voice.text.len())
            .expect("styled fixture provides prepared paint");
        let mut lines = source(90);
        for line in lines.iter_mut().skip(1).step_by(2) {
            let mut paint = prepared_voice.clone();
            let start = paint.start;
            let duration = paint.end - start;
            let retime =
                |time: f64| line.start + (time - start) / duration * (line.end - line.start);
            for word in &mut paint.words {
                word.start = retime(word.start);
                word.end = retime(word.end);
                word.appearance = None;
            }
            paint.start = line.start;
            paint.end = line.end;
            line.text.clone_from(&paint.text);
            line.atoms[0].bytes = 0..line.text.len();
            line.paint = Some(paint);
        }

        let row = 40;
        let time = 40_500.0;
        let viewport = 640.0;
        for style in [Style::Amll, Style::Spicy] {
            for (case, warm, estimate_error) in [
                ("cold", false, 0.0),
                ("warm", true, 0.0),
                ("known height error", true, 80.0),
            ] {
                let settings = Settings {
                    style,
                    font_scale: 1.0,
                    landscape: false,
                };
                let mut track = TrackScene::with_fonts(
                    lines.clone(),
                    390,
                    640,
                    1.0,
                    Some(&settings),
                    &mut fonts(),
                )
                .unwrap();
                if warm {
                    for index in 0..=row {
                        track.prepare_viewport(track.row_top(index)).unwrap();
                    }
                }
                track.prepare(time).unwrap();

                // Recreate one cold row with a known estimation error. It is
                // immediately above the viewport and measured on the manual pass.
                if estimate_error > 0.0 {
                    let previous = row - 1;
                    assert!(track.geometry_ready(previous));
                    track.cached[previous].height += estimate_error;
                    for voice in &mut track.cached[previous].voices {
                        voice.clear_geometry();
                    }
                    track.resident.remove(&previous);
                    track.prefix.add(previous, estimate_error);
                }

                let mut scroll = FollowScroll::default();
                scroll.configure(style, 1.0, track.lines.len());
                let old = track.scroll_command(1_100.0, 0.0);
                scroll.sample(&old, 0.0, true);
                replace_track_scroll(&mut scroll, None, &mut track, false, true, time).unwrap();

                let command = track.scroll_command(time, 0.0);
                let displayed = scroll.sample(&command, 100.0, true);
                assert_eq!(command.index, row);
                assert_eq!(displayed, track.row_top(row));
                let old_top = track.row_top(row);
                let max = track.max_scroll();
                scroll.set_manual_bounds(max, viewport);
                track.clear_manual_anchor();
                scroll.drag(5.0, max, viewport);
                let input = scroll.position() - displayed;
                let manual = manual_frame_for_test(&mut track, &mut scroll, time, 60_100.0);
                let viewport_delta = manual - displayed;
                let row_shift = track.row_top(row) - old_top;
                let row_travel = viewport_delta - row_shift;
                let uncorrected_travel = input - row_shift;
                println!(
                    "{style:?} {case}, input={input:+.3}px \
                     viewport_delta={viewport_delta:+.3}px row_shift={row_shift:+.3}px \
                     uncorrected_travel={uncorrected_travel:+.3}px row_travel={row_travel:+.3}px"
                );
                assert!((input - 5.0).abs() < 1e-6);
                assert!((row_travel - 5.0).abs() < 1e-6, "{style:?} {case}");
                if warm {
                    assert!((row_shift + estimate_error).abs() < 1e-6);
                    assert!((uncorrected_travel - (5.0 + estimate_error)).abs() < 1e-6);
                }
            }
        }
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
        let scroll = track.row_top(150);
        track.prepare_viewport(scroll).unwrap();
        assert!(track.geometry_ready(150));
        track.prepare_viewport(track.row_top(150)).unwrap();
        let count = track.plain_preparations;
        track.prepare_viewport(track.row_top(150)).unwrap();
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
        assert!((target - track.row_top(2)).abs() < 1e-9);
        let anchor = track.scroll_anchor();
        let top = anchor + track.row_top(2) - target;
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
    #[ignore = "GPU cold plain-to-detailed lifecycle; requires a GPU adapter"]
    fn cold_plain_to_detailed_promotion_preserves_future_row_pixels() {
        use crate::appearance::{AppearanceState, Effect};
        let mut fonts = fonts();
        for style in [Style::Amll, Style::Spicy] {
            let mut gpu = pollster::block_on(crate::gpu::Gpu::new(390, 640)).unwrap();
            for bottom in [false, true] {
                for blurred in [false, true] {
                    for playing in [false, true] {
                        let settings = Settings {
                            style,
                            font_scale: 1.0,
                            landscape: false,
                        };
                        let mut lines = source(12);
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
                        let mut track = TrackScene::with_fonts(
                            lines,
                            390,
                            640,
                            1.0,
                            Some(&settings),
                            &mut fonts,
                        )
                        .unwrap();
                        track.prepare(999.0).unwrap();
                        let index = 3;
                        let voice = track.cached[index].lead();
                        assert!(voice.layout.is_some() && !voice.detailed && voice.timed.is_none());
                        let layout_address = voice.layout.as_ref().unwrap() as *const _ as usize;
                        let target_y = if bottom { 580.0 } else { 320.0 };
                        let scroll =
                            track.scroll_anchor() + track.row_top(index) + track.cached[index].top
                                - target_y;
                        let height = voice.height;
                        let mut state = AppearanceState::default();
                        state.prepare(&track, 999.0, 1000.0);
                        state.advance(&track, 999.0, 1000.0, playing, Effect::Glow);
                        assert!(
                            state.row(index).is_none(),
                            "baseline must have no timed row owner"
                        );
                        let mut scene = Scene::new();
                        // Isolate the promoted row; activation of another row
                        // at the same cue must not alter its shared blur input.
                        let mut adjust = [10000.0; 12];
                        adjust[index] = 0.0;
                        track.frame_appearance(
                            999.0,
                            scroll,
                            &adjust,
                            &state,
                            &mut scene,
                            Effect::Glow,
                        );
                        let band = if blurred {
                            (-400.0, -300.0)
                        } else {
                            (-1000.0, 1000.0)
                        };
                        gpu.render_appearance(&scene, band, true, true).unwrap();
                        let cold = gpu.read_pixels().unwrap();
                        // Actual next preparation window promotes the already shaped
                        // row: no manual flags, no eager timing before the baseline.
                        let before = track.detailed_preparations;
                        track.prepare(1000.0).unwrap();
                        assert!(track.detailed_preparations > before);
                        let voice = track.cached[index].lead();
                        assert!(voice.detailed && voice.timed.is_some());
                        assert_eq!(
                            layout_address,
                            voice.layout.as_ref().unwrap() as *const _ as usize
                        );
                        state.prepare(&track, 1000.0, 1001.0);
                        assert!(state.row(index).is_some());
                        for frame in 0..4 {
                            state.advance(
                                &track,
                                1000.0,
                                1001.0 + frame as f64 * 16.0,
                                playing,
                                Effect::Glow,
                            );
                            track.frame_appearance(
                                1000.0,
                                scroll,
                                &adjust,
                                &state,
                                &mut scene,
                                Effect::Glow,
                            );
                            gpu.render_appearance(&scene, band, true, true).unwrap();
                            let prepared = gpu.read_pixels().unwrap();
                            let start = ((target_y - 8.0).max(0.0) as usize) * 390 * 4;
                            let end = ((target_y + height + 8.0).min(640.0) as usize) * 390 * 4;
                            assert!(cold[start..end].chunks_exact(4).any(|p| p[3] > 0));
                            let changed = cold[start..end]
                                .iter()
                                .zip(&prepared[start..end])
                                .filter(|(a, b)| a != b)
                                .count();
                            assert_eq!(
                                changed, 0,
                                "{style:?} playing={playing} bottom={bottom} blurred={blurred} frame={frame}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    #[ignore = "GPU interlude draw regression; requires a GPU adapter"]
    fn isolated_interlude_regions_match_skia_parameters() {
        use crate::appearance::{AppearanceState, Effect};
        use sha2::{Digest, Sha256};
        let reference: serde_json::Value =
            serde_json::from_str(include_str!("../test/interlude-reference.json")).unwrap();
        for source in reference["sources"].as_array().unwrap() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(source["path"].as_str().unwrap());
            assert_eq!(
                format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
                source["sha256"].as_str().unwrap()
            );
        }
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
            let mut expected = Scene::new();
            let mut state = AppearanceState::default();
            for sample in reference["frames"].as_array().unwrap() {
                let time = sample["time"].as_f64().unwrap();
                track.prepare(time).unwrap();
                state.prepare(&track, time, time);
                state.advance(&track, time, time, true, Effect::Glow);
                let cached = &track.cached[2];
                let font = cached.size;
                // Put only the dot slot in the middle of the output, away from
                // fades. No lyric/translation ink can satisfy these comparisons.
                let top = 160.0;
                let scroll = track.scroll_anchor() + track.row_top(2) + cached.top - top;
                scene.reset();
                track.draw_interlude_dots(time, scroll, &[], &state, &mut scene);
                expected.reset();
                if style == Style::Amll {
                    let scale = sample["amll"]["scale"].as_f64().unwrap();
                    let outer = sample["rowOpacity"].as_f64().unwrap();
                    assert!(
                        (state.row(2).unwrap().outer - outer).abs() < 1e-9,
                        "row opacity at {time}"
                    );
                    let size = font * 0.5;
                    let gap = font * 0.25 + 4.0;
                    for i in 0..3 {
                        let alpha = sample["amll"]["dots"][i].as_f64().unwrap() * outer;
                        expected.fill(
                            Fill::NonZero,
                            Affine::IDENTITY,
                            crate::timed_scene::encoded(alpha, 0.0, 0.0, 1.0),
                            None,
                            &vello::kurbo::Circle::new(
                                (
                                    cached.x + (size * 0.5 + i as f64 * (size + gap)) * scale,
                                    top + font * 0.4 + size * 0.5,
                                ),
                                size * 0.5 * scale,
                            ),
                        );
                    }
                } else {
                    let dot = track.dot_glyph.as_ref().unwrap();
                    let group_scale = sample["spicy"]["groupScale"].as_f64().unwrap();
                    let group_alpha = sample["spicy"]["groupOpacity"].as_f64().unwrap();
                    let group = crate::interlude::spicy_group(2000.0, 6000.0, time);
                    assert!(
                        (group.0 - group_scale).abs() < 1e-9
                            && (group.1 - group_alpha).abs() < 1e-9
                    );
                    let width = dot.width * 3.0 + 2.88 * 2.0;
                    let ox = cached.x + width * 0.5;
                    let oy = top + dot.height * 0.5;
                    for i in 0..3 {
                        let params = &sample["spicy"]["dots"][i];
                        let values: Vec<f64> = params
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_f64().unwrap())
                            .collect();
                        let actual = state.interlude.dot(i);
                        for (a, b) in [actual.0, actual.1, actual.2, actual.3]
                            .into_iter()
                            .zip(&values)
                        {
                            assert!((a - b).abs() < 1e-9, "Spicy param at {time}");
                        }
                        let (scale, y, glow, alpha) = (values[0], values[1], values[2], values[3]);
                        if group_scale <= 0.001 || group_alpha <= 0.001 {
                            continue;
                        }
                        let cx = cached.x + dot.width * 0.5 + i as f64 * (dot.width + 2.88);
                        let transform = Affine::translate((
                            ox + (cx - ox) * group_scale,
                            oy + y * font * group_scale,
                        )) * Affine::scale(scale * group_scale)
                            * Affine::translate((-dot.width * 0.5, -dot.height * 0.5));
                        expected.push_layer(
                            Fill::NonZero,
                            BlendMode::default(),
                            (group_alpha * alpha).clamp(0.0, 1.0) as f32,
                            transform,
                            &Rect::new(-32.0, -32.0, dot.width + 32.0, dot.height + 32.0),
                        );
                        // Parameter/region check only: reproduce the explicitly
                        // approximate Vello shadow, not a Skia pixel oracle.
                        if glow > 0.0 {
                            expected.draw_blurred_rounded_rect(
                                transform,
                                dot.ink,
                                Color::new([
                                    1.0,
                                    0.0,
                                    0.0,
                                    (0.85 * (glow * 0.9).clamp(0.0, 1.0)) as f32,
                                ]),
                                dot.ink.width().min(dot.ink.height()) * 0.5,
                                (4.0 + 6.0 * glow) / 2.0,
                            );
                        }
                        expected
                            .draw_glyphs(&dot.font)
                            .font_size(dot.size)
                            .transform(transform)
                            .brush(Color::new([1.0, 0.0, 0.0, 0.85]))
                            .draw(Fill::NonZero, [dot.glyph].into_iter());
                        expected.pop_layer();
                    }
                }
                let band = (-1000.0, 1000.0);
                gpu.render_appearance(&scene, band, true, true).unwrap();
                let actual = gpu.read_pixels().unwrap();
                gpu.render_appearance(&expected, band, true, true).unwrap();
                let expected_pixels = gpu.read_pixels().unwrap();
                let delta = actual
                    .iter()
                    .zip(&expected_pixels)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap();
                assert!(delta <= 1, "{style:?} dot-region delta {delta} at {time}");
                if time == 2600.0 {
                    assert!(actual.chunks_exact(4).any(|p| p[3] > 0));
                }
                // Priming-period alpha ratio is compared against the parent
                // Animated.View opacity, independently of breathing/light-up.
                if style == Style::Amll && time > 5500.0 && time < 5750.0 {
                    state.rows.get_mut(&2).unwrap().outer = 1.0;
                    scene.reset();
                    track.draw_interlude_dots(time, scroll, &[], &state, &mut scene);
                    gpu.render_appearance(&scene, band, true, true).unwrap();
                    let full = gpu.read_pixels().unwrap();
                    let sum =
                        |p: &[u8]| p.chunks_exact(4).map(|p| u64::from(p[3])).sum::<u64>() as f64;
                    let ratio = sum(&actual) / sum(&full);
                    let outer = sample["rowOpacity"].as_f64().unwrap();
                    assert!(
                        (ratio - outer).abs() < 0.015,
                        "priming alpha ratio {ratio}, expected {outer}"
                    );
                    state.rows.get_mut(&2).unwrap().outer = outer;
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
        assert!((target - track.row_top(2)).abs() < 1e-9);
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
