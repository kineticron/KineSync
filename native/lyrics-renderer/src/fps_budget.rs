//! Ignored host probes for the renderer's CPU scene, offscreen GPU and layout budgets.
use crate::{
    Atom, Line,
    appearance::{AppearanceState, LIVE_EFFECT},
    ffi::{
        compose_live_frame, manual_frame_for_test, resize_track_scroll,
        return_frame_with_timeline_for_test,
    },
    gpu::Gpu,
    live::{Credits, Timeline},
    motion::FollowScroll,
    scene::{FrameWork, LayoutCache, TrackScene, count_frame_work},
    typography::{Fonts, PaintVoice, PaintWord, Settings, Style, WordAppearance},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    hash::{DefaultHasher, Hash, Hasher},
    mem::size_of_val,
    time::Instant,
};
use vello::{
    Scene,
    low_level::vello_encoding::{DrawBeginClip, DrawTag, Encoding, Resolver},
};

const FIXTURE_NAME: &str = "frame-bench English/Spanish verses, 100 repeated rows";
const STEP_MS: f64 = 1000.0 / 120.0;
const PORTRAIT: Extent = Extent {
    name: "portrait_3x",
    width: 1170,
    height: 2100,
    scale: 3.0,
    landscape: false,
};
const REDUCED: Extent = Extent {
    name: "portrait_2x",
    width: 780,
    height: 1400,
    scale: 2.0,
    landscape: false,
};
const LANDSCAPE: Extent = Extent {
    name: "landscape_3x",
    width: 2532,
    height: 1170,
    scale: 3.0,
    landscape: true,
};

#[derive(Clone, Copy, Serialize)]
struct Extent {
    name: &'static str,
    width: u32,
    height: u32,
    scale: f32,
    landscape: bool,
}

fn row(kind: &str, content: Value) {
    println!(
        "FPS_BUDGET {}",
        json!({"schema": 1, "kind": kind, "data": content})
    );
}

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn distribution(samples: impl IntoIterator<Item = f64>) -> Value {
    let mut samples: Vec<_> = samples.into_iter().collect();
    samples.sort_unstable_by(f64::total_cmp);
    if samples.is_empty() {
        return Value::Null;
    }
    let at = |p: usize| samples[(samples.len() * p).div_ceil(100) - 1];
    json!({"n": samples.len(), "sum": samples.iter().sum::<f64>(), "p50": at(50), "p95": at(95), "p99": at(99), "max": at(100)})
}

fn fonts() -> Fonts {
    let mut fonts = Fonts::default();
    fonts
        .register(
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"),
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"),
        )
        .expect("register bundled SF Pro fonts");
    fonts
}

// The existing examples/frame-bench.rs::song(false/true) input. Kept here
// because the example owns a separate global allocator and is a separate crate.
fn song(translated: bool) -> Vec<Line> {
    const VERSES: [(&str, &str); 5] = [
        (
            "We walk slowly through the rain",
            "Caminamos despacio bajo la lluvia",
        ),
        (
            "The city lights disappear behind us",
            "Las luces de la ciudad desaparecen",
        ),
        (
            "Take my hand before morning comes",
            "Toma mi mano antes del amanecer",
        ),
        (
            "The silver moon follows our footsteps",
            "La luna plateada sigue nuestros pasos",
        ),
        (
            "I can feel the evening changing",
            "Siento que la tarde está cambiando",
        ),
    ];
    const WORD_MS: [f64; 7] = [0.0, 300.0, 550.0, 1950.0, 2250.0, 2600.0, 3000.0];

    (0..100u32)
        .map(|index| {
            let (text, translation) = VERSES[index as usize % VERSES.len()];
            let start = f64::from(index * 3000);
            let end = start + 3000.0;
            let mut offset = 0;
            let mut atoms = Vec::new();
            let words = text
                .split_ascii_whitespace()
                .zip(WORD_MS.windows(2))
                .enumerate()
                .map(|(i, (word, interval))| {
                    let last = i == WORD_MS.len() - 2;
                    let word_start = start + interval[0];
                    let word_end = start + interval[1];
                    atoms.push(Atom {
                        bytes: offset..offset + word.len(),
                        start: word_start,
                        end: word_end,
                    });
                    let paint = PaintWord {
                        appearance: Some(WordAppearance {
                            emphasized: i == 2,
                            origin: 0.5,
                            rtl: false,
                            last,
                            emphasis: None,
                        }),
                        text: word.into(),
                        offset,
                        start: word_start,
                        end: word_end,
                        joined: false,
                        gap_after: !last,
                        group: None,
                        graphemes: word.chars().map(|ch| ch.to_string()).collect(),
                    };
                    offset += word.len() + usize::from(!last);
                    paint
                })
                .collect();
            Line {
                text: text.into(),
                start,
                end,
                background_end: end,
                atoms,
                paint: Some(PaintVoice {
                    translation: translated.then(|| translation.into()),
                    start,
                    end,
                    text: text.into(),
                    words,
                    cjk_breaks: Vec::new(),
                    opposite: false,
                    duet: false,
                }),
                backgrounds: Vec::new(),
            }
        })
        .collect()
}

