//! Offline fixture and timing model. Milliseconds, half-open active intervals.
use std::ops::Range;

#[cfg(any(target_os = "android", test))]
mod android_fonts;
pub mod appearance;
mod auxiliary;
mod credits;
pub mod ffi;
pub mod gpu;
mod interlude;
pub mod live;
pub mod motion;
pub mod scene;
mod scheduling;
pub mod style_timing;
mod timed_scene;
pub mod typography;

pub const FIXTURE: &str =
    include_str!("../../../DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml");

#[derive(Clone, Debug, serde::Serialize)]
pub struct Atom {
    pub bytes: Range<usize>,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct Line {
    pub text: String,
    pub start: f64,
    /// Lead vocal end. Word fill and movement stop here.
    pub end: f64,
    /// Package end including background voices (Skia `getBackgroundEndTime`).
    /// Scroll/presentation windows keep a line focused until this time.
    pub background_end: f64,
    pub atoms: Vec<Atom>,
    pub paint: Option<typography::PaintVoice>,
    /// Background vocal voices for this row, in source display order. They are
    /// laid out under the lead inside the same row, exactly like the Skia rows.
    pub backgrounds: Vec<typography::PaintVoice>,
}
impl Line {
    /// Lead voice first, then background voices in source order.
    pub fn voice(&self, index: usize) -> Option<&typography::PaintVoice> {
        if index == 0 {
            self.paint.as_ref()
        } else {
            self.backgrounds.get(index - 1)
        }
    }
    pub fn voice_count(&self) -> usize {
        usize::from(self.paint.is_some()) + self.backgrounds.len()
    }
    /// Every voice of the row in display order, lead first.
    pub fn voices(&self) -> impl Iterator<Item = &typography::PaintVoice> {
        self.paint.iter().chain(self.backgrounds.iter())
    }
}

pub fn milliseconds(value: &str) -> Result<f64, Box<dyn std::error::Error>> {
    let mut seconds = 0.0;
    for part in value.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>()?;
    }
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("invalid timestamp".into());
    }
    Ok(seconds * 1000.0)
}

pub fn fixture() -> Result<Vec<Line>, Box<dyn std::error::Error>> {
    let doc = roxmltree::Document::parse(FIXTURE)?;
    let body = doc
        .descendants()
        .find(|n| n.has_tag_name("body"))
        .ok_or("no body")?;
    let mut lines = Vec::new();
    for p in body.descendants().filter(|n| n.has_tag_name("p")) {
        let start = milliseconds(p.attribute("begin").ok_or("no begin")?)?;
        let end = milliseconds(p.attribute("end").ok_or("no end")?)?;
        let mut line = Line {
            text: String::new(),
            start,
            end,
            background_end: end,
            atoms: Vec::new(),
            paint: None,
            backgrounds: Vec::new(),
        };
        // Lead spans only; this fixture has no background voice spans.
        for child in p.children() {
            if child.is_text() {
                line.text.push_str(child.text().unwrap_or(""));
            } else if child.has_tag_name("span") && child.attribute("begin").is_some() {
                let start = line.text.len();
                for text in child.descendants().filter(|n| n.is_text()) {
                    line.text.push_str(text.text().unwrap_or(""));
                }
                line.atoms.push(Atom {
                    bytes: start..line.text.len(),
                    start: milliseconds(child.attribute("begin").unwrap())?,
                    end: milliseconds(child.attribute("end").ok_or("no atom end")?)?,
                });
            }
        }
        if !line.atoms.is_empty() {
            lines.push(line);
        }
    }
    Ok(lines)
}

pub fn progress(time: f64, start: f64, end: f64) -> f64 {
    if end <= start {
        return if time >= start { 1.0 } else { 0.0 };
    }
    ((time - start) / (end - start)).clamp(0.0, 1.0)
}

/// Latest started line remains focused in gaps; before the song, focus first line.
/// Uses a source-order scan so overlapping/out-of-order starts stay valid.
pub fn focus(lines: &[Line], time: f64) -> usize {
    let mut result = 0;
    for (index, line) in lines.iter().enumerate() {
        if line.start <= time {
            result = index;
        }
    }
    result
}

