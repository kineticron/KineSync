//! Validated live-track protocol and monotonic anchor state, independent of the platform ABI.
use crate::{Atom, Line, clock};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackPacket {
    pub generation: u64,
    pub track_id: String,
    pub lines: Vec<WireLine>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireLine {
    pub start: f64,
    pub end: f64,
    pub atoms: Vec<WireAtom>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireAtom {
    pub text: String,
    pub start: f64,
    pub end: f64,
}
impl TrackPacket {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 2_000_000 {
            return Err("Track packet exceeds 2 MB".into());
        }
        let packet: Self = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if packet.generation == 0
            || packet.track_id.is_empty()
            || packet.track_id.len() > 1024
            || packet.lines.is_empty()
            || packet.lines.len() > 2000
        {
            return Err("Invalid track identity or line count".into());
        }
        let mut previous = 0.0;
        let mut count = 0;
        for line in &packet.lines {
            if line.end <= line.start
                || !valid_interval(line.start, line.end)
                || line.start < previous
                || line.atoms.is_empty()
            {
                return Err("Invalid or unordered line timing".into());
            }
            previous = line.start;
            for atom in &line.atoms {
                count += 1;
                if !valid_interval(atom.start, atom.end)
                    || atom.text.is_empty()
                    || atom.start < line.start
                    || atom.end > line.end
                {
                    return Err("Invalid atom timing or text".into());
                }
            }
        }
        if count > 50_000 {
            return Err("Too many timed atoms".into());
        }
        Ok(packet)
    }
    pub fn into_lines(self) -> Vec<Line> {
        self.lines
            .into_iter()
            .map(|line| {
                let mut text = String::new();
                let atoms = line
                    .atoms
                    .into_iter()
                    .map(|atom| {
                        let start = text.len();
                        text.push_str(&atom.text);
                        Atom {
                            bytes: start..text.len(),
                            start: atom.start,
                            end: atom.end,
                        }
                    })
                    .collect();
                Line {
                    text,
                    start: line.start,
                    end: line.end,
                    atoms,
                }
            })
            .collect()
    }
}
fn valid_interval(start: f64, end: f64) -> bool {
    start.is_finite() && end.is_finite() && start >= 0.0 && end >= start && end <= 86_400_000.0
}
#[derive(Default)]
pub struct Timeline {
    pub generation: u64,
    pub sequence: u64,
    pub position: f64,
    pub native_ms: f64,
    pub playing: bool,
    pub rate: f64,
    pub anchored: bool,
}
impl Timeline {
    pub fn replace(&mut self, generation: u64) -> bool {
        if generation <= self.generation {
            return false;
        }
        *self = Self {
            generation,
            rate: 1.0,
            ..Self::default()
        };
        true
    }
    #[allow(clippy::too_many_arguments, reason = "Shared native anchor protocol")]
    pub fn anchor(
        &mut self,
        generation: u64,
        sequence: u64,
        position: f64,
        sampled_native_ms: f64,
        now_native_ms: f64,
        playing: bool,
        rate: f64,
    ) -> Result<bool, String> {
        if generation != self.generation || sequence <= self.sequence {
            return Ok(false);
        }
        if !position.is_finite()
            || position < 0.0
            || !sampled_native_ms.is_finite()
            || sampled_native_ms < 0.0
            || !now_native_ms.is_finite()
            || sampled_native_ms > now_native_ms + 100.0
            || !rate.is_finite()
            || !(0.0..=4.0).contains(&rate)
        {
            return Err("Invalid playback anchor".into());
        }
        self.sequence = sequence;
        self.position = position;
        self.native_ms = sampled_native_ms;
        self.playing = playing;
        self.rate = rate;
        self.anchored = true;
        Ok(true)
    }
    pub fn position(&self, now_native_ms: f64) -> f64 {
        clock(
            self.position,
            self.native_ms,
            now_native_ms,
            self.playing,
            self.rate,
        )
    }
}
/// Keep a future display target, refresh after worker/acquisition stalls.
pub fn frame_clock(target_ms: f64, sampled_ms: f64, elapsed_ms: f64) -> f64 {
    target_ms.max(sampled_ms + elapsed_ms)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_acquisition_uses_fresh_clock_and_pause_seek_resume() {
        assert_eq!(frame_clock(1008.0, 1000.0, 2.0), 1008.0);
        assert_eq!(frame_clock(1008.0, 1000.0, 40.0), 1040.0);
        let mut t = Timeline::default();
        t.replace(1);
        t.anchor(1, 1, 500.0, 1000.0, 1000.0, true, 1.0).unwrap();
        assert_eq!(t.position(frame_clock(1008.0, 1000.0, 40.0)), 540.0);
        t.anchor(1, 2, 540.0, 1040.0, 1040.0, false, 1.0).unwrap();
        assert_eq!(t.position(frame_clock(1048.0, 1040.0, 100.0)), 540.0);
        t.anchor(1, 3, 20.0, 1140.0, 1140.0, true, 2.0).unwrap();
        assert_eq!(t.position(frame_clock(1148.0, 1140.0, 40.0)), 100.0);
    }
    #[test]
    fn display_target_projects_independently_of_worker_sample_time() {
        let mut t = Timeline::default();
        t.replace(1);
        t.anchor(1, 1, 2000.0, 10000.0, 10003.0, true, 0.5).unwrap();
        assert_eq!(t.position(10008.0), 2004.0); // display target
        assert_eq!(t.position(10003.0), 2001.5); // actual worker sample
        t.anchor(1, 2, 2004.0, 10008.0, 10010.0, false, 0.5)
            .unwrap();
        assert_eq!(t.position(20000.0), 2004.0);
        t.anchor(1, 3, 2004.0, 20000.0, 20000.0, true, 1.5).unwrap();
        assert_eq!(t.position(20008.0), 2016.0);
    }
    #[test]
    fn stale_track_and_anchor_pause_seek_rate() {
        let mut t = Timeline::default();
        assert!(t.replace(2));
        assert!(!t.replace(1));
        assert!(t.anchor(2, 1, 500.0, 1000.0, 1010.0, true, 2.0).unwrap());
        assert_eq!(t.position(1100.0), 700.0);
        assert!(!t.anchor(1, 99, 0.0, 1000.0, 1100.0, true, 1.0).unwrap());
        assert!(!t.anchor(2, 1, 0.0, 1000.0, 1100.0, true, 1.0).unwrap());
        assert!(t.anchor(2, 2, 40.0, 1100.0, 1100.0, false, 1.0).unwrap());
        assert_eq!(t.position(5000.0), 40.0);
        assert!(t.replace(3));
        assert!(!t.anchored);
        assert!(t.anchor(3, 1, 0.0, f64::NAN, 0.0, true, 1.0).is_err());
    }
    #[test]
    fn live_korean_byte_ranges_and_invalid_payload() {
        let packet = br#"{"generation":1,"track_id":"live","lines":[{"start":0,"end":100,"atoms":[{"text":"a ","start":0,"end":40},{"text":"b","start":40,"end":100}]}]}"#;
        let lines = TrackPacket::parse(packet).unwrap().into_lines();
        assert_eq!(lines[0].text, "a b");
        assert_eq!(lines[0].atoms[1].bytes, 2..3);
        assert!(TrackPacket::parse(b"{}").is_err());
        assert!(TrackPacket::parse(&vec![b' '; 2_000_001]).is_err());
        let unicode = String::from_utf8(packet.to_vec())
            .unwrap()
            .replace("a ", "뒤 ");
        let lines = TrackPacket::parse(unicode.as_bytes()).unwrap().into_lines();
        assert_eq!(lines[0].atoms[1].bytes, 4..5);
    }
}