fn settings(style: Style, extent: Extent) -> Settings {
    Settings {
        style,
        font_scale: 1.0,
        landscape: extent.landscape,
    }
}

fn track(
    lines: Vec<Line>,
    style: Style,
    extent: Extent,
    credits: Option<&Credits>,
    fonts: &mut Fonts,
) -> TrackScene {
    TrackScene::with_fonts_credits(
        lines,
        extent.width,
        extent.height,
        extent.scale,
        Some(&settings(style, extent)),
        credits,
        fonts,
    )
    .expect("construct lazy lyric track")
}

fn follow(track: &TrackScene) -> FollowScroll {
    let mut scroll = FollowScroll::default();
    scroll.configure(
        track.style().unwrap(),
        f64::from(track.scale),
        track.lines().len(),
    );
    scroll
}

fn timeline(position: f64, native_ms: f64, playing: bool) -> Timeline {
    let mut timeline = Timeline::default();
    assert!(timeline.replace(1));
    assert!(
        timeline
            .anchor(1, 1, position, native_ms, native_ms, playing, 1.0)
            .unwrap()
    );
    timeline
}

#[derive(Clone, Copy, Default, Serialize)]
struct LayoutWork {
    new_row_layouts: usize,
    detailed_row_builds: usize,
    shaped_glyphs: usize,
    missing_glyphs: usize,
}

impl LayoutWork {
    fn read(track: &TrackScene) -> Self {
        Self {
            new_row_layouts: track.plain_preparations,
            detailed_row_builds: track.detailed_preparations,
            shaped_glyphs: track.glyph_count,
            missing_glyphs: track.missing_glyphs,
        }
    }

    fn since(self, before: Self) -> Self {
        Self {
            new_row_layouts: self.new_row_layouts - before.new_row_layouts,
            detailed_row_builds: self.detailed_row_builds - before.detailed_row_builds,
            shaped_glyphs: self.shaped_glyphs - before.shaped_glyphs,
            missing_glyphs: self.missing_glyphs - before.missing_glyphs,
        }
    }

    fn class(self) -> &'static str {
        if self.new_row_layouts > 0 {
            "new_row_layout"
        } else if self.detailed_row_builds > 0 {
            "detailed_only"
        } else {
            "no_row_build"
        }
    }
}

fn take_frame_work() -> FrameWork {
    let mut counters = FrameWork::default();
    count_frame_work(|work| counters = std::mem::take(work));
    counters
}

fn encoded_bytes(encoding: &Encoding) -> usize {
    let res = &encoding.resources;
    size_of_val(encoding.path_tags.as_slice())
        + size_of_val(encoding.path_data.as_slice())
        + size_of_val(encoding.draw_tags.as_slice())
        + size_of_val(encoding.draw_data.as_slice())
        + size_of_val(encoding.transforms.as_slice())
        + size_of_val(encoding.styles.as_slice())
        + size_of_val(res.color_stops.as_slice())
        + size_of_val(res.glyphs.as_slice())
        + size_of_val(res.glyph_runs.as_slice())
        + size_of_val(res.normalized_coords.as_slice())
        + size_of_val(res.patches.as_slice())
}

#[derive(Clone, Copy, Default, Serialize)]
struct SceneCounts {
    paths_before_glyph_resolution: u32,
    path_segments: u32,
    glyph_runs: usize,
    glyphs: usize,
    gradient_stops: usize,
    layers: usize,
    clip_only_layers: usize,
    max_clip_or_layer_depth: usize,
    encoding_inline_bytes: usize,
}

fn counts(scene: &Scene) -> SceneCounts {
    let enc = scene.encoding();
    let mut cursor = 0;
    let mut depth = 0usize;
    let mut max_depth = 0;
    let mut layers = 0;
    let mut clip_only_layers = 0;
    for &tag in &enc.draw_tags {
        match tag {
            DrawTag::BEGIN_CLIP => {
                depth += 1;
                max_depth = max_depth.max(depth);
                if enc.draw_data[cursor] == DrawBeginClip::CLIP_BLEND_MODE {
                    clip_only_layers += 1;
                } else {
                    layers += 1;
                }
            }
            DrawTag::END_CLIP => depth = depth.checked_sub(1).expect("balanced Vello clips"),
            _ => {}
        }
        // This is DrawMonoid::new's serialized draw-data word count.
        cursor += ((tag.0 >> 2) & 7) as usize;
    }
    assert_eq!(cursor, enc.draw_data.len(), "draw stream words");
    assert_eq!(depth, 0, "frame closed its clip and layer stack");
    SceneCounts {
        paths_before_glyph_resolution: enc.n_paths,
        path_segments: enc.n_path_segments,
        glyph_runs: enc.resources.glyph_runs.len(),
        glyphs: enc.resources.glyphs.len(),
        gradient_stops: enc.resources.color_stops.len(),
        layers,
        clip_only_layers,
        max_clip_or_layer_depth: max_depth,
        encoding_inline_bytes: encoded_bytes(enc),
    }
}

#[derive(Default, Serialize)]
struct PlainPayload {
    rows: usize,
    glyph_runs: usize,
    bytes: usize,
    #[serde(skip)]
    row_keys: Vec<(usize, u64)>,
}