/// Skia `LONG_PAUSE_THRESHOLD_MS` (lib/lyrics-layout.ts).
pub const LONG_PAUSE_THRESHOLD_MS: f64 = 3000.0;
/// Skia `PAUSE_DOTS_EARLY_EXIT_MS`; dots leave before the next line starts.
pub const PAUSE_DOTS_EARLY_EXIT_MS: f64 = 500.0;
/// Skia `ACTIVE_RANGE_BOTTOM_PADDING` (logical points).
pub const ACTIVE_RANGE_BOTTOM_PADDING: f64 = 24.0;

/// Presentation window copied from native Skia `getPlaybackWindowState`.
/// Indices are source-order; `-1` means none. Background tails count as active
/// because Skia indexes `endTimeByIndex` by `getBackgroundEndTime`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
    pub active_start: i32,
    pub active_end: i32,
    pub focus: i32,
    pub long_pause: bool,
    pub pause_progress: f64,
    pub pause_start: f64,
    pub pause_duration: f64,
    pub pause_after: i32,
    pub pause_before: i32,
}
impl Default for Window {
    fn default() -> Self {
        Self {
            active_start: -1,
            active_end: -1,
            focus: -1,
            long_pause: false,
            pause_progress: 0.0,
            pause_start: 0.0,
            pause_duration: 0.0,
            pause_after: -1,
            pause_before: -1,
        }
    }
}
impl Window {
    /// Earliest/last active source rows, if any.
    pub fn active(&self) -> Option<(usize, usize)> {
        (self.active_start >= 0 && self.active_end >= self.active_start)
            .then_some((self.active_start as usize, self.active_end as usize))
    }
    pub fn focus_index(&self) -> Option<usize> {
        (self.focus >= 0).then_some(self.focus as usize)
    }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

/// Largest source index whose line started at or before `time`.
fn last_started(lines: &[Line], time: f64) -> i32 {
    let mut result = -1;
    for (index, line) in lines.iter().enumerate() {
        if line.start <= time {
            result = index as i32;
        }
    }
    result
}

/// Earliest upcoming start strictly after `time`, preferring source order on ties.
fn first_upcoming(lines: &[Line], time: f64) -> Option<(usize, f64)> {
    let mut result: Option<(usize, f64)> = None;
    for (index, line) in lines.iter().enumerate() {
        if line.start > time && result.is_none_or(|(_, start)| line.start < start) {
            result = Some((index, line.start));
        }
    }
    result
}

/// Skia `getPlaybackWindowState`, generalized to unsorted/overlapping starts by
/// scanning in source order instead of binary-searching the start times.
pub fn window(lines: &[Line], time: f64) -> Window {
    if lines.is_empty() {
        return Window::default();
    }
    // Active package: `start <= time < background_end`. A background tail keeps
    // its own line active, exactly like Skia's `endTimeByIndex` scan.
    let mut active_start = -1;
    let mut active_end = -1;
    let mut covered_end: f64 = 0.0;
    for (index, line) in lines.iter().enumerate() {
        if line.start <= time {
            covered_end = covered_end.max(line.background_end);
            if time < line.background_end {
                if active_start < 0 {
                    active_start = index as i32;
                }
                active_end = index as i32;
            }
        }
    }
    if active_start >= 0 {
        return Window {
            active_start,
            active_end,
            focus: active_start,
            ..Window::default()
        };
    }
    let previous = last_started(lines, time);
    let next = first_upcoming(lines, time);
    if previous >= 0
        && let Some((next_index, next_start)) = next
        && time >= covered_end
        && time < next_start
    {
        let pause_duration = (next_start - covered_end).max(0.0);
        let long = pause_duration >= LONG_PAUSE_THRESHOLD_MS;
        let visual_duration = (pause_duration - PAUSE_DOTS_EARLY_EXIT_MS).max(1.0);
        let show = long && time < covered_end + visual_duration;
        return Window {
            active_start: if show { -1 } else { next_index as i32 },
            active_end: if show { -1 } else { next_index as i32 },
            focus: if show { previous } else { next_index as i32 },
            long_pause: show,
            pause_progress: if show {
                clamp01((time - covered_end) / visual_duration)
            } else {
                0.0
            },
            pause_start: covered_end,
            pause_duration: visual_duration,
            pause_after: if show { previous } else { -1 },
            pause_before: -1,
        };
    }
    if previous < 0
        && let Some((next_index, next_start)) = next
        && time < next_start
    {
        let pause_duration = next_start.max(0.0);
        let long = pause_duration >= LONG_PAUSE_THRESHOLD_MS;
        let visual_duration = (pause_duration - PAUSE_DOTS_EARLY_EXIT_MS).max(1.0);
        let show = long && time < visual_duration;
        return Window {
            focus: next_index as i32,
            long_pause: show,
            pause_progress: if show {
                clamp01(time / visual_duration)
            } else {
                0.0
            },
            pause_start: 0.0,
            pause_duration: visual_duration,
            pause_before: if show { next_index as i32 } else { -1 },
            ..Window::default()
        };
    }
    Window {
        focus: if previous >= 0 { previous } else { -1 },
        ..Window::default()
    }
}

/// Skia `getAutoScrollTargetRange`. Overlap anchors on the earliest active row
/// and keeps the whole active range visible.
pub fn auto_scroll_range(window: &Window) -> Option<(usize, usize)> {
    window.active().map_or_else(
        || window.focus_index().map(|focus| (focus, focus)),
        |(start, end)| Some((start, end)),
    )
}

/// Skia `nativeFollowIndex`: during a long pause follow the interlude row,
/// which is attached to the upcoming lyric in source order.
pub fn interlude_index(lines: &[Line], time: f64) -> Option<usize> {
    let mut covered_end: f64 = 0.0;
    for (index, line) in lines.iter().enumerate() {
        if line.start - covered_end >= LONG_PAUSE_THRESHOLD_MS
            && time >= covered_end
            && time < line.start
        {
            return Some(index);
        }
        covered_end = covered_end.max(line.background_end);
    }
    None
}

pub fn follow_index(lines: &[Line], index: usize, time: f64) -> usize {
    interlude_index(lines, time).unwrap_or(index)
}

/// Native anchor projection; paused anchors do not advance. Seek replaces the anchor.
pub fn clock(position: f64, anchor_ms: f64, now_ms: f64, playing: bool, rate: f64) -> f64 {
    (position
        + if playing {
            (now_ms - anchor_ms).max(0.0) * rate
        } else {
            0.0
        })
    .max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries_and_zero_duration() {
        assert_eq!(progress(9.0, 10.0, 20.0), 0.0);
        assert_eq!(progress(15.0, 10.0, 20.0), 0.5);
        assert_eq!(progress(20.0, 10.0, 20.0), 1.0);
        assert_eq!(progress(10.0, 10.0, 10.0), 1.0);
        assert_eq!(progress(9.0, 10.0, 10.0), 0.0);
    }
    #[test]
    fn real_fixture_ranges_and_focus() {
        let lines = fixture().unwrap();
        assert!(lines.len() > 30);
        assert_eq!(lines[0].start, 11077.0);
        assert_eq!(focus(&lines, 0.0), 0);
        assert_eq!(focus(&lines, lines[1].start), 1);
        assert_eq!(
            focus(&lines, lines.last().unwrap().end + 1000.0),
            lines.len() - 1
        );
        assert!(lines.iter().all(|line| line.background_end == line.end));
        for line in &lines {
            assert!(line.start < line.end);
            for atom in &line.atoms {
                assert!(line.text.get(atom.bytes.clone()).is_some());
                assert!(atom.start <= atom.end);
            }
        }
    }
    fn source(ranges: &[(f64, f64, f64)]) -> Vec<Line> {
        ranges
            .iter()
            .map(|&(start, end, background_end)| Line {
                text: "line".into(),
                start,
                end,
                background_end,
                atoms: vec![Atom {
                    bytes: 0..4,
                    start,
                    end,
                }],
                paint: None,
                backgrounds: Vec::new(),
            })
            .collect()
    }

    #[test]
    fn overlapping_and_out_of_order_starts_keep_source_order() {
        // Two duet lines begin 2 ms before the line above them.
        let lines = source(&[
            (1000.0, 4000.0, 4000.0),
            (5000.0, 8000.0, 8000.0),
            (4998.0, 8000.0, 8000.0),
            (9000.0, 10000.0, 10000.0),
        ]);
        let before = window(&lines, 4999.0);
        assert_eq!(before.active(), Some((2, 2)));
        assert_eq!(auto_scroll_range(&before), Some((2, 2)));
        let overlap = window(&lines, 5000.0);
        assert_eq!(overlap.active(), Some((1, 2)));
        assert_eq!(auto_scroll_range(&overlap), Some((1, 2)));
        assert_eq!(focus(&lines, 5000.0), 2);
        assert_eq!(window(&lines, 9000.0).active(), Some((3, 3)));
    }

    #[test]
    fn skia_window_ranges_pauses_and_song_edges() {
        let lines = source(&[
            (1000.0, 4500.0, 4500.0),
            (3000.0, 5000.0, 5000.0),
            (6500.0, 8000.0, 8000.0),
            (16000.0, 18000.0, 18000.0),
        ]);
        assert_eq!(auto_scroll_range(&window(&lines, 3500.0)), Some((0, 1)));
        assert_eq!(auto_scroll_range(&window(&lines, 4800.0)), Some((1, 1)));
        assert_eq!(auto_scroll_range(&window(&lines, 6000.0)), Some((2, 2)));
        assert_eq!(auto_scroll_range(&window(&lines, 2000.0)), Some((0, 0)));
        let pause = window(&lines, 10000.0);
        assert!(pause.long_pause);
        assert_eq!((pause.pause_start, pause.pause_duration), (8000.0, 7500.0));
        assert_eq!((pause.pause_after, pause.focus), (2, 2));
        assert_eq!(auto_scroll_range(&pause), Some((2, 2)));
        assert!(!window(&lines, 18000.0).long_pause);
        assert_eq!(window(&lines, 18000.0).active(), None);
        assert_eq!(window(&lines, 18000.0).focus, 3);
        assert_eq!(auto_scroll_range(&window(&lines, 18000.0)), Some((3, 3)));
        assert_eq!(
            window(&lines, 18000.0),
            Window {
                focus: 3,
                ..Window::default()
            }
        );
        assert_eq!(window(&lines, 18000.0).pause_before, -1);
        // Long-pause early exit pre-highlights the upcoming lyric.
        assert_eq!(window(&lines, 9500.0).active(), None);
        assert_eq!(window(&lines, 15500.0).active(), Some((3, 3)));
        assert_eq!(window(&lines, 15500.0).focus, 3);
    }

    #[test]
    fn background_tails_hold_the_package_and_start_the_real_interlude() {
        let lines = source(&[
            (1000.0, 2000.0, 6000.0),
            (3500.0, 4000.0, 4000.0),
            (10000.0, 11000.0, 11000.0),
        ]);
        assert_eq!(auto_scroll_range(&window(&lines, 3750.0)), Some((0, 1)));
        assert_eq!(auto_scroll_range(&window(&lines, 4500.0)), Some((0, 0)));
        let pause = window(&lines, 6500.0);
        assert!(pause.long_pause);
        assert_eq!(pause.pause_start, 6000.0);
        assert_eq!(pause.pause_duration, 3500.0);
        assert_eq!(window(&lines, 9500.0).active(), Some((2, 2)));
        assert_eq!(window(&lines, 11000.0).active(), None);
    }

    #[test]
    fn interlude_targets_the_upcoming_source_row() {
        let lines = source(&[(1000.0, 2000.0, 2000.0), (7000.0, 8000.0, 8000.0)]);
        assert_eq!(interlude_index(&lines, 1999.0), None);
        assert_eq!(interlude_index(&lines, 2000.0), Some(1));
        assert_eq!(follow_index(&lines, 0, 6500.0), 1);
        assert_eq!(follow_index(&lines, 0, 6900.0), 1);
        assert_eq!(follow_index(&lines, 0, 7000.0), 0);
        assert_eq!(follow_index(&lines, 1, 8000.0), 1);
        // A background tail is lyrics, not an interlude; the real gap is measured
        // from the end of the whole package.
        let lines = source(&[(1000.0, 2000.0, 5000.0), (7000.0, 8000.0, 8000.0)]);
        assert_eq!(interlude_index(&lines, 4000.0), None);
        assert_eq!(interlude_index(&lines, 6000.0), None);
        let lines = source(&[(1000.0, 2000.0, 5000.0), (10000.0, 11000.0, 11000.0)]);
        assert_eq!(interlude_index(&lines, 6000.0), Some(1));
    }

    #[test]
    fn formats_pause_seek_rate() {
        assert_eq!(milliseconds("01:02.500").unwrap(), 62500.0);
        assert!(milliseconds("NaN").is_err());
        assert_eq!(clock(500.0, 100.0, 200.0, true, 2.0), 700.0);
        assert_eq!(clock(500.0, 100.0, 200.0, false, 2.0), 500.0);
        assert_eq!(clock(20.0, 200.0, 200.0, true, 1.0), 20.0);
    }
}

#[cfg(test)]
pub(crate) mod allocation_probe {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
    };
    #[derive(Clone, Copy, Default, serde::Serialize)]
    pub struct Profile {
        pub allocations: usize,
        pub allocated_bytes: usize,
        pub retained_delta_bytes: isize,
        pub peak_delta_bytes: isize,
    }
    thread_local! {static STATE:Cell<(bool,Profile)>=const {Cell::new((false,Profile {
        allocations: 0, allocated_bytes: 0, retained_delta_bytes: 0, peak_delta_bytes: 0,
    }))};}
    struct Counted;
    fn record(allocated: Option<usize>, delta: isize) {
        let _ = STATE.try_with(|state| {
            let (enabled, mut profile) = state.get();
            if enabled {
                if let Some(bytes) = allocated {
                    profile.allocations += 1;
                    profile.allocated_bytes += bytes;
                }
                profile.retained_delta_bytes += delta;
                profile.peak_delta_bytes =
                    profile.peak_delta_bytes.max(profile.retained_delta_bytes);
                state.set((true, profile));
            }
        });
    }
    // Test-only allocator delegates every pointer/layout unchanged to System.
    unsafe impl GlobalAlloc for Counted {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record(Some(layout.size()), layout.size() as isize);
            unsafe { System.alloc(layout) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            record(Some(layout.size()), layout.size() as isize);
            unsafe { System.alloc_zeroed(layout) }
        }
        unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            record(Some(size), size as isize - layout.size() as isize);
            unsafe { System.realloc(p, layout, size) }
        }
        unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
            record(None, -(layout.size() as isize));
            unsafe { System.dealloc(p, layout) }
        }
    }
    #[global_allocator]
    static ALLOCATOR: Counted = Counted;
    pub fn profile(body: impl FnOnce()) -> Profile {
        STATE.with(|state| state.set((true, Profile::default())));
        body();
        STATE.with(|state| {
            let (_, profile) = state.get();
            state.set((false, Profile::default()));
            profile
        })
    }
    pub fn measure(body: impl FnOnce()) -> usize {
        profile(body).allocations
    }
}

#[cfg(test)]
#[allow(dead_code)]
#[path = "../test/baseline-scene.rs"]
mod baseline_scene;
#[cfg(test)]
mod typography_budget;

#[cfg(test)]
mod appearance_tests;
#[cfg(test)]
mod background_tests;

#[cfg(test)]
mod cold_prepare_tests;
