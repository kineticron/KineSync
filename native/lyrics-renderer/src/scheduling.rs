//! Event-indexed wakeups. Playback projection remains independent of rendering.
use crate::Line;

#[derive(Default)]
pub(crate) struct VisualCues(Vec<f64>);
impl VisualCues {
    pub(crate) fn new(lines: &[Line]) -> Self {
        let mut cues = Vec::new();
        for line in lines {
            cues.extend([
                (line.start - crate::PAUSE_DOTS_EARLY_EXIT_MS).max(0.0),
                line.start,
                line.end,
                line.end.next_up(),
                line.background_end,
                line.background_end.next_up(),
                line.background_end + 1000.0,
                (line.background_end + 1000.0).next_up(),
            ]);
            for voice in line.voices() {
                for word in &voice.words {
                    cues.extend([word.start, word.end]);
                    if word.appearance.as_ref().is_some_and(|a| a.emphasized) {
                        cues.push((word.end - 250.0).max(word.start));
                    }
                }
            }
        }
        cues.sort_unstable_by(f64::total_cmp);
        cues.dedup();
        Self(cues)
    }
    pub(crate) fn next(&self, time: f64) -> Option<f64> {
        self.0
            .get(self.0.partition_point(|cue| *cue <= time))
            .copied()
    }
}

#[derive(Debug)]
pub(crate) struct FrameSchedule {
    #[cfg(any(test, feature = "dev-render-metrics"))]
    pub visible_changes: bool,
    pub continuous: bool,
    pub next_cue: Option<f64>,
}

/// Convert a source cue through the current rate only while playback advances.
pub(crate) fn native_cue(position: f64, native_ms: f64, rate: f64, cue: Option<f64>) -> f64 {
    cue.filter(|cue| *cue > position)
        .filter(|_| rate > 0.0)
        .map_or(-1.0, |cue| native_ms + (cue - position) / rate)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cues_preserve_unsorted_overlaps_strict_end_boundaries_seek_and_rate() {
        let mut lines = crate::fixture().unwrap();
        lines.truncate(3);
        lines.swap(0, 2);
        lines[1].background_end = lines[0].end + 2000.0;
        let cues = VisualCues::new(&lines);
        for line in &lines {
            assert_eq!(cues.next(line.start - 0.001), Some(line.start));
            assert_eq!(cues.next(line.end), Some(line.end.next_up()));
            assert_eq!(
                cues.next(line.background_end),
                Some(line.background_end.next_up())
            );
        }
        let first = lines
            .iter()
            .map(|l| l.start - 500.0)
            .min_by(f64::total_cmp)
            .unwrap();
        assert_eq!(cues.next(0.0), Some(first));
        assert_eq!(cues.next(100_000.0), None);
        assert_eq!(native_cue(1000.0, 5000.0, 2.0, Some(1600.0)), 5300.0);
        assert_eq!(native_cue(1000.0, 5000.0, 0.5, Some(1600.0)), 6200.0);
        assert_eq!(native_cue(1000.0, 5000.0, 0.0, Some(1600.0)), -1.0);
        assert_eq!(native_cue(1600.0, 5000.0, 1.0, Some(1600.0)), -1.0);
    }
}