fn plain_payload(
    track: &TrackScene,
    scroll: &FollowScroll,
    appearance: &AppearanceState,
    time: f64,
) -> PlainPayload {
    let (interlude_row, extra) = track.interlude_shift(time);
    let offset = scroll.position();
    let adjust = scroll.row_adjustments();
    let mut total = PlainPayload::default();
    let active = track.window(time).active();
    for (index, top) in track.drawing_rows(time, offset, adjust) {
        let cached = &track.cached[index];
        let line = &track.lines()[index];
        let y = track.scroll_anchor() + top - offset
            + adjust.get(index).copied().unwrap_or(0.0)
            + interlude_row
                .filter(|&row| index >= row)
                .map_or(0.0, |_| extra);
        let state = appearance.row(index);
        let detailed = cached.timed_ready()
            && state.is_some_and(|row| {
                (time >= line.start && time < line.background_end) || row.releasing
            });
        if detailed
            || !cached.layout_ready()
            || y + cached.height < -40.0
            || y > f64::from(track.height) + 40.0
        {
            continue;
        }
        total.rows += 1;
        // Compare only the non-timed lead/backing ink in its placement and
        // alpha state. Translation animation and the frame-wide filter are
        // separate. The caller discards pairs that built new row layouts.
        let mut key = DefaultHasher::new();
        y.to_bits().hash(&mut key);
        appearance.playing().hash(&mut key);
        state
            .map(|row| {
                [
                    row.scale.p.to_bits(),
                    row.outer.to_bits(),
                    row.dark.to_bits(),
                ]
            })
            .hash(&mut key);
        let pre_active = time < line.start
            && active.is_some_and(|(first, last)| (first..=last).contains(&index));
        pre_active.hash(&mut key);
        for (voice_index, voice) in cached.voices.iter().enumerate() {
            let paragraph = if track.style() == Some(Style::Spicy) && time <= line.start {
                voice.idle.as_ref().unwrap_or(&voice.plain)
            } else {
                &voice.plain
            };
            let end = line
                .voice(voice_index)
                .map_or(line.end, |voice| voice.interval().1);
            (time > end).hash(&mut key);
            std::ptr::from_ref(paragraph).hash(&mut key);
            total.bytes += encoded_bytes(paragraph.encoding());
            total.glyph_runs += paragraph.encoding().resources.glyph_runs.len();
        }
        total.row_keys.push((index, key.finish()));
    }
    total
}

#[derive(Default, Serialize)]
struct Pack {
    resolve_pack_ms: f64,
    paths_after_glyph_resolution: u32,
    packed_scene_bytes: usize,
    ramp_bytes: usize,
    atlas_payload_bytes_estimate: usize,
    upload_payload_bytes_estimate: usize,
    #[serde(skip)]
    fingerprint: Option<u64>,
}

fn pack(resolver: &mut Resolver, scene: &Scene) -> Pack {
    // Production Vello starts each recording with a fresh packed Vec.
    let mut bytes = Vec::new();
    let started = Instant::now();
    let (layout, ramps, images) = resolver.resolve(scene.encoding(), &mut bytes);
    let resolve_pack_ms = ms(started);
    let atlas = images
        .images
        .iter()
        .map(|(image, _, _)| image.data.len())
        .sum::<usize>();
    let ramp_bytes = size_of_val(ramps.data);
    let fingerprint = if scene.encoding().draw_tags.contains(&DrawTag::IMAGE) {
        None
    } else {
        let mut hash = DefaultHasher::new();
        bytes.hash(&mut hash);
        ramps.data.hash(&mut hash);
        Some(hash.finish())
    };
    Pack {
        resolve_pack_ms,
        paths_after_glyph_resolution: layout.n_paths,
        packed_scene_bytes: bytes.len(),
        ramp_bytes,
        atlas_payload_bytes_estimate: atlas,
        upload_payload_bytes_estimate: bytes.len() + ramp_bytes + atlas,
        fingerprint,
    }
}

#[derive(Default)]
struct Owner {
    scroll: FollowScroll,
    appearance: AppearanceState,
    lyrics: Scene,
    overlay: Scene,
}

impl Owner {
    fn new(track: &TrackScene) -> Self {
        Self {
            scroll: follow(track),
            ..Default::default()
        }
    }

    fn prepare(
        &mut self,
        track: &mut TrackScene,
        clock: &Timeline,
        now: f64,
        following: bool,
    ) -> Option<f64> {
        if following {
            let (_, prepare_ms, used_time) = return_frame_with_timeline_for_test(
                track,
                &mut self.scroll,
                clock,
                || now,
                || Ok(Some(())),
            )?;
            assert_eq!(
                used_time, now,
                "fixed host clock, immediate fake acquisition"
            );
            Some(prepare_ms)
        } else {
            manual_frame_for_test(track, &mut self.scroll, clock.position(now), now);
            None
        }
    }

    fn compose(&mut self, track: &TrackScene, clock: &Timeline, now: f64) -> ((f32, f32), bool) {
        let (band, schedule) = compose_live_frame(
            track,
            &self.scroll,
            &mut self.appearance,
            (&mut self.lyrics, &mut self.overlay),
            clock.position(now),
            now,
            (clock.playing, clock.rate),
        );
        (band, schedule.continuous)
    }

