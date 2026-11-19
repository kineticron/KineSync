//! Offline fixture and timing model. Milliseconds, half-open active intervals.
use std::ops::Range;

pub mod ffi;
pub mod gpu;
pub mod live;
pub mod motion;
pub mod scene;

pub const FIXTURE: &str =
    include_str!("../../../DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml");

#[derive(Clone, Debug)]
pub struct Atom {
    pub bytes: Range<usize>,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug)]
pub struct Line {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub atoms: Vec<Atom>,
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
        let mut line = Line {
            text: String::new(),
            start: milliseconds(p.attribute("begin").ok_or("no begin")?)?,
            end: milliseconds(p.attribute("end").ok_or("no end")?)?,
            atoms: Vec::new(),
        };
        // Lead spans only. Background voice spans are a documented future extension.
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
pub fn focus(lines: &[Line], time: f64) -> usize {
    lines
        .partition_point(|line| line.start <= time)
        .saturating_sub(1)
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
        for line in &lines {
            assert!(line.start < line.end);
            for atom in &line.atoms {
                assert!(line.text.get(atom.bytes.clone()).is_some());
                assert!(atom.start <= atom.end);
            }
        }
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
