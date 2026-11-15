//! Source-equivalent Spicy/AMLL timing math (AGPL-3.0-only source helpers).
//! Live integration is controlled by the separately measured appearance policy.
const SPICY_SCALE: Curve = Curve {
    xs: &[0.0, 0.7, 1.0],
    ys: &[0.95, 1.0505, 1.0],
    ks: &[
        0.25273809523809526,
        -0.07476190476190467,
        -0.21511904761904757,
    ],
};
const SPICY_LETTER_SCALE: Curve = Curve {
    xs: &[0.0, 0.7, 1.0],
    ys: &[0.95, 1.175, 1.0],
    ks: &[0.6380952380952383, -0.3119047619047619, -0.719047619047619],
};
const SPICY_Y: Curve = Curve {
    xs: &[0.0, 0.9, 1.0],
    ys: &[0.01, -0.016666666666666666, 0.0],
    ks: &[
        -0.11796296296296298,
        0.14703703703703708,
        0.17648148148148154,
    ],
};
const SPICY_LETTER_Y: Curve = Curve {
    xs: &[0.0, 0.9, 1.0],
    ys: &[0.01, -0.017857142857142856, 0.0],
    ks: &[
        -0.12523809523809526,
        0.15761904761904771,
        0.18904761904761908,
    ],
};
const SPICY_GLOW: Curve = Curve {
    xs: &[0.0, 0.15, 0.6, 1.0],
    ys: &[0.0, 1.0, 1.0, 0.0],
    ks: &[
        7.500000000000002,
        4.999999999999998,
        -2.499999999999999,
        -2.4999999999999996,
    ],
};
use serde::{Deserialize, Serialize};
pub(crate) struct Curve {
    pub(crate) xs: &'static [f64],
    pub(crate) ys: &'static [f64],
    pub(crate) ks: &'static [f64],
}
pub(crate) fn spline(c: &Curve, x: f64) -> f64 {
    let mut i = 1;
    while i < c.xs.len() - 1 && c.xs[i] < x {
        i += 1;
    }
    let dx = c.xs[i] - c.xs[i - 1];
    let t = (x - c.xs[i - 1]) / dx;
    let dy = c.ys[i] - c.ys[i - 1];
    let a = c.ks[i - 1] * dx - dy;
    let b = -c.ks[i] * dx + dy;
    (1.0 - t) * c.ys[i - 1] + t * c.ys[i] + t * (1.0 - t) * (a * (1.0 - t) + b * t)
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Spring {
    pub p: f64,
    pub v: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Springs {
    pub scale: Spring,
    pub y: Spring,
    pub glow: Spring,
}
impl Default for Springs {
    fn default() -> Self {
        Self {
            scale: Spring { p: 0.95, v: 0.0 },
            y: Spring { p: 0.01, v: 0.0 },
            glow: Spring { p: 0.0, v: 0.0 },
        }
    }
}
/// Source spring settling threshold; never used as a redraw/subpixel gating rule.
pub fn spicy_spring(s: Spring, goal: f64, frequency: f64, damping: f64, dt: f64) -> Spring {
    let o = s.p - goal;
    if s.v * s.v <= 1e-4 && o * o <= (1.0_f64 / 3840.0).powi(2) {
        return Spring { p: goal, v: 0.0 };
    }
    let f = frequency * 2.0 * std::f64::consts::PI;
    let q = (-damping * f * dt).exp();
    let c = (1.0 - damping * damping).sqrt();
    let i = (dt * f * c).cos();
    let j = (dt * f * c).sin();
    let z = j / c;
    let y = j / (f * c);
    Spring {
        p: (o * (i + z * damping) + s.v * y) * q + goal,
        v: (s.v * (i - z * damping) - o * z * f) * q,
    }
}
pub fn amll_spring(
    s: Spring,
    goal: f64,
    mass: f64,
    damping: f64,
    stiffness: f64,
    dt: f64,
) -> Spring {
    let delta = goal - s.p;
    if damping / (2.0 * (stiffness * mass).sqrt()) >= 1.0 {
        let f = (stiffness / mass).sqrt();
        let leftover = f * delta - s.v;
        let q = (-f * dt).exp();
        return Spring {
            p: goal - (delta + dt * leftover) * q,
            v: (f * (delta + dt * leftover) - leftover) * q,
        };
    }
    let df = (4.0 * mass * stiffness - damping * damping).sqrt();
    let leftover = (damping * delta - 2.0 * mass * s.v) / df;
    let f = 0.5 * df / mass;
    let d = -0.5 * damping / mass;
    let q = (dt * d).exp();
    let c = (dt * f).cos();
    let sin = (dt * f).sin();
    let displacement = delta * c + leftover * sin;
    Spring {
        p: goal - q * displacement,
        v: -q * (d * displacement - delta * f * sin + leftover * f * c),
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Visual {
    pub scale: f64,
    pub y: f64,
    pub glow: f64,
    pub gradient: f64,
}
#[derive(Clone, Copy)]
pub struct WordSpec {
    pub start: f64,
    pub end: f64,
    pub emphasized: bool,
    pub letters: usize,
}
pub struct WordState {
    spec: WordSpec,
    previous_position: f64,
    pub parent: Springs,
    pub letters: Vec<Springs>,
    pub motion: Visual,
    pub letter_motion: Vec<Visual>,
    pub settled: bool,
}
fn step(previous: Springs, scale: f64, y: f64, glow: f64, dt: f64, snap: bool) -> Springs {
    if snap {
        return Springs {
            scale: Spring { p: scale, v: 0.0 },
            y: Spring { p: y, v: 0.0 },
            glow: Spring { p: glow, v: 0.0 },
        };
    }
    Springs {
        scale: spicy_spring(previous.scale, scale, 0.88, 0.64, dt),
        y: spicy_spring(previous.y, y, 1.45, 0.4, dt),
        glow: spicy_spring(previous.glow, glow, 1.18, 0.56, dt),
    }
}
impl WordState {
    /// Geometry/source invalidation creates a new immutable spec and resets state.
    /// Only emphasized letters need retained motion buffers in the Rust updater.
    pub fn new(spec: WordSpec) -> Self {
        let visual = Visual {
            scale: 0.95,
            y: 0.01,
            glow: 0.0,
            gradient: -0.2,
        };
        Self {
            spec,
            previous_position: -1.0,
            parent: Springs::default(),
            letters: vec![Springs::default(); if spec.emphasized { spec.letters } else { 0 }],
            motion: visual,
            letter_motion: vec![visual; if spec.emphasized { spec.letters } else { 0 }],
            settled: false,
        }
    }
    pub fn spec(&self) -> WordSpec {
        self.spec
    }
    /// Reveal-only stage uses the same source progress without evaluating springs
    /// or allocating motion buffers in the frame loop.
    pub fn advance_fill(&mut self, time: f64) {
        let word = self.spec;
        let end = if word.emphasized {
            word.end - 250.0
        } else {
            word.end
        };
        let p = ((time - word.start) / (end - word.start).max(1.0)).clamp(0.0, 1.0);
        self.motion.gradient = -0.2 + 1.2 * p;
        let duration = (end - word.start) / word.letters.max(1) as f64;
        let active = if time >= word.start && time < end && word.letters > 0 {
            Some((((time - word.start) / duration).floor() as usize).min(word.letters - 1))
        } else {
            None
        };
        for (i, m) in self.letter_motion.iter_mut().enumerate() {
            let start = word.start + i as f64 * duration;
            m.gradient = if time < start {
                -0.2
            } else if time >= start + duration {
                1.0
            } else if active == Some(i) {
                -0.2 + 1.2
                    * (((time - start) / duration).clamp(0.0, 1.0) * std::f64::consts::PI / 2.0)
                        .sin()
            } else {
                -0.2
            };
        }
    }
    pub fn advance(&mut self, time: f64, dt: f64) {
        let word = self.spec;
        let snap = self.previous_position < 0.0
            || time < self.previous_position
            || (time - self.previous_position).abs() > 1000.0;
        let end = if word.emphasized {
            word.end - 250.0
        } else {
            word.end
        };
        let p = ((time - word.start) / (end - word.start).max(1.0)).clamp(0.0, 1.0);
        self.parent = step(
            self.parent,
            spline(&SPICY_SCALE, p),
            spline(&SPICY_Y, p),
            spline(&SPICY_GLOW, p),
            dt,
            snap,
        );
        let duration = (end - word.start) / word.letters.max(1) as f64;
        let active = if time >= word.start && time < end && word.letters > 0 {
            Some((((time - word.start) / duration).floor() as usize).min(word.letters - 1))
        } else {
            None
        };
        let progress = active.map_or(0.0, |i| {
            ((time - word.start - i as f64 * duration) / duration).clamp(0.0, 1.0)
        });
        for (i, (state, motion)) in self
            .letters
            .iter_mut()
            .zip(&mut self.letter_motion)
            .enumerate()
        {
            let letter_start = word.start + i as f64 * duration;
            let sung = time >= letter_start + duration;
            let not_sung = time < letter_start;
            let mut scale = 0.95;
            let mut y = 0.01;
            let mut glow = 0.0;
            if time >= end {
                scale = 1.0;
                y = 0.0;
            } else if let Some(active) = active.filter(|_| !not_sung) {
                let distance = i.abs_diff(active) as f64;
                let falloff = 1.0 / (1.0 + distance.powf(2.8));
                scale += (spline(&SPICY_LETTER_SCALE, progress) - 0.95) * falloff;
                y += (spline(&SPICY_LETTER_Y, progress) - 0.01) * falloff;
                glow = spline(&SPICY_GLOW, progress) / (1.0 + distance * 0.9);
            }
            *state = step(*state, scale, y, glow, dt, snap);
            *motion = Visual {
                scale: state.scale.p,
                y: state.y.p * 2.0,
                glow: state.glow.p,
                gradient: if not_sung {
                    -0.2
                } else if sung {
                    1.0
                } else if active == Some(i) {
                    -0.2 + 1.2 * (progress * std::f64::consts::PI / 2.0).sin()
                } else {
                    -0.2
                },
            };
        }
        let settled = |s: &Springs| s.scale.v == 0.0 && s.y.v == 0.0 && s.glow.v == 0.0;
        self.settled = settled(&self.parent) && self.letters.iter().all(settled);
        self.motion = Visual {
            scale: self.parent.scale.p,
            y: self.parent.y.p,
            glow: self.parent.glow.p,
            gradient: -0.2 + 1.2 * p,
        };
        self.previous_position = time;
    }
}
pub fn bezier(x: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    if x == 0.0 || x == 1.0 {
        return x;
    }
    let mut low: f64 = 0.0;
    let mut high: f64 = 1.0;
    for _ in 0..24 {
        let t = (low + high) / 2.0;
        let bx = 3.0 * (1.0 - t).powi(2) * t * x1 + 3.0 * (1.0 - t) * t * t * x2 + t * t * t;
        if bx < x {
            low = t;
        } else {
            high = t;
        }
    }
    let t = (low + high) / 2.0;
    3.0 * (1.0 - t).powi(2) * t * y1 + 3.0 * (1.0 - t) * t * t * y2 + t * t * t
}
pub fn amll_float(position: f64, start: f64, end: f64, background: bool) -> f64 {
    -0.05
        * if background { 2.0 } else { 1.0 }
        * bezier(
            (position - start) / (end - start).max(1000.0),
            0.0,
            0.0,
            0.58,
            1.0,
        )
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Emphasis {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub glow: f64,
    pub radius: f64,
}
pub fn amll_emphasis(
    position: f64,
    start: f64,
    end: f64,
    index: usize,
    count: usize,
    last: bool,
    background: bool,
) -> Emphasis {
    let mut duration = (end - start).max(1000.0);
    let mut amount = duration / 2000.0;
    amount = if amount > 1.0 {
        amount.sqrt()
    } else {
        amount.powi(3)
    } * 0.6;
    let mut blur = duration / 3000.0;
    blur = if blur > 1.0 {
        blur.sqrt()
    } else {
        blur.powi(3)
    } * 0.5;
    if last {
        amount *= 1.6;
        blur *= 1.5;
        duration *= 1.2;
    }
    amount = amount.min(1.2);
    blur = blur.min(0.8);
    let delay = start + duration / 2.5 / count.max(1) as f64 * index as f64;
    let t = ((position - delay) / duration).clamp(0.0, 1.0);
    let sample = |x: f64| {
        if x < 0.5 {
            bezier(x * 2.0, 0.2, 0.4, 0.58, 1.0)
        } else {
            1.0 - bezier((x - 0.5) * 2.0, 0.3, 0.0, 0.58, 1.0)
        }
    };
    let from = (t * 32.0).floor().max(1.0);
    let to = (from + 1.0).min(32.0);
    let a = sample(from / 32.0);
    let pulse = a + (sample(to / 32.0) - a) * (t * 32.0 - from).clamp(0.0, 1.0);
    let float_t = ((position - delay + 400.0) / (duration * 1.4)).clamp(0.0, 1.0);
    let float_from = (float_t * 32.0).floor().max(1.0);
    let float_to = (float_from + 1.0).min(32.0);
    let float_a = (float_from / 32.0 * std::f64::consts::PI).sin();
    let float = float_a
        + ((float_to / 32.0 * std::f64::consts::PI).sin() - float_a)
            * (float_t * 32.0 - float_from).clamp(0.0, 1.0);
    Emphasis {
        scale: 1.0 + pulse * 0.1 * amount,
        x: -pulse * 0.03 * amount * (count as f64 / 2.0 - index as f64),
        y: -pulse * 0.025 * amount - float * 0.05 * if background { 2.0 } else { 1.0 },
        glow: pulse * blur,
        radius: (blur * 0.3).min(0.3),
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct FloatClock {
    pub active: bool,
    pub release_position: f64,
    pub elapsed: f64,
}
impl Default for FloatClock {
    fn default() -> Self {
        Self {
            active: false,
            release_position: -1.0,
            elapsed: 0.0,
        }
    }
}
impl FloatClock {
    pub fn advance(&mut self, active: bool, position: f64, dt_ms: f64) {
        if active {
            *self = Self {
                active: true,
                release_position: position,
                elapsed: 0.0,
            };
        } else {
            self.elapsed = if self.active {
                dt_ms
            } else {
                self.elapsed + dt_ms
            };
            self.active = false;
        }
    }
    pub fn word_position(&self, position: f64, start: f64, end: f64) -> f64 {
        if self.active {
            position
        } else {
            self.release_position.min(start + (end - start).max(1000.0)) - self.elapsed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn data() -> serde_json::Value {
        serde_json::from_str(include_str!("../test/style-timing.json")).unwrap()
    }
    fn close(actual: &serde_json::Value, expected: &serde_json::Value, max: &mut f64) {
        match expected {
            serde_json::Value::Number(n) => {
                let delta = (actual.as_f64().unwrap() - n.as_f64().unwrap()).abs();
                *max = max.max(delta);
                assert!(
                    delta < 1e-9,
                    "actual {actual} expected {expected}, delta{delta}"
                );
            }
            serde_json::Value::Object(fields) => {
                for (key, value) in fields {
                    close(&actual[key], value, max);
                }
            }
            serde_json::Value::Array(values) => {
                assert_eq!(actual.as_array().unwrap().len(), values.len());
                for (a, b) in actual.as_array().unwrap().iter().zip(values) {
                    close(a, b, max);
                }
            }
            _ => assert_eq!(actual, expected),
        }
    }
    #[test]
    fn reveal_only_stage_matches_the_same_source_goldens() {
        for case in data()["cases"].as_array().unwrap() {
            let w = &case["word"];
            let mut state = WordState::new(WordSpec {
                start: w["start"].as_f64().unwrap(),
                end: w["end"].as_f64().unwrap(),
                emphasized: w["emphasized"].as_bool().unwrap(),
                letters: w["letters"].as_array().unwrap().len(),
            });
            for f in case["frames"].as_array().unwrap() {
                state.advance_fill(f["time"].as_f64().unwrap());
                assert!(
                    (state.motion.gradient - f["motion"]["gradient"].as_f64().unwrap()).abs()
                        < 1e-9
                );
                for (actual, expected) in state
                    .letter_motion
                    .iter()
                    .zip(f["motion"]["letters"].as_array().unwrap())
                {
                    assert!(
                        (actual.gradient - expected["gradient"].as_f64().unwrap()).abs() < 1e-9
                    );
                }
            }
        }
    }
    #[test]
    fn actual_source_word_release_seek_pause_and_variable_dt_goldens() {
        let data = data();
        assert_eq!(
            data["cases"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["frames"].as_array().unwrap().len())
                .sum::<usize>(),
            80
        );
        let mut max_delta = 0.0;
        for case in data["cases"].as_array().unwrap() {
            let word = &case["word"];
            let mut state = WordState::new(WordSpec {
                start: word["start"].as_f64().unwrap(),
                end: word["end"].as_f64().unwrap(),
                emphasized: word["emphasized"].as_bool().unwrap(),
                letters: word["letters"].as_array().unwrap().len(),
            });
            for frame in case["frames"].as_array().unwrap() {
                state.advance(
                    frame["time"].as_f64().unwrap(),
                    frame["dt"].as_f64().unwrap(),
                );
                let mut motion = serde_json::to_value(state.motion).unwrap();
                motion["letters"] = serde_json::to_value(&state.letter_motion).unwrap();
                close(&motion, &frame["motion"], &mut max_delta);
                close(
                    &serde_json::to_value(state.parent).unwrap(),
                    &frame["springs"],
                    &mut max_delta,
                );
                close(
                    &serde_json::to_value(&state.letters).unwrap(),
                    &frame["letters"],
                    &mut max_delta,
                );
                assert_eq!(state.settled, frame["settled"].as_bool().unwrap());
            }
        }
        eprintln!("source Spicy maximum numeric delta: {max_delta}");
    }
    #[test]
    fn actual_source_amll_emphasis_float_and_reversed_release_goldens() {
        let data = data();
        let mut max_delta = 0.0;
        assert_eq!(data["amll"].as_array().unwrap().len(), 168);
        assert_eq!(data["clocks"].as_array().unwrap().len(), 7);
        for frame in data["amll"].as_array().unwrap() {
            let time = frame["time"].as_f64().unwrap();
            let start = frame["start"].as_f64().unwrap();
            let end = frame["end"].as_f64().unwrap();
            let bg = frame["background"].as_bool().unwrap();
            let actual = amll_emphasis(
                time,
                start,
                end,
                frame["index"].as_u64().unwrap() as usize,
                frame["count"].as_u64().unwrap() as usize,
                frame["last"].as_bool().unwrap(),
                bg,
            );
            close(
                &serde_json::to_value(actual).unwrap(),
                &frame["emphasis"],
                &mut max_delta,
            );
            close(
                &serde_json::json!(amll_float(time, start, end, bg)),
                &frame["float"],
                &mut max_delta,
            );
        }
        let mut clock = FloatClock::default();
        for frame in data["clocks"].as_array().unwrap() {
            clock.advance(
                frame["active"].as_bool().unwrap(),
                frame["position"].as_f64().unwrap(),
                frame["dt"].as_f64().unwrap(),
            );
            let actual = serde_json::json!({"active":clock.active,"releasePosition":clock.release_position,"elapsed":clock.elapsed});
            close(&actual, &frame["clock"], &mut max_delta);
            close(
                &serde_json::json!(clock.word_position(
                    frame["position"].as_f64().unwrap(),
                    1000.0,
                    3400.0
                )),
                &frame["word_position"],
                &mut max_delta,
            );
        }
        eprintln!("source AMLL maximum numeric delta: {max_delta}");
    }
    #[test]
    fn motion_update_reuses_all_buffers_with_no_allocations() {
        let mut state = WordState::new(WordSpec {
            start: 1000.0,
            end: 5000.0,
            emphasized: true,
            letters: 40,
        });
        state.advance(1000.0, 0.0);
        let allocations = crate::allocation_probe::measure(|| {
            for i in 0..120 {
                state.advance(1000.0 + i as f64 * 8.333333, 1.0 / 120.0);
            }
        });
        assert_eq!(allocations, 0);
    }
    #[test]
    fn timing_goldens_pin_production_source_and_spline_dependency() {
        use sha2::Digest;
        let data = data();
        assert!(data["sources"].as_array().unwrap().len() >= 4);
        for proof in data["sources"].as_array().unwrap() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(proof["path"].as_str().unwrap());
            assert_eq!(
                format!("{:x}", sha2::Sha256::digest(std::fs::read(path).unwrap())),
                proof["sha256"].as_str().unwrap()
            );
        }
    }
}

#[cfg(test)]
mod spring_tests {
    use super::*;
    #[test]
    fn actual_source_amll_critical_and_underdamped_branches() {
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../test/style-timing.json")).unwrap();
        assert_eq!(data["springs"].as_array().unwrap().len(), 16);
        for sample in data["springs"].as_array().unwrap() {
            let initial: Spring = serde_json::from_value(sample["state"].clone()).unwrap();
            let expected: Spring = serde_json::from_value(sample["expected"].clone()).unwrap();
            let actual = amll_spring(
                initial,
                sample["goal"].as_f64().unwrap(),
                sample["mass"].as_f64().unwrap(),
                sample["damping"].as_f64().unwrap(),
                sample["stiffness"].as_f64().unwrap(),
                sample["dt"].as_f64().unwrap(),
            );
            assert!((actual.p - expected.p).abs() < 1e-12);
            assert!((actual.v - expected.v).abs() < 1e-12);
        }
    }
}