    fn drag(&mut self, track: &TrackScene, dy: f64) {
        self.scroll
            .drag(dy, track.max_scroll(), f64::from(track.height));
    }
}

#[derive(Serialize)]
struct CpuFrame {
    position_ms: f64,
    offset_px: f64,
    scroll_animating: bool,
    schedule_continuous: bool,
    prepare_and_scroll_ms: f64,
    production_prepare_ms: Option<f64>,
    compose_ms: f64,
    cpu_frame_ms: f64,
    layout: LayoutWork,
    frame_work: String,
    lyrics: SceneCounts,
    footer: SceneCounts,
    plain_paragraph_candidates: PlainPayload,
    lyrics_pack: Pack,
    footer_pack: Pack,
}

fn cpu_frame(
    owner: &mut Owner,
    track: &mut TrackScene,
    clock: &Timeline,
    now: f64,
    following: bool,
    resolver: &mut Resolver,
) -> Result<CpuFrame, f64> {
    take_frame_work();
    let before = LayoutWork::read(track);
    let started = Instant::now();
    let production_prepare_ms = owner.prepare(track, clock, now, following);
    let prepare_and_scroll_ms = ms(started);
    if following && production_prepare_ms.is_none() {
        return Err(prepare_and_scroll_ms);
    }
    let started = Instant::now();
    let (_, schedule_continuous) = owner.compose(track, clock, now);
    let compose_ms = ms(started);
    let frame_work = format!("{:?}", take_frame_work());
    let position_ms = clock.position(now);
    let plain_paragraph_candidates =
        plain_payload(track, &owner.scroll, &owner.appearance, position_ms);
    Ok(CpuFrame {
        position_ms,
        offset_px: owner.scroll.position(),
        scroll_animating: owner.scroll.animating(),
        schedule_continuous,
        prepare_and_scroll_ms,
        production_prepare_ms,
        compose_ms,
        cpu_frame_ms: prepare_and_scroll_ms + compose_ms,
        layout: LayoutWork::read(track).since(before),
        frame_work,
        lyrics: counts(&owner.lyrics),
        footer: counts(&owner.overlay),
        plain_paragraph_candidates,
        lyrics_pack: pack(resolver, &owner.lyrics),
        footer_pack: pack(resolver, &owner.overlay),
    })
}

