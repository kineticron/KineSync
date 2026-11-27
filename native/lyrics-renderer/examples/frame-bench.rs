//! Host CPU benchmark for the live renderer's follow, layout and scene paths.
//! Build each snapshot in release mode with the same toolchain and host settings.
//! Run latency measurements with FRAME_BENCH_COUNT_ALLOCATIONS unset. Set it
//! to 1 at build time for a separate allocation run.
//! Set FRAME_BENCH_RAW=1 for per-frame samples and FRAME_BENCH_TRANSLATED_FIRST=1
//! to reverse the translation workload order when investigating order effects.
//! Set FRAME_BENCH_ROMANIZED_BACKING=1 for a synthetic Hangul lead with optional
//! romanization and a backing voice every fourth row.
use lyrics_renderer::{
    Atom, Line,
    appearance::{AppearanceState, LIVE_EFFECT},
    live::Timeline,
    motion::FollowScroll,
    scene::TrackScene,
    typography::{Fonts, PaintVoice, PaintWord, Settings, Style, WordAppearance},
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    error::Error,
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use vello::Scene;

const LINES: u32 = 100;
const HZ: u32 = 120;
const LINE_MS: u32 = 3_000;
const LINE_FRAMES: u32 = LINE_MS * HZ / 1_000;
const WIDTH: u32 = 1_170;
const HEIGHT: u32 = 2_100;
const SCALE: f32 = 3.0;
const COUNT_ALLOCATIONS: bool = option_env!("FRAME_BENCH_COUNT_ALLOCATIONS").is_some();
static LIVE_ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

struct FrameAllocator;

impl FrameAllocator {
    fn record() {
        if COUNT_ALLOCATIONS {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
        }
    }

    fn add_live_bytes(size: usize) {
        if COUNT_ALLOCATIONS && size != 0 {
            LIVE_ALLOCATED_BYTES.fetch_add(size, Ordering::Relaxed);
        }
    }

    fn remove_live_bytes(size: usize) {
        if COUNT_ALLOCATIONS && size != 0 {
            LIVE_ALLOCATED_BYTES.fetch_sub(size, Ordering::Relaxed);
        }
    }
}

// Forward every request to System with the original pointer and layout.
unsafe impl GlobalAlloc for FrameAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        Self::record();
        let ptr = unsafe { System.alloc(layout) };
        if COUNT_ALLOCATIONS && !ptr.is_null() {
            Self::add_live_bytes(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        Self::record();
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if COUNT_ALLOCATIONS && !ptr.is_null() {
            Self::add_live_bytes(layout.size());
        }
        ptr
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        Self::record();
        let resized = unsafe { System.realloc(ptr, layout, size) };
        if COUNT_ALLOCATIONS && !resized.is_null() {
            let old_size = layout.size();
            Self::add_live_bytes(size.saturating_sub(old_size));
            Self::remove_live_bytes(old_size.saturating_sub(size));
        }
        resized
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if COUNT_ALLOCATIONS && !ptr.is_null() {
            Self::remove_live_bytes(layout.size());
        }
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: FrameAllocator = FrameAllocator;

fn song(translated: bool) -> Vec<Line> {
    // ASCII lead words make the UTF-8 byte offsets also valid UTF-16 offsets.
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
    const WORD_MS: [f64; 7] = [0.0, 300.0, 550.0, 1_950.0, 2_250.0, 2_600.0, 3_000.0];

    (0..LINES)
        .map(|index| {
            let (text, translation) = VERSES[index as usize % VERSES.len()];
            let start = f64::from(index * LINE_MS);
            let end = start + f64::from(LINE_MS);
            let mut offset = 0;
            let mut atoms = Vec::with_capacity(WORD_MS.len() - 1);
            let words = text
                .split_ascii_whitespace()
                .zip(WORD_MS.windows(2))
                .enumerate()
                .map(|(i, (word, interval))| {
                    let last = i == WORD_MS.len() - 2;
                    let word_start = start + interval[0];
                    let word_end_ms = start + interval[1];
                    let word_end = offset + word.len();
                    atoms.push(Atom {
                        bytes: offset..word_end,
                        start: word_start,
                        end: word_end_ms,
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
                        end: word_end_ms,
                        joined: false,
                        gap_after: !last,
                        group: None,
                        graphemes: word.chars().map(|ch| ch.to_string()).collect(),
                    };
                    offset = word_end + usize::from(!last);
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

fn romanized_backing_song(translated: bool) -> Vec<Line> {
    const LEAD: &str = "우리 함께 천천히 이 길을 걸어";
    const ROMANIZATION: &str = "uri hamkke cheoncheonhi i gireul georeo";
    const BACKING: &str = "oh";

    let mut lines = song(false);
    for (index, line) in lines.iter_mut().enumerate() {
        line.text = LEAD.into();
        let lead = line.paint.as_mut().expect("synthetic lead voice");
        lead.text = LEAD.into();
        lead.translation = translated.then(|| ROMANIZATION.into());
        let mut byte_offset = 0;
        let mut utf16_offset = 0;
        for ((atom, word), text) in line
            .atoms
            .iter_mut()
            .zip(&mut lead.words)
            .zip(LEAD.split_ascii_whitespace())
        {
            atom.bytes = byte_offset..byte_offset + text.len();
            word.offset = utf16_offset;
            word.text = text.into();
            word.graphemes = text.chars().map(|ch| ch.to_string()).collect();
            byte_offset += text.len() + usize::from(word.gap_after);
            utf16_offset += text.encode_utf16().count() + usize::from(word.gap_after);
        }

        if index % 4 == 0 {
            let start = line.start + 900.0;
            let end = line.start + 2_500.0;
            line.backgrounds.push(PaintVoice {
                translation: None,
                start,
                end,
                text: BACKING.into(),
                words: vec![PaintWord {
                    appearance: Some(WordAppearance {
                        emphasized: false,
                        origin: 0.5,
                        rtl: false,
                        last: true,
                        emphasis: None,
                    }),
                    text: BACKING.into(),
                    offset: 0,
                    start,
                    end,
                    joined: false,
                    gap_after: false,
                    group: None,
                    graphemes: BACKING.chars().map(|ch| ch.to_string()).collect(),
                }],
                cjk_breaks: Vec::new(),
                opposite: lead.opposite,
                duet: lead.duet,
            });
        }
    }
    lines
}

struct Sample {
    frame: Duration,
    prepare: Duration,
    plain_rows: usize,
    detailed_rows: usize,
    layout_glyphs: usize,
    allocations: usize,
    glyphs: usize,
    glyph_runs: usize,
    color_stops: usize,
    clips: u32,
    scroll: f64,
}

#[derive(Clone, Copy, Default)]
struct FrameTotals {
    frames: usize,
    frame: Duration,
    prepare: Duration,
    plain_rows: usize,
    detailed_rows: usize,
    layout_glyphs: usize,
    glyphs: usize,
    glyph_runs: usize,
    color_stops: usize,
    clips: u64,
}

impl FrameTotals {
    fn record(&mut self, sample: &Sample) {
        self.frames += 1;
        self.frame += sample.frame;
        self.prepare += sample.prepare;
        self.plain_rows += sample.plain_rows;
        self.detailed_rows += sample.detailed_rows;
        self.layout_glyphs += sample.layout_glyphs;
        self.glyphs += sample.glyphs;
        self.glyph_runs += sample.glyph_runs;
        self.color_stops += sample.color_stops;
        self.clips += u64::from(sample.clips);
    }

    fn report(&self, phase: &str) {
        println!(
            "  {phase} frames={} frame_total_ms={:.4} prepare_total_ms={:.4} \
             plain_rows={} detailed_rows={} layout_glyphs={} \
             encoded_glyphs={} glyph_runs={} color_stops={} clips={}",
            self.frames,
            self.frame.as_secs_f64() * 1000.0,
            self.prepare.as_secs_f64() * 1000.0,
            self.plain_rows,
            self.detailed_rows,
            self.layout_glyphs,
            self.glyphs,
            self.glyph_runs,
            self.color_stops,
            self.clips,
        );
    }
}

fn percentiles(samples: &[&Sample], duration: impl Fn(&Sample) -> Duration) -> [f64; 3] {
    let mut ordered: Vec<_> = samples.iter().map(|sample| duration(sample)).collect();
    ordered.sort_unstable();
    [50, 95, 99].map(|p| {
        let index = (p * ordered.len()).div_ceil(100) - 1;
        ordered[index].as_secs_f64() * 1_000.0
    })
}

fn report(name: &str, samples: &[&Sample]) {
    if samples.is_empty() {
        println!("  {name} frames=0");
        return;
    }
    let [p50, p95, p99] = percentiles(samples, |sample| sample.frame);
    let [prepare_p50, prepare_p95, prepare_p99] = percentiles(samples, |sample| sample.prepare);
    let plain_rows: usize = samples.iter().map(|sample| sample.plain_rows).sum();
    let detailed_rows: usize = samples.iter().map(|sample| sample.detailed_rows).sum();
    let layout_glyphs: usize = samples.iter().map(|sample| sample.layout_glyphs).sum();
    print!(
        "  {name} frames={} frame_ms={p50:.4}/{p95:.4}/{p99:.4} \
         prepare_ms={prepare_p50:.4}/{prepare_p95:.4}/{prepare_p99:.4} \
         plain_rows={plain_rows} detailed_rows={detailed_rows} layout_glyphs={layout_glyphs}",
        samples.len(),
    );
    if COUNT_ALLOCATIONS {
        let total: usize = samples.iter().map(|sample| sample.allocations).sum();
        let max = samples
            .iter()
            .map(|sample| sample.allocations)
            .max()
            .unwrap_or(0);
        print!(" alloc_calls_total={total} alloc_calls_max_per_frame={max}");
    }
    println!();
}

fn report_encoding(samples: &[Sample]) {
    let frames = samples.len() as f64;
    let glyphs: usize = samples.iter().map(|sample| sample.glyphs).sum();
    let runs: usize = samples.iter().map(|sample| sample.glyph_runs).sum();
    let stops: usize = samples.iter().map(|sample| sample.color_stops).sum();
    let clips: u64 = samples.iter().map(|sample| u64::from(sample.clips)).sum();
    println!(
        "  encoding_mean_per_frame glyphs={:.2} glyph_runs={:.2} color_stops={:.2} clips={:.2}",
        glyphs as f64 / frames,
        runs as f64 / frames,
        stops as f64 / frames,
        clips as f64 / frames,
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    Steady,
    AutoScroll,
    ManualResident,
    FarReengage,
}

fn run(
    style: Style,
    translated: bool,
    scenario: Scenario,
    fonts: &mut Fonts,
    raw: bool,
    fixture: fn(bool) -> Vec<Line>,
) -> Result<(), Box<dyn Error>> {
    let setup_started = Instant::now();
    let mut setup_allocations = 0;
    let mut warmup_allocations = 0;
    if COUNT_ALLOCATIONS {
        ALLOCATIONS.set(0);
    }
    let settings = Settings {
        style,
        font_scale: 1.0,
        landscape: false,
    };
    let mut track = TrackScene::with_fonts(
        fixture(translated),
        WIDTH,
        HEIGHT,
        SCALE,
        Some(&settings),
        fonts,
    )?;
    let mut scroll = FollowScroll::default();
    scroll.configure(style, f64::from(SCALE), track.lines().len());
    let mut appearance = AppearanceState::default();
    let mut scene = Scene::new();
    // Prepare resident geometry for the off-playhead drag path. The FFI's
    // manual viewport preparation and geometry-anchor rebase are crate-private.
    let interaction = matches!(scenario, Scenario::ManualResident | Scenario::FarReengage);
    let (name, first_line, warmup, end) = match scenario {
        // The measured interval stays strictly inside the third word of line 40.
        Scenario::Steady => ("steady-word", 40, 120, 234),
        Scenario::AutoScroll => ("auto-scroll", 0, 2 * LINE_FRAMES, LINES * LINE_FRAMES),
        Scenario::ManualResident => ("manual-resident-drag", 40, 120, 240),
        Scenario::FarReengage => ("far-reengage", 40, 240, 480),
    };
    let mut timeline = Timeline::default();
    assert!(timeline.replace(1));
    let anchor = f64::from(first_line * LINE_MS) + if interaction { 1_200.0 } else { 0.0 };
    assert!(timeline.anchor(1, 1, anchor, 0.0, 0.0, !interaction, 1.0)?);
    let mut drag_step = 0.0;
    let mut samples = Vec::with_capacity((end - warmup) as usize);
    let mut return_start = 0.0;
    let mut first_scroll = 0.0;
    let mut last_scroll = 0.0;
    let mut before_warmup_bytes = 0;
    let mut after_warmup_bytes = 0;
    let mut full_run = FrameTotals::default();
    let mut warmup_totals = FrameTotals::default();
    if COUNT_ALLOCATIONS {
        before_warmup_bytes = LIVE_ALLOCATED_BYTES.load(Ordering::Relaxed);
    }
    let setup = setup_started.elapsed();
    let prewarm = if interaction {
        let started = Instant::now();
        for row in 40..=56 {
            track.prepare(f64::from(row * LINE_MS))?;
        }
        started.elapsed()
    } else {
        Duration::ZERO
    };
    let prewarm_plain_rows = track.plain_preparations;
    let prewarm_detailed_rows = track.detailed_preparations;
    let prewarm_layout_glyphs = track.glyph_count;
    if COUNT_ALLOCATIONS {
        setup_allocations = ALLOCATIONS.get();
    }

    for tick in 0..end {
        if tick == warmup {
            warmup_totals = full_run;
        }
        if COUNT_ALLOCATIONS && tick == warmup {
            after_warmup_bytes = LIVE_ALLOCATED_BYTES.load(Ordering::Relaxed);
        }
        let native_ms = f64::from(tick) * 1_000.0 / f64::from(HZ);
        let position = timeline.position(native_ms);
        if interaction && tick == 120 {
            let destination = track.scroll_target(f64::from(56 * LINE_MS));
            drag_step = (destination - scroll.position()) / 120.0;
            assert!(drag_step * 120.0 > f64::from(HEIGHT));
        }
        let dragging = interaction && (120..240).contains(&tick);
        if scenario == Scenario::FarReengage && tick == warmup {
            // A zero-velocity release far from the target retains manual
            // ownership until the explicit follow toggle below.
            let target = track.scroll_target(position);
            return_start = scroll.position();
            assert!((target - return_start).abs() > f64::from(HEIGHT));
            assert!(!scroll.release(
                0.0,
                track.max_scroll(),
                f64::from(HEIGHT),
                Some(target),
                native_ms,
            ));
        }
        let plain_before = track.plain_preparations;
        let detailed_before = track.detailed_preparations;
        let layout_glyphs_before = track.glyph_count;
        if COUNT_ALLOCATIONS {
            ALLOCATIONS.set(0);
        }
        let started = Instant::now();
        if dragging {
            scroll.drag(drag_step, track.max_scroll(), f64::from(HEIGHT));
        }
        // Hold the playback clock fixed across the interaction so the follow
        // target remains the anchored lyric throughout the return.
        let prepare_started = if dragging { Instant::now() } else { started };
        track.prepare(position)?;
        let prepare = prepare_started.elapsed();
        let command = track.scroll_command(position, scroll.position());
        let offset = scroll.sample(&command, native_ms, !dragging);
        appearance.prepare(&track, position, native_ms);
        appearance.advance(&track, position, native_ms, timeline.playing, LIVE_EFFECT);
        let band = track.frame_appearance(
            position,
            offset,
            scroll.row_adjustments(),
            &appearance,
            &mut scene,
            LIVE_EFFECT,
        );
        black_box((&scene, band));
        let frame = started.elapsed();
        let allocations = if COUNT_ALLOCATIONS {
            ALLOCATIONS.get()
        } else {
            0
        };
        let encoding = scene.encoding();
        let sample = Sample {
            frame,
            prepare,
            plain_rows: track.plain_preparations - plain_before,
            detailed_rows: track.detailed_preparations - detailed_before,
            layout_glyphs: track.glyph_count - layout_glyphs_before,
            allocations,
            glyphs: encoding.resources.glyphs.len(),
            glyph_runs: encoding.resources.glyph_runs.len(),
            color_stops: encoding.resources.color_stops.len(),
            clips: encoding.n_clips,
            scroll: offset,
        };
        full_run.record(&sample);
        if tick >= warmup {
            assert!(
                !encoding.resources.glyph_runs.is_empty(),
                "no encoded glyph runs at {position} ms"
            );
            samples.push(sample);
            if tick == warmup {
                first_scroll = offset;
            }
            last_scroll = offset;
        } else {
            warmup_allocations += allocations;
        }
    }
    if scenario == Scenario::Steady {
        assert!(track.timed_ready(first_line as usize));
        assert!(
            appearance
                .row(first_line as usize)
                .is_some_and(|row| row.active)
        );
    } else if scenario == Scenario::AutoScroll {
        assert!(last_scroll - first_scroll > f64::from(HEIGHT));
        assert!(samples.iter().any(|sample| sample.plain_rows > 0));
    }

    if scenario == Scenario::ManualResident {
        assert!(last_scroll - first_scroll > f64::from(HEIGHT));
    }
    if scenario == Scenario::FarReengage {
        let target = track.scroll_target(anchor);
        assert!(
            (first_scroll - return_start).abs() < 1e-6,
            "first return frame moved"
        );
        let distance = (return_start - target).abs();
        assert!(
            samples.iter().any(|sample| {
                let remaining = (sample.scroll - target).abs();
                (0.25 * distance..0.75 * distance).contains(&remaining)
            }),
            "return did not traverse intermediate offsets"
        );
        let remaining = (last_scroll - target).abs();
        assert!(remaining < 1e-6, "remaining return distance: {remaining}");
    }

    let final_bytes = if COUNT_ALLOCATIONS {
        LIVE_ALLOCATED_BYTES.load(Ordering::Relaxed)
    } else {
        0
    };
    println!("style={style:?} translated={translated} phase={name} warmup_frames={warmup}");
    println!(
        "  setup_ms={:.4} prewarm_ms={:.4} timed_scenario_total_ms={:.4} \
         prewarm_plain_rows={prewarm_plain_rows} prewarm_detailed_rows={prewarm_detailed_rows} \
         prewarm_layout_glyphs={prewarm_layout_glyphs}",
        setup.as_secs_f64() * 1000.0,
        prewarm.as_secs_f64() * 1000.0,
        (setup + prewarm + full_run.frame).as_secs_f64() * 1000.0,
    );
    let mut measured = FrameTotals::default();
    for sample in &samples {
        measured.record(sample);
    }
    full_run.report("full-run");
    warmup_totals.report("warmup");
    measured.report("measured");
    report("all", &samples.iter().collect::<Vec<_>>());
    report_encoding(&samples);
    if scenario == Scenario::FarReengage {
        let target = track.scroll_target(anchor);
        println!(
            "  return_px initial={:.2} after_first_frame={:.2} final={:.2}",
            (return_start - target).abs(),
            (first_scroll - target).abs(),
            (last_scroll - target).abs(),
        );
        report("first-return-frame", &[&samples[0]]);
        report("first-250ms", &samples[..30].iter().collect::<Vec<_>>());
    }
    report(
        "new-layout",
        &samples
            .iter()
            .filter(|sample| sample.plain_rows > 0)
            .collect::<Vec<_>>(),
    );
    report(
        "timed-promotion-only",
        &samples
            .iter()
            .filter(|sample| sample.plain_rows == 0 && sample.detailed_rows > 0)
            .collect::<Vec<_>>(),
    );
    if COUNT_ALLOCATIONS {
        println!(
            "  retained_bytes before_warmup={before_warmup_bytes} \
             after_warmup={after_warmup_bytes} end_of_sampling={final_bytes}"
        );
        println!("  allocation_calls setup={setup_allocations} warmup_frames={warmup_allocations}");
    }
    if raw {
        println!(
            "  tick,frame_ns,prepare_ns,plain_rows,detailed_rows,layout_glyphs,glyphs,glyph_runs,color_stops,clips,allocations,scroll_px"
        );
        for (index, sample) in samples.iter().enumerate() {
            println!(
                "  {},{},{},{},{},{},{},{},{},{},{},{:.6}",
                warmup as usize + index,
                sample.frame.as_nanos(),
                sample.prepare.as_nanos(),
                sample.plain_rows,
                sample.detailed_rows,
                sample.layout_glyphs,
                sample.glyphs,
                sample.glyph_runs,
                sample.color_stops,
                sample.clips,
                sample.allocations,
                sample.scroll,
            );
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    assert!(LIVE_EFFECT.motion(), "expected the live timed scene effect");
    let font_context_started = Instant::now();
    let mut fonts = Fonts::default();
    let font_context = font_context_started.elapsed();
    let font_registration_started = Instant::now();
    fonts.register(
        include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"),
        include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"),
    )?;
    let font_registration = font_registration_started.elapsed();
    println!(
        "CPU layout and scene construction, {LINES} lines at {HZ} Hz, {WIDTH}x{HEIGHT} @{SCALE}x. \
         Percentiles p50/p95/p99. Layout counts are row preparations and glyphs produced in plain layouts. \
         GPU, drawable, overlay and frame scheduling are outside this benchmark. \
         allocation_counting={COUNT_ALLOCATIONS}"
    );
    let (fixture_source, fixture): (&str, fn(bool) -> Vec<Line>) =
        if std::env::var("FRAME_BENCH_ROMANIZED_BACKING").is_ok_and(|value| value == "1") {
            (
                "synthetic Hangul lead, Latin backing, optional romanization",
                romanized_backing_song,
            )
        } else {
            ("synthetic English lead, optional Spanish translation", song)
        };
    println!("fixture_source={fixture_source}");
    println!(
        "font_context_ms={:.4} font_registration_ms={:.4} (once, outside scenarios)",
        font_context.as_secs_f64() * 1000.0,
        font_registration.as_secs_f64() * 1000.0,
    );
    println!(
        "Phase totals sum measured spans. Preparation is included in frame time. \
         Full-run frame totals cover warmup and measured ticks. The scenario total also includes setup and prewarm. \
         Clock projection, interaction boundary commands and reporting are outside the frame timer."
    );
    if COUNT_ALLOCATIONS {
        println!(
            "Retained bytes are process-wide requested bytes tracked by the Rust allocator. \
             They include sample storage and other live allocations. Compare identical scenarios."
        );
    }
    let raw = std::env::var("FRAME_BENCH_RAW").is_ok_and(|value| value == "1");
    let translated_first =
        std::env::var("FRAME_BENCH_TRANSLATED_FIRST").is_ok_and(|value| value == "1");
    for translated in [translated_first, !translated_first] {
        for style in [Style::Spicy, Style::Amll] {
            for scenario in [
                Scenario::Steady,
                Scenario::AutoScroll,
                Scenario::ManualResident,
                Scenario::FarReengage,
            ] {
                run(style, translated, scenario, &mut fonts, raw, fixture)?;
                if COUNT_ALLOCATIONS {
                    let after_drop = LIVE_ALLOCATED_BYTES.load(Ordering::Relaxed);
                    println!("  retained_bytes after_scenario_drop={after_drop}");
                }
            }
        }
    }
    Ok(())
}
