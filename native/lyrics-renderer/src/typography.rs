//! Static preparation only: explicit font ownership, source style geometry and wrap policy.
//! AMLL balance costs follow amll-reference-line-break.ts (AGPL-3.0-only).
use parley::{FontContext, FontData};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use skrifa::{FontRef, MetadataProvider, raw::TableProvider, string::StringId};
use std::{collections::HashMap, ops::Range};

pub const BUNDLED_FONT_HASHES: [&str; 2] = [
    "71a2162c852e87baa6440c983e406283391646778c8bc74e57b00613a3412f80",
    "a981001f6d4e70292fd26fa8e05437c4a9f0f8c5981027ff0ceead01bb30311f",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Spicy,
    Amll,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub style: Style,
    pub font_scale: f32,
    pub landscape: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaintWord {
    pub text: String,
    pub offset: usize,
    pub start: f64,
    pub end: f64,
    pub joined: bool,
    pub gap_after: bool,
    pub group: Option<u32>,
    pub graphemes: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaintVoice {
    pub text: String,
    pub words: Vec<PaintWord>,
    /// UTF16 offsets from actual app Intl.Segmenter + isCJK helper. No custom segmenter.
    pub cjk_breaks: Vec<usize>,
    pub opposite: bool,
    pub duet: bool,
}
/// UTF16 is the shared JS protocol index, UTF8 is Parley's index. Reject surrogate interiors.
pub fn byte_index(text: &str, utf16: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == utf16 {
            return Ok(byte);
        }
        units += ch.len_utf16();
        if units > utf16 {
            return Err("UTF16 index splits a surrogate pair".into());
        }
    }
    if units == utf16 {
        Ok(text.len())
    } else {
        Err("UTF16 index outside text".into())
    }
}
impl PaintVoice {
    pub fn validate(&self, start: f64, end: f64) -> Result<(), String> {
        if self.text.len() > 100_000 || self.words.is_empty() || self.words.len() > 5000 {
            return Err("Invalid prepared voice size".into());
        }
        let mut previous = 0;
        let segmenter = icu_segmenter::GraphemeClusterSegmenter::new();
        for word in &self.words {
            let byte = byte_index(&self.text, word.offset)?;
            if byte < previous
                || !self.text[byte..].starts_with(&word.text)
                || word.text.is_empty()
                || !word.start.is_finite()
                || !word.end.is_finite()
                || word.start < start
                || word.end > end + 1.0
                || word.end < word.start
                || (word.graphemes.concat() != word.text.trim()
                    && word.graphemes.concat() != word.text)
            {
                return Err("Invalid prepared word text, grapheme mapping or timing".into());
            }
            let joined = word.graphemes.concat();
            let boundaries: Vec<_> = segmenter.segment_str(&joined).collect();
            let expected: Vec<_> = boundaries.windows(2).map(|p| &joined[p[0]..p[1]]).collect();
            if expected
                != word
                    .graphemes
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
            {
                return Err("Prepared graphemes disagree with ICU segmentation".into());
            }
            if word.gap_after
                && self
                    .text
                    .get(byte + word.text.len()..byte + word.text.len() + 1)
                    != Some(" ")
            {
                return Err("Prepared gap is missing from source paint text".into());
            }
            previous = byte + word.text.len();
        }
        for &offset in &self.cjk_breaks {
            byte_index(&self.text, offset)?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Face {
    pub sha256: String,
    pub collection_index: u32,
    pub family: String,
    pub subfamily: String,
    pub postscript: String,
}
#[derive(Clone)]
pub struct Fonts {
    pub context: FontContext,
    pub ready: bool,
    faces: HashMap<(u64, u32), Face>,
}
impl Default for Fonts {
    fn default() -> Self {
        Self {
            context: FontContext::new(),
            ready: false,
            faces: HashMap::new(),
        }
    }
}
impl Fonts {
    pub fn register(&mut self, regular: &[u8], bold: &[u8]) -> Result<(), String> {
        if self.ready {
            return Err("Font set is immutable for this renderer owner".into());
        }
        // Validate both before changing the collection. Existing app assets only.
        for (bytes, digest, weight) in [
            (regular, BUNDLED_FONT_HASHES[0], 400),
            (bold, BUNDLED_FONT_HASHES[1], 700),
        ] {
            if bytes.len() > 16_000_000 || FontRef::new(bytes).is_err() {
                return Err("Invalid bundled font".into());
            }
            if format!("{:x}", Sha256::digest(bytes)) != digest {
                return Err("Bundled font digest/role mismatch".into());
            }
            let font = FontRef::new(bytes).map_err(|e| e.to_string())?;
            if font.os2().map_err(|e| e.to_string())?.us_weight_class() != weight {
                return Err("Bundled font weight mismatch".into());
            }
            if font
                .localized_strings(StringId::FAMILY_NAME)
                .english_or_first()
                .map(|s| s.to_string())
                .as_deref()
                != Some("SF Pro Display")
            {
                return Err("Expected bundled SF Pro Display face".into());
            }
        }
        for bytes in [regular, bold] {
            let registered = self
                .context
                .collection
                .register_fonts(bytes.to_vec().into(), None);
            if registered.is_empty() {
                return Err("Font registration failed".into());
            }
        }
        self.ready = true;
        Ok(())
    }
    pub fn describe(&mut self, font: &FontData) -> Face {
        self.faces
            .entry((font.data.id(), font.index))
            .or_insert_with(|| {
                let parsed = FontRef::from_index(font.data.as_ref(), font.index).ok();
                let name = |id| {
                    parsed
                        .as_ref()
                        .and_then(|f| f.localized_strings(id).english_or_first())
                        .map(|s| s.to_string())
                        .unwrap_or_default()
                };
                Face {
                    sha256: format!("{:x}", Sha256::digest(font.data.as_ref())),
                    collection_index: font.index,
                    family: name(StringId::FAMILY_NAME),
                    subfamily: name(StringId::SUBFAMILY_NAME),
                    postscript: name(StringId::POSTSCRIPT_NAME),
                }
            })
            .clone()
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Geometry {
    pub font_size: f32,
    pub line_height: f32,
    pub weight: f32,
    pub lane_width: f32,
    pub text_width: f32,
    pub x: f32,
    pub row_padding: f32,
    pub right: bool,
}
impl Settings {
    pub fn geometry(&self, width: u32, dpr: f32, voice: &PaintVoice) -> Geometry {
        let w = width as f32 / dpr;
        let spicy = self.style == Style::Spicy;
        let font = (if spicy || self.landscape { 32.0 } else { 36.0 })
            * self.font_scale
            * if spicy { 1.05 } else { 1.0 };
        let line = if spicy {
            44.1 * self.font_scale
        } else {
            (if self.landscape { 32.0 } else { 36.0 }) * 1.2 * self.font_scale
        };
        let padding = if spicy {
            if self.landscape { 14.0 } else { 28.0 }
        } else {
            (if self.landscape { 28.0 } else { 22.0 }) + if w <= 500.0 { 20.0 } else { font }
        };
        let lane = (w - 2.0 * padding).max(1.0)
            * if spicy {
                if self.landscape { 0.9 } else { 0.88 }
            } else {
                1.0
            };
        let text = if spicy {
            lane
        } else if voice.duet {
            lane * 0.85 - font * 0.2
        } else {
            lane - font * 0.4
        };
        let right = if self.landscape {
            !voice.opposite
        } else {
            voice.opposite
        };
        let x = if right {
            w - padding - lane + if spicy { 0.0 } else { lane - text }
        } else {
            padding
        };
        Geometry {
            font_size: font * dpr,
            line_height: line * dpr,
            weight: if spicy { 700.0 } else { 800.0 },
            lane_width: lane * dpr,
            text_width: text.max(1.0) * dpr,
            x: x * dpr,
            row_padding: if spicy { 12.0 * dpr } else { font * 0.4 * dpr },
            right,
        }
    }
}
#[derive(Clone, Debug)]
pub struct WordRange {
    pub bytes: Range<usize>,
    pub start: f64,
    pub end: f64,
    pub gap: bool,
}
fn word_ranges(voice: &PaintVoice, spicy: bool) -> Vec<WordRange> {
    voice
        .words
        .iter()
        .map(|word| {
            let start = byte_index(&voice.text, word.offset).expect("validated UTF16");
            let end = start
                + if spicy {
                    word.text.len()
                } else {
                    word.text.trim_end().len()
                };
            WordRange {
                bytes: start..end,
                start: word.start,
                end: word.end,
                gap: spicy && word.gap_after,
            }
        })
        .collect()
}
/// Layout edits preserve source words/timings separately; newline edits remap byte offsets.
fn edit(voice: &PaintVoice, spicy: bool, edits: &[(usize, usize)]) -> (String, Vec<WordRange>) {
    let mut text = String::new();
    let mut cursor = 0;
    for &(start, end) in edits {
        text.push_str(&voice.text[cursor..start]);
        text.push('\n');
        cursor = end;
    }
    text.push_str(&voice.text[cursor..]);
    let mut words = word_ranges(voice, spicy);
    for word in &mut words {
        let old = word.bytes.start;
        let length = word.bytes.len();
        let mut shift = 0isize;
        for &(start, end) in edits {
            if old < start {
                break;
            }
            if old < end {
                shift += start as isize + 1 - old as isize;
                break;
            }
            shift += 1 - (end - start) as isize;
        }
        let start = old.saturating_add_signed(shift);
        word.bytes = start..start + length;
    }
    (text, words)
}
pub fn wrap(
    voice: &PaintVoice,
    style: Style,
    width: f64,
    measure: impl Fn(Range<usize>) -> f64,
) -> (String, Vec<WordRange>) {
    let spicy = style == Style::Spicy;
    let words = word_ranges(voice, spicy);
    if spicy {
        let mut edits = Vec::new();
        let mut occupied = 0.0;
        for (i, word) in words.iter().enumerate() {
            if voice.words[i].joined && (i == 0 || !voice.words[i - 1].joined) {
                let mut last = i;
                while last < words.len() - 1 && voice.words[last].joined {
                    last += 1;
                }
                let end = words[last].bytes.end + usize::from(words[last].gap);
                let group = measure(word.bytes.start..end);
                if group <= width && occupied > 0.0 && occupied + group > width + 0.01 {
                    edits.push((word.bytes.start, word.bytes.start));
                    occupied = 0.0;
                }
            }
            let end = word.bytes.end + usize::from(word.gap);
            let advance = measure(word.bytes.start..end);
            if occupied > 0.0 && occupied + advance > width + 0.01 {
                edits.push((word.bytes.start, word.bytes.start));
                occupied = 0.0;
            }
            occupied += advance;
        }
        return edit(voice, true, &edits);
    }
    // Same DOM child construction, costs and whitespace edits as production AMLL.
    let mut nodes: Vec<(Range<usize>, bool)> = Vec::new();
    let mut cursor = 0;
    let mut i = 0;
    let append = |nodes: &mut Vec<(Range<usize>, bool)>, start, end| {
        if end > start {
            nodes.push((
                start..end,
                voice.text[start..end].chars().all(char::is_whitespace),
            ));
        }
    };
    while i < words.len() {
        let first = i;
        append(&mut nodes, cursor, words[i].bytes.start);
        while i + 1 < words.len()
            && voice.words[first].group.is_some()
            && voice.words[i + 1].group == voice.words[first].group
        {
            i += 1;
        }
        let end = words[i].bytes.end;
        append(&mut nodes, words[first].bytes.start, end);
        let full_end = words[i].bytes.start + voice.words[i].text.len();
        append(&mut nodes, end, full_end);
        cursor = full_end;
        i += 1;
    }
    append(&mut nodes, cursor, voice.text.len());
    let n = nodes.len();
    let mut prefix = vec![0.0; n + 1];
    for (i, (range, _)) in nodes.iter().enumerate() {
        prefix[i + 1] = prefix[i] + measure(range.clone());
    }
    if prefix[n] <= width {
        return (voice.text.clone(), words);
    }
    let cjk: Vec<_> = voice
        .cjk_breaks
        .iter()
        .map(|&x| byte_index(&voice.text, x).expect("validated CJK boundary"))
        .collect();
    let mut dp = vec![f64::INFINITY; n + 1];
    let mut next = vec![n; n + 1];
    dp[n] = 0.0;
    for i in (0..n).rev() {
        for j in i + 1..=n {
            let w = prefix[j] - prefix[i];
            let cost = if w > width {
                if j == i + 1 {
                    (w - width).powi(2) * 1000.0
                } else {
                    continue;
                }
            } else {
                (width - w).powi(2)
            };
            let penalty = if j == n {
                0.0
            } else {
                let prev = &voice.text[nodes[j - 1].0.clone()];
                if prev.ends_with([
                    ',', '.', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？', '、', '）',
                    '】', '》', '」', '』', '’', '”', ')', '[', ']', '}', '>', '~', '…',
                ]) {
                    -(width * 0.6).powi(2)
                } else if nodes[j - 1].1 {
                    -(width * 0.4).powi(2)
                } else if cjk.contains(&nodes[j].0.start) {
                    (width * 0.15).powi(2)
                } else {
                    (width * 0.5).powi(2)
                }
            };
            if cost + penalty + dp[j] < dp[i] {
                dp[i] = cost + penalty + dp[j];
                next[i] = j;
            }
        }
    }
    let mut edits = Vec::new();
    let mut i = next[0];
    while i < n {
        let offset = nodes[i].0.start;
        let mut start = offset;
        let mut end = offset;
        while let Some(ch) = voice.text[..start].chars().next_back() {
            if ch == '\n' || !ch.is_whitespace() {
                break;
            }
            start -= ch.len_utf8();
        }
        while let Some(ch) = voice.text[end..].chars().next() {
            if ch == '\n' || !ch.is_whitespace() {
                break;
            }
            end += ch.len_utf8();
        }
        if edits.last().is_none_or(|&(_, last)| start > last) {
            edits.push((start, end));
        }
        i = next[i];
    }
    edit(voice, false, &edits)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn voice(text: &str) -> PaintVoice {
        PaintVoice {
            text: text.into(),
            words: vec![PaintWord {
                text: text.into(),
                offset: 0,
                start: 0.0,
                end: 100.0,
                joined: false,
                gap_after: false,
                group: None,
                graphemes: icu_segmenter::GraphemeClusterSegmenter::new()
                    .segment_str(text)
                    .collect::<Vec<_>>()
                    .windows(2)
                    .map(|r| text[r[0]..r[1]].into())
                    .collect(),
            }],
            cjk_breaks: vec![],
            opposite: false,
            duet: false,
        }
    }
    #[test]
    fn utf16_bytes_and_graphemes_preserve_original_unicode() {
        for text in [
            "e\u{301}",
            "👩‍🎤",
            "🇰🇷",
            "क्‍ष",
            "한국어",
            "你好",
            "لا",
            "a \t?!",
        ] {
            let v = voice(text);
            v.validate(0.0, 100.0).unwrap();
            let mut units = 0;
            for (byte, ch) in text.char_indices() {
                assert_eq!(byte_index(text, units).unwrap(), byte);
                if ch.len_utf16() == 2 {
                    assert!(byte_index(text, units + 1).is_err());
                }
                units += ch.len_utf16();
            }
            assert_eq!(byte_index(text, units).unwrap(), text.len());
            assert!(byte_index(text, units + 1).is_err());
        }
        let mut invalid = voice("e\u{301}");
        invalid.words[0].graphemes = vec!["e".into(), "\u{301}".into()];
        assert!(invalid.validate(0.0, 100.0).is_err());
    }
    #[test]
    fn invalid_prepared_ranges_gaps_and_timing_fail_closed() {
        let mut v = voice("👩‍🎤");
        v.words[0].offset = 1;
        assert!(v.validate(0.0, 100.0).is_err());
        let mut v = voice("a");
        v.words[0].gap_after = true;
        assert!(v.validate(0.0, 100.0).is_err());
        let mut v = voice("a");
        v.words[0].end = 101.1;
        assert!(v.validate(0.0, 100.0).is_err());
        let mut v = voice("a");
        v.words[0].start = f64::NAN;
        assert!(v.validate(0.0, 100.0).is_err());
    }
    #[test]
    fn actual_font_roles_immutable_registration_and_invalid_bytes() {
        let regular = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"
        ))
        .unwrap();
        let bold = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"
        ))
        .unwrap();
        let mut fonts = Fonts::default();
        assert!(fonts.register(&bold, &regular).is_err());
        assert!(!fonts.ready);
        assert!(fonts.register(b"bad", &bold).is_err());
        assert!(!fonts.ready);
        fonts.register(&regular, &bold).unwrap();
        assert!(fonts.ready);
        assert!(fonts.register(&regular, &bold).is_err());
    }
    #[test]
    fn style_geometry_insets_alignment_and_physical_scaling() {
        let mut v = voice("a");
        for style in [Style::Spicy, Style::Amll] {
            for landscape in [false, true] {
                let s = Settings {
                    style,
                    font_scale: 1.0,
                    landscape,
                };
                let w = if landscape { 844 } else { 390 };
                let a = s.geometry(w, 1.0, &v);
                let b = s.geometry(w * 3, 3.0, &v);
                assert!((a.text_width * 3.0 - b.text_width).abs() < 0.001);
                assert!((a.x * 3.0 - b.x).abs() < 0.001);
                assert_eq!(a.right, landscape);
                let smaller = Settings {
                    font_scale: 0.9,
                    ..s.clone()
                }
                .geometry(w, 1.0, &v);
                assert!((smaller.font_size - a.font_size * 0.9).abs() < 0.001);
            }
        }
        v.duet = true;
        let s = Settings {
            style: Style::Amll,
            font_scale: 1.0,
            landscape: false,
        };
        let g = s.geometry(390, 1.0, &v);
        assert!((g.text_width - (g.lane_width * 0.85 - g.font_size * 0.2)).abs() < 0.001);
        v.opposite = true;
        assert!(s.geometry(390, 1.0, &v).right);
    }
}

#[cfg(test)]
mod source_policy_tests {
    use super::*;
    #[derive(Deserialize)]
    struct Case {
        name: String,
        style: Style,
        width: f64,
        start: f64,
        end: f64,
        voice: PaintVoice,
        expected_text: String,
        expected_ranges: Vec<Vec<usize>>,
    }
    #[derive(Deserialize)]
    struct SourceProof {
        path: String,
        sha256: String,
    }
    #[derive(Deserialize)]
    struct Cases {
        cases: Vec<Case>,
        sources: Vec<SourceProof>,
    }
    #[test]
    fn production_wrapping_and_unicode_offset_goldens() {
        let cases: Cases =
            serde_json::from_str(include_str!("../test/typography-policy.json")).unwrap();
        use sha2::Digest;
        for source in &cases.sources {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(&source.path);
            let bytes = std::fs::read(path).expect("golden production source exists");
            assert_eq!(
                format!("{:x}", sha2::Sha256::digest(bytes)),
                source.sha256,
                "policy golden source changed: {}",
                source.path
            );
        }
        assert_eq!(cases.cases.len(), 54);
        let segmenter = icu_segmenter::GraphemeClusterSegmenter::new();
        for c in cases.cases {
            c.voice
                .validate(c.start, c.end)
                .unwrap_or_else(|e| panic!("{} {:?}: {e}", c.name, c.style));
            let (text, words) = wrap(&c.voice, c.style, c.width, |range| {
                segmenter
                    .segment_str(&c.voice.text[range])
                    .count()
                    .saturating_sub(1) as f64
            });
            assert_eq!(
                text, c.expected_text,
                "{} {:?} width{}",
                c.name, c.style, c.width
            );
            assert_eq!(
                words
                    .iter()
                    .map(|w| vec![w.bytes.start, w.bytes.end])
                    .collect::<Vec<_>>(),
                c.expected_ranges,
                "{} {:?} offsets",
                c.name,
                c.style
            );
        }
    }
}