fn report_cpu_frames(case: Value, frames: &[CpuFrame]) {
    let payload_matches = |pair: &[CpuFrame]| {
        pair[0].lyrics_pack.fingerprint.is_some()
            && pair[0].lyrics_pack.fingerprint == pair[1].lyrics_pack.fingerprint
            && pair[0].footer_pack.fingerprint.is_some()
            && pair[0].footer_pack.fingerprint == pair[1].footer_pack.fingerprint
    };
    let largest_lyrics_encoding = frames
        .iter()
        .max_by_key(|frame| frame.lyrics.encoding_inline_bytes)
        .unwrap();
    let stable_plain = frames
        .windows(2)
        .filter(|pair| pair[1].layout.new_row_layouts == 0)
        .map(|pair| {
            pair[1]
                .plain_paragraph_candidates
                .row_keys
                .iter()
                .filter(|key| pair[0].plain_paragraph_candidates.row_keys.contains(key))
                .count() as f64
        });
    let by_layout: serde_json::Map<String, Value> = ["new_row_layout", "detailed_only", "no_row_build"]
        .into_iter()
        .map(|class| {
            let matches = || frames.iter().filter(|f| f.layout.class() == class);
            (class.into(), json!({
                "prepare_and_scroll_ms": distribution(matches().map(|f| f.prepare_and_scroll_ms)),
                "production_prepare_ms": distribution(matches().filter_map(|f| f.production_prepare_ms)),
                "compose_ms": distribution(matches().map(|f| f.compose_ms)),
            }))
        })
        .collect();
    row(
        "cpu_case",
        json!({
            "case": case,
            "samples": frames.len(),
            "cpu_frame_ms": distribution(frames.iter().map(|f| f.cpu_frame_ms)),
            "prepare_and_scroll_ms": distribution(frames.iter().map(|f| f.prepare_and_scroll_ms)),
            "compose_ms": distribution(frames.iter().map(|f| f.compose_ms)),
            "resolve_pack_both_scenes_ms": distribution(frames.iter().map(|f| f.lyrics_pack.resolve_pack_ms + f.footer_pack.resolve_pack_ms)),
            "upload_payload_bytes_estimate": distribution(frames.iter().map(|f| (f.lyrics_pack.upload_payload_bytes_estimate + f.footer_pack.upload_payload_bytes_estimate) as f64)),
            "plain_paragraph_candidate_rows": distribution(frames.iter().map(|f| f.plain_paragraph_candidates.rows as f64)),
            "plain_paragraph_candidate_inline_bytes": distribution(frames.iter().map(|f| f.plain_paragraph_candidates.bytes as f64)),
            "unchanged_plain_paragraph_rows_estimate_per_adjacent_pair_without_new_layout": distribution(stable_plain),
            "by_layout_work": by_layout,
            "scroll_animating_frames": frames.iter().filter(|f| f.scroll_animating).count(),
            "continuous_schedule_frames": frames.iter().filter(|f| f.schedule_continuous).count(),
            "empty_lyrics_frames": frames.iter().filter(|f| f.lyrics.glyph_runs == 0 && f.lyrics.paths_before_glyph_resolution == 0).count(),
            "adjacent_frames_matching_both_packed_payload_fingerprints": frames.windows(2).filter(|pair| payload_matches(pair)).count(),
            "layout_work_totals": {
                "new_row_layouts": frames.iter().map(|f| f.layout.new_row_layouts).sum::<usize>(),
                "detailed_row_builds": frames.iter().map(|f| f.layout.detailed_row_builds).sum::<usize>(),
                "shaped_glyphs": frames.iter().map(|f| f.layout.shaped_glyphs).sum::<usize>(),
                "missing_glyphs": frames.iter().map(|f| f.layout.missing_glyphs).sum::<usize>(),
            },
            "scene_samples": {
                "first": frames.first().unwrap(),
                "largest_lyrics_encoding": largest_lyrics_encoding,
            }
        }),
    );
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Motion {
    Steady,
    AutoScroll,
    ManualDrag,
    FarReturn,
}

fn cpu_case(fonts: &mut Fonts, style: Style, translated: bool, extent: Extent, motion: Motion) {
    let credits = Credits {
        songwriters: vec!["Audit Fixture".into()],
        ..Default::default()
    };
    let mut track = track(song(translated), style, extent, Some(&credits), fonts);
    let mut owner = Owner::new(&track);
    let mut resolver = Resolver::new();
    let native_start = 100.0;
    let playback_start = match motion {
        Motion::Steady => track.lines()[40].start + 900.0,
        Motion::AutoScroll => track.lines()[41].start - 100.0,
        Motion::ManualDrag => track.lines()[40].start + 600.0,
        Motion::FarReturn => track.lines()[84].start + 600.0,
    };
    let clock = timeline(playback_start, native_start, true);
    // Establish the preceding playback pose. For returns, prepare just the
    // source and destination windows while leaving intermediate rows cold.
    owner
        .prepare(&mut track, &clock, native_start - STEP_MS, true)
        .expect("initial pose");
    owner.compose(&track, &clock, native_start - STEP_MS);
    if matches!(motion, Motion::FarReturn) {
        let travel = track.row_top(8) - owner.scroll.position();
        owner.drag(&track, travel);
        owner.prepare(&mut track, &clock, native_start - STEP_MS, false);
        track.clear_manual_anchor();
        owner.scroll.resume_follow();
        assert!(
            !track.geometry_ready(46),
            "far return should start with cold intermediate rows"
        );
    }
    let start_offset = owner.scroll.position();
    let start_target = track.scroll_target(playback_start);
    let viewport = f64::from(extent.height);
    let mut frames = Vec::new();
    let mut unavailable = Vec::new();
    let mut attempts = 0;
    let following = !matches!(motion, Motion::ManualDrag);
    let far = matches!(motion, Motion::FarReturn);
    if far {
        assert!(
            (start_target - start_offset).abs() > 2.0 * viewport,
            "far return distance"
        );
    }
    for i in 0..if far { 240 } else { 120 } {
        let now = native_start + f64::from(i) * STEP_MS;
        attempts += 1;
        if !following {
            owner.drag(&track, 6.0 * f64::from(extent.scale));
        }
        let frame = match cpu_frame(
            &mut owner,
            &mut track,
            &clock,
            now,
            following,
            &mut resolver,
        ) {
            Ok(frame) => frame,
            Err(prepare_ms) => {
                unavailable.push(prepare_ms);
                continue;
            }
        };
        let landed = far
            && i > 0
            && !frame.scroll_animating
            && (frame.offset_px - track.scroll_target(frame.position_ms)).abs() < 0.1;
        frames.push(frame);
        if landed {
            break;
        }
    }
    let Some(last) = frames.last() else {
        row(
            "case_error",
            json!({
                "style": style, "translated": translated, "extent": extent, "motion": motion,
                "reason": "no drawable prepared with the immediate fake acquisition",
                "unavailable_prepare_and_scroll_ms": distribution(unavailable),
            }),
        );
        return;
    };
    let last_target = track.scroll_target(last.position_ms);
    let landed = (last_target - last.offset_px).abs() < 0.1 && !last.scroll_animating;
    let intermediate = far
        && frames.iter().any(|f| {
            (f.offset_px - start_offset).abs() > viewport
                && (f.offset_px - last.offset_px).abs() > viewport
        });
    report_cpu_frames(
        json!({
            "style": style, "translated": translated, "extent": extent, "motion": motion,
            "start_target_px": start_target, "start_offset_px": start_offset, "end_target_px": last_target,
            "end_offset_px": last.offset_px, "elapsed_sample_span_ms": f64::from(attempts - 1) * STEP_MS,
            "attempts": attempts, "unavailable_prepare_and_scroll_ms": distribution(unavailable),
            "landed": far.then_some(landed), "crossed_intermediate_viewports": far.then_some(intermediate),
        }),
        &frames,
    );
}

#[test]
#[ignore = "host FPS experiment 1: scene CPU and encoded workload"]
fn scene_cpu() {
    row(
        "scope",
        json!({
            "experiment": "scene_cpu", "fixture": FIXTURE_NAME, "sample_hz": 120,
            "actual_path": "prepare_drawable with fake immediate acquisition, live scroll, compose_live_frame and Vello Resolver",
            "limitations": [
                "host test build includes FrameWork counters; excludes native scheduling, capacity polling, drawable acquisition and blur-strength advance",
                "manual helper exposes combined preparation and scroll time",
                "resolver span is standalone CPU resolve and packing, excludes wgpu encode/submit",
                "inline encoding size excludes capacity and heap data behind shared assets; upload estimate includes packed scene, ramps and resolver-reported atlas payload only",
                "plain paragraph payload bytes exclude wrappers and translations; the unchanged subset compares placement and alpha inputs with cached paragraph identity",
                "matching adjacent fingerprints do not account for filter protection bands or blur",
                "fixture has no backing vocals, CJK or bitmap glyph workload; dynamic artwork is outside the Rust host path"
            ]
        }),
    );
    let mut fonts = fonts();
    for extent in [PORTRAIT, LANDSCAPE] {
        for style in [Style::Spicy, Style::Amll] {
            for translated in [false, true] {
                for motion in [
                    Motion::Steady,
                    Motion::AutoScroll,
                    Motion::ManualDrag,
                    Motion::FarReturn,
                ] {
                    row(
                        "case_start",
                        json!({"style": style, "translated": translated, "extent": extent.name, "motion": motion}),
                    );
                    cpu_case(&mut fonts, style, translated, extent, motion);
                }
            }
        }
    }
}

fn gpu_frame(
    gpu: &mut Gpu,
    scene: &Scene,
    band: (f32, f32),
) -> Result<GpuSample, Box<dyn std::error::Error>> {
    let started = Instant::now();
    let stats = gpu.render_appearance(scene, band, true, LIVE_EFFECT.glow())?;
    Ok(GpuSample {
        encode_ms: stats.cpu_encode_ms,
        wait_and_timestamp_readback_ms: stats.wait_readback_ms,
        wall_ms: ms(started),
        gpu_interval_including_queue_gaps_ms: stats.gpu_interval_ms,
    })
}

struct GpuSample {
    encode_ms: f64,
    wait_and_timestamp_readback_ms: f64,
    wall_ms: f64,
    gpu_interval_including_queue_gaps_ms: Option<f64>,
}

fn gpu_distribution(samples: &[GpuSample]) -> Value {
    json!({
        "encode_submit_ms": distribution(samples.iter().map(|s| s.encode_ms)),
        "wall_ms": distribution(samples.iter().map(|s| s.wall_ms)),
        "wait_and_timestamp_readback_ms": distribution(samples.iter().map(|s| s.wait_and_timestamp_readback_ms)),
        "gpu_interval_including_queue_gaps_ms": distribution(samples.iter().filter_map(|s| s.gpu_interval_including_queue_gaps_ms)),
    })
}

#[test]
#[ignore = "host FPS experiment 2: Vulkan offscreen render and shared filter workload"]
fn offscreen_gpu() -> Result<(), Box<dyn std::error::Error>> {
    row(
        "scope",
        json!({
            "experiment": "offscreen_gpu", "fixture": FIXTURE_NAME,
            "actual_path": "Gpu::render_appearance plus live-composed lyric scene and production footer scene",
            "timing_boundaries": {
                "encode_submit_ms": "CPU wall time for both Vello renders, filter command encoding, uniform writes and submissions, including enabled timestamp commands",
                "wall_ms": "host wall time around render_appearance, with scene construction and pixel readback outside the span",
                "wait_and_timestamp_readback_ms": "host time waiting for device completion and optionally mapping timestamp data",
                "gpu_interval_including_queue_gaps_ms": "device timestamp bracket across Vello and filters, including queue gaps and excluding the native surface blit and present"
            },
            "limitations": [
                "Vulkan host adapter, no native surface, presentation, dynamic artwork or phone GPU evidence",
                "visible footer proxy appends the real footer to the sharp scene because the real overlay entry requires a SurfaceTexture or private Gpu method",
                "both variants run the second empty Vello render and the six live filter passes, so the paired delta isolates neither empty-pass savings nor per-pass GPU time",
                "the reduced-resolution case changes pixel extent and DPR together, rebuilding lyric layout and GPU targets and filters",
                "the fixture has no bitmap glyph atlas workload"
            ],
            "empty_footer_candidate_requirements": [
                "the composite reads the persistent overlay texture every frame",
                "after a visible footer, supply freshly cleared transparent overlay input before omitting its Vello render",
                "verify visible-to-empty-to-visible pixels and shared bitmap atlas parity with the real overlay path"
            ],
        }),
    );
    let started = Instant::now();
    let mut gpu = match pollster::block_on(Gpu::new_scaled(
        PORTRAIT.width,
        PORTRAIT.height,
        PORTRAIT.scale,
    )) {
        Ok(gpu) => gpu,
        Err(error) => {
            row("gpu_unavailable", json!({"reason": error.to_string()}));
            return Err(error);
        }
    };
    row(
        "adapter",
        json!({
            "adapter": gpu.adapter, "capabilities": gpu.capabilities,
            "software_cpu_adapter": gpu.adapter.contains("device_type: Cpu"),
            "adapter_device_and_pipeline_init_ms": ms(started),
        }),
    );
    let mut fonts = fonts();
    let credits = Credits {
        songwriters: vec!["Audit Fixture".into()],
        ..Default::default()
    };
    let mut current = PORTRAIT;
    for extent in [PORTRAIT, LANDSCAPE, REDUCED] {
        let started = Instant::now();
        let resize_from = (extent.name != current.name).then_some(current);
        if resize_from.is_some() {
            gpu.resize(extent.width, extent.height, extent.scale)
                .map_err(|e| format!("GPU resize {}: {e}", extent.name))?;
        }
        let resize_ms = resize_from.map(|_| ms(started));
        current = extent;
        for style in [Style::Spicy, Style::Amll] {
            for translated in [false, true] {
                let case = json!({"style": style, "translated": translated, "extent": extent});
                row("case_start", case.clone());
                let mut track = track(song(translated), style, extent, Some(&credits), &mut fonts);
                let time = track.lines().last().unwrap().start + 1200.0;
                let clock = timeline(time, 100.0, true);
                let mut owner = Owner::new(&track);
                owner
                    .prepare(&mut track, &clock, 100.0, true)
                    .expect("tail pose");
                owner.drag(&track, track.max_scroll() - owner.scroll.position());
                owner.prepare(&mut track, &clock, 100.0, false);
                owner.compose(&track, &clock, 100.0);
                let (band, _) = owner.compose(&track, &clock, 100.0 + 16.0 * STEP_MS);
                assert!(
                    !owner.lyrics.encoding().is_empty(),
                    "tail lyrics are visible"
                );
                assert!(
                    !owner.overlay.encoding().is_empty(),
                    "tail footer is visible"
                );
                let mut footer_proxy = Scene::new();
                footer_proxy.append(&owner.lyrics, None);
                footer_proxy.append(&owner.overlay, None);
                let scenes = [&owner.lyrics, &footer_proxy];
                let mut samples = [Vec::new(), Vec::new()];
                for pair in 0..10 {
                    for slot in 0..2 {
                        let index = (pair + slot) % 2;
                        let sample = gpu_frame(&mut gpu, scenes[index], band).map_err(|e| {
                            format!("GPU frame {case}, pair {pair}, variant {index}: {e}")
                        })?;
                        if pair >= 2 {
                            samples[index].push(sample);
                        }
                    }
                }
                row(
                    "gpu_case",
                    json!({
                        "case": case, "resize_from": resize_from, "resize_poll_and_reallocate_ms": resize_ms,
                        "output_pixels": extent.width * extent.height,
                        "quarter_resolution_pixels": extent.width.div_ceil(4) * extent.height.div_ceil(4),
                        "vello_renders": 2, "filter_compute_passes": 6,
                        "lyric_scene": counts(&owner.lyrics), "footer_scene": counts(&owner.overlay),
                        "empty_overlay": gpu_distribution(&samples[0]),
                        "footer_in_sharp_scene_proxy": gpu_distribution(&samples[1]),
                        "paired_delta_proxy_minus_empty_ms": {
                            "encode_submit": distribution(samples[1].iter().zip(&samples[0]).map(|(b,a)| b.encode_ms - a.encode_ms)),
                            "wall": distribution(samples[1].iter().zip(&samples[0]).map(|(b,a)| b.wall_ms - a.wall_ms)),
                            "gpu_interval": distribution(samples[1].iter().zip(&samples[0]).filter_map(|(b,a)| Some(b.gpu_interval_including_queue_gaps_ms? - a.gpu_interval_including_queue_gaps_ms?))),
                        }
                    }),
                );
            }
        }
    }
    Ok(())
}

fn cold_and_resident(fonts: &mut Fonts, style: Style, translated: bool, extent: Extent) {
    let lines = song(translated);
    let playback = lines[40].start + 1200.0;
    let clock = timeline(playback, 100.0, true);
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    let mut install_ms = Vec::new();
    for _ in 0..12 {
        let started = Instant::now();
        let mut track = track(lines.clone(), style, extent, None, fonts);
        install_ms.push(ms(started));
        let mut owner = Owner::new(&track);
        let mut resolver = Resolver::new();
        cold.push(
            cpu_frame(&mut owner, &mut track, &clock, 100.0, true, &mut resolver)
                .expect("cold steady frame should prepare"),
        );
        // Same native and playback times. New owner scratch on both passes
        // keeps the layout comparison separate from warm Scene vector capacity.
        let mut owner = Owner::new(&track);
        let mut resolver = Resolver::new();
        warm.push(
            cpu_frame(&mut owner, &mut track, &clock, 100.0, true, &mut resolver)
                .expect("resident steady frame should prepare"),
        );
    }
    let matched_payloads = cold
        .iter()
        .zip(&warm)
        .filter(|(a, b)| {
            a.lyrics_pack.fingerprint.is_some()
                && a.lyrics_pack.fingerprint == b.lyrics_pack.fingerprint
        })
        .count();
    row(
        "cold_warm_pair",
        json!({
            "style": style, "translated": translated, "extent": extent,
            "track_layout_install_ms": distribution(install_ms),
            "pairs": cold.len(), "matching_lyric_payload_fingerprints": matched_payloads,
            "cold_minus_resident_prepare_and_scroll_ms": distribution(cold.iter().zip(&warm).map(|(a,b)| a.prepare_and_scroll_ms - b.prepare_and_scroll_ms)),
        }),
    );
    report_cpu_frames(
        json!({"style": style, "translated": translated, "extent": extent, "motion": "same_pose_cold_layout"}),
        &cold,
    );
    report_cpu_frames(
        json!({"style": style, "translated": translated, "extent": extent, "motion": "same_pose_resident_layout"}),
        &warm,
    );
    assert!(cold.iter().all(|f| f.layout.new_row_layouts > 0));
    assert!(
        warm.iter()
            .all(|f| f.layout.new_row_layouts == 0 && f.layout.detailed_row_builds == 0)
    );
}

fn rotation(fonts: &mut Fonts, style: Style, translated: bool) {
    let lines = song(translated);
    let clock = timeline(lines[40].start + 1200.0, 100.0, true);
    let mut cache = LayoutCache::default();
    let key = |extent: Extent| {
        LayoutCache::key(
            "fps_budget",
            &lines,
            &settings(style, extent),
            extent.width,
            extent.height,
            extent.scale,
        )
        .expect("layout variant key")
    };
    let mut current = PORTRAIT;
    let mut current_key = key(current);
    let mut active = track(lines.clone(), style, current, None, fonts);
    let mut owner = Owner::new(&active);
    let mut resolver = Resolver::new();
    owner
        .prepare(&mut active, &clock, 100.0, true)
        .expect("portrait origin");
    owner.compose(&active, &clock, 100.0);
    for (index, extent) in [LANDSCAPE, PORTRAIT, LANDSCAPE].into_iter().enumerate() {
        let now = 150.0 + index as f64 * 150.0;
        let position = clock.position(now);
        let started = Instant::now();
        let next_key = key(extent);
        let key_ms = ms(started);
        let started = Instant::now();
        let cached = cache.take(&next_key);
        let hit = cached.is_some();
        let mut next = cached.unwrap_or_else(|| track(lines.clone(), style, extent, None, fonts));
        let lookup_and_build_ms = ms(started);
        let before = LayoutWork::read(&next);
        let started = Instant::now();
        resize_track_scroll(
            &mut owner.scroll,
            &active,
            &mut next,
            true,
            position,
            f64::from(extent.scale / current.scale),
        )
        .expect("production resize scroll remap");
        let remap_ms = ms(started);
        let remap_work = LayoutWork::read(&next).since(before);
        let started = Instant::now();
        cache.insert(current_key, active);
        owner.appearance.reset();
        let insert_and_reset_ms = ms(started);
        active = next;
        current_key = next_key;
        let frames: Vec<_> = (0..12)
            .map(|i| {
                cpu_frame(
                    &mut owner,
                    &mut active,
                    &clock,
                    now + f64::from(i) * STEP_MS,
                    true,
                    &mut resolver,
                )
                .expect("first frames after resize should prepare")
            })
            .collect();
        report_cpu_frames(
            json!({
                "style": style, "translated": translated, "motion": "rotation", "from_extent": current, "extent": extent,
                "layout_variant_cache_hit": hit, "layout_key_ms": key_ms, "lookup_and_optional_build_ms": lookup_and_build_ms,
                "scroll_remap_ms": remap_ms, "scroll_remap_layout_work": remap_work, "insert_and_appearance_reset_ms": insert_and_reset_ms,
            }),
            &frames,
        );
        assert_eq!(
            hit,
            index != 0,
            "expected cold landscape, then both cached variants"
        );
        current = extent;
    }
}

#[test]
#[ignore = "host FPS experiment 3: cold/resident lyric layout and rotation cache"]
fn layout_cache() {
    row(
        "scope",
        json!({
            "experiment": "layout_cache", "fixture": FIXTURE_NAME,
            "actual_path": "existing lazy track constructor, fake-acquire frame harness, resize_track_scroll and LayoutCache",
            "limitations": [
                "cold is fresh row geometry with shared registered font context; process launch, exact shape-call counts and Parley internal cache hits are unavailable",
                "rotation uses the CPU layout-key, cache and remap path; offscreen GPU resize has a separate row in offscreen_gpu",
                "rotation samples a steady following viewport, with production appearance reset after resize",
                "cold and resident same-pose pairs are independent; adjacent fingerprints in these summary rows compare repetitions, rather than consecutive live frames",
                "dynamic artwork is outside the Rust host path"
            ]
        }),
    );
    let mut fonts = fonts();
    for style in [Style::Amll, Style::Spicy] {
        for translated in [false, true] {
            for extent in [PORTRAIT, LANDSCAPE] {
                cold_and_resident(&mut fonts, style, translated, extent);
            }
            rotation(&mut fonts, style, translated);
        }
    }
}
