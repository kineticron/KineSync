//! C ABI. All calls are serialized by the native owner; registry also rejects stale handles.
//! Panics are caught before crossing C. Pointer buffers must be valid for their supplied length.
use crate::{
    Line,
    gpu::SurfaceRenderer,
    live::{Timeline, TrackPacket, frame_clock},
    motion::FollowScroll,
    scene::TrackScene,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Mutex, OnceLock},
    time::Instant,
};

thread_local! { static ERROR: RefCell<String> = const { RefCell::new(String::new()) }; }
fn error(message: impl ToString) {
    ERROR.with(|e| *e.borrow_mut() = message.to_string());
}
fn boundary<T>(fallback: T, body: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(_) => {
            error("Rust panic contained; renderer must be recreated");
            fallback
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Metrics {
    pub frames: u64,
    pub generation: u64,
    pub position_ms: f64,
    pub cpu_scene_ms: f64,
    pub cpu_encode_ms: f64,
    pub gpu_interval_ms: f64,
    pub wait_ms: f64,
    pub cpu_blit_ms: f64,
    pub layout_ms: f64,
    pub width: u32,
    pub height: u32,
    pub capabilities: u32,
    pub animating: u32,
    pub acquire_ms: f64,
    pub blit_submit_ms: f64,
    pub poll_ms: f64,
    pub present_call_ms: f64,
    pub completed: u64,
    pub outstanding: u64,
    pub gpu_busy: u64,
    pub target_native_ms: f64,
}
struct Engine {
    timeline: Timeline,
    lines: Vec<Line>,
    fonts: crate::typography::Fonts,
    settings: Option<crate::typography::Settings>,
    credits: Option<crate::live::Credits>,
    layout: Option<TrackScene>,
    layout_key: String,
    track_id: String,
    layout_cache: crate::scene::LayoutCache,
    surface: SurfaceRenderer,
    scene: vello::Scene,
    scale: f32,
    metrics: Metrics,
    scroll: FollowScroll,
    appearance: crate::appearance::AppearanceState,
    /// Skia `following`: manual touch owns the viewport until explicitly resumed.
    following: bool,
}
static ENGINES: OnceLock<Mutex<HashMap<u64, Engine>>> = OnceLock::new();
#[cfg(target_os = "ios")]
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn engines() -> &'static Mutex<HashMap<u64, Engine>> {
    ENGINES.get_or_init(Mutex::default)
}
fn with(handle: u64, body: impl FnOnce(&mut Engine) -> Result<i32, String>) -> i32 {
    boundary(-1, || {
        let mut registry = engines().lock().unwrap_or_else(|e| e.into_inner());
        let Some(engine) = registry.get_mut(&handle) else {
            error("Unknown or disposed renderer handle");
            return -1;
        };
        match catch_unwind(AssertUnwindSafe(|| body(engine))) {
            Ok(Ok(status)) => status,
            Ok(Err(message)) => {
                error(message);
                -1
            }
            Err(_) => {
                registry.remove(&handle);
                error("Rust panic contained; handle retired");
                -1
            }
        }
    })
}
fn dimensions(width: u32, height: u32, scale: f32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || !scale.is_finite()
        || !(0.5..=4.0).contains(&scale)
    {
        Err("Invalid surface dimensions or scale".into())
    } else {
        Ok(())
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn kr_abi_version() -> u32 {
    8
}
/// # Safety
/// `layer` is a live CAMetalLayer, retained by Swift until kr_destroy completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_create(layer: *mut c_void, width: u32, height: u32, scale: f32) -> u64 {
    boundary(0, || {
        if let Err(message) = dimensions(width, height, scale) {
            error(message);
            return 0;
        }
        if layer.is_null() {
            error("Null CAMetalLayer");
            return 0;
        }
        #[cfg(target_os = "ios")]
        {
            let result = (|| -> Result<Engine, Box<dyn std::error::Error>> {
                let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                    backends: wgpu::Backends::METAL,
                    ..wgpu::InstanceDescriptor::new_without_display_handle()
                });
                // SAFETY: caller retains the layer, serial owner drops surface before releasing it.
                let surface = unsafe {
                    instance
                        .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
                }?;
                let surface = pollster::block_on(SurfaceRenderer::new(
                    instance, surface, width, height, scale,
                ))?;
                Ok(Engine {
                    scroll: FollowScroll::default(),
                    appearance: crate::appearance::AppearanceState::default(),
                    following: true,
                    timeline: Timeline::default(),
                    lines: Vec::new(),
                    fonts: crate::typography::Fonts::default(),
                    settings: None,
                    credits: None,
                    layout: None,
                    layout_key: String::new(),
                    track_id: String::new(),
                    layout_cache: crate::scene::LayoutCache::default(),
                    scene: vello::Scene::new(),
                    scale,
                    metrics: Metrics {
                        capabilities: surface.capabilities(),
                        width,
                        height,
                        gpu_interval_ms: -1.0,
                        ..Metrics::default()
                    },
                    surface,
                })
            })();
            match result {
                Ok(engine) => {
                    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    engines()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(id, engine);
                    id
                }
                Err(message) => {
                    error(message);
                    0
                }
            }
        }
        #[cfg(not(target_os = "ios"))]
        {
            error("Rust native surface is available only on iOS device builds");
            0
        }
    })
}
/// # Safety
/// Both font buffers must remain readable for this call. Rust copies and owns them.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_set_fonts(
    handle: u64,
    regular: *const u8,
    regular_len: usize,
    bold: *const u8,
    bold_len: usize,
) -> i32 {
    with(handle, |engine| {
        if regular.is_null()
            || bold.is_null()
            || regular_len == 0
            || bold_len == 0
            || regular_len > 16_000_000
            || bold_len > 16_000_000
            || !engine.lines.is_empty()
        {
            return Err("Invalid font buffers or fonts changed after track preparation".into());
        }
        // SAFETY: caller provides live Data buffers, bounded above before reading.
        let (regular, bold) = unsafe {
            (
                std::slice::from_raw_parts(regular, regular_len),
                std::slice::from_raw_parts(bold, bold_len),
            )
        };
        engine.fonts.register(regular, bold)?;
        Ok(0)
    })
}
/// Returns required UTF8 buffer capacity including NUL. No partial output is written.
/// # Safety
/// When non-null, out must be writable for capacity bytes; nil/0 queries the size.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_copy_layout_json(handle: u64, out: *mut u8, capacity: usize) -> usize {
    boundary(0, || {
        let mut registry = engines().lock().unwrap_or_else(|e| e.into_inner());
        let Some(engine) = registry.get_mut(&handle) else {
            error("Unknown renderer handle");
            return 0;
        };
        let Some(layout) = &mut engine.layout else {
            error("No prepared layout");
            return 0;
        };
        // SAFETY: the caller supplies the output buffer described by this ABI.
        match unsafe { copy_layout_receipt(layout, out, capacity) } {
            Ok(needed) => needed,
            Err(message) => {
                error(message);
                0
            }
        }
    })
}
// SAFETY: a non-null output must be writable for capacity bytes.
unsafe fn copy_layout_receipt(
    layout: &mut TrackScene,
    out: *mut u8,
    capacity: usize,
) -> Result<usize, String> {
    let json = layout
        .layout_json()
        .map_err(|e| format!("Layout diagnostics failed: {e}"))?;
    let needed = json.len() + 1;
    if !out.is_null() && capacity >= needed {
        // SAFETY: the advertised capacity covers the bytes and NUL terminator.
        unsafe {
            std::ptr::copy_nonoverlapping(json.as_ptr(), out, json.len());
            *out.add(json.len()) = 0;
        }
    }
    Ok(needed)
}
/// # Safety
/// `bytes` must reference `length` readable bytes for this call. No buffer is retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_set_track(handle: u64, bytes: *const u8, length: usize) -> i32 {
    with(handle, |engine| {
        if bytes.is_null() || length > 2_000_000 {
            return Err("Invalid track buffer".into());
        }
        // SAFETY: native caller supplies a live Data buffer for the duration of the call.
        let packet = TrackPacket::parse(unsafe { std::slice::from_raw_parts(bytes, length) })?;
        if packet.generation <= engine.timeline.generation {
            return Ok(1);
        }
        let generation = packet.generation;
        let track_id = packet.track_id.clone();
        let credits = packet.credits.clone();
        let settings = packet
            .settings
            .clone()
            .ok_or("ABI6 requires explicit style settings")?;
        if packet.lines.iter().any(|line| {
            line.paint
                .as_ref()
                .into_iter()
                .chain(line.backgrounds.iter())
                .any(|p| p.words.iter().any(|w| w.appearance.is_none()))
        }) {
            return Err("ABI8 requires prepared voice metadata".into());
        }
        let lines = packet.into_lines();
        let started = Instant::now();
        let key = crate::scene::LayoutCache::key_with_credits(
            &track_id,
            &lines,
            &settings,
            engine.metrics.width,
            engine.metrics.height,
            engine.scale,
            credits.as_ref(),
        )
        .map_err(|e| e.to_string())?;
        let layout = if let Some(cached) = engine.layout_cache.take(&key) {
            cached
        } else {
            TrackScene::with_fonts_credits(
                lines.clone(),
                engine.metrics.width,
                engine.metrics.height,
                engine.scale,
                Some(&settings),
                credits.as_ref(),
                &mut engine.fonts,
            )
            .map_err(|e| e.to_string())?
        };
        engine.metrics.layout_ms = started.elapsed().as_secs_f64() * 1000.0;
        engine.lines = lines;
        engine.track_id = track_id;
        engine.settings = Some(settings);
        engine.credits = credits;
        if let Some(old) = engine.layout.take() {
            engine
                .layout_cache
                .insert(std::mem::take(&mut engine.layout_key), old);
        }
        engine.layout_key = key;
        engine.layout = Some(layout);
        engine.timeline.replace(generation);
        let style = engine
            .settings
            .as_ref()
            .map_or(crate::typography::Style::Spicy, |settings| settings.style);
        engine
            .scroll
            .configure(style, f64::from(engine.scale), engine.lines.len());
        engine.scroll.reset();
        engine.appearance.reset();
        engine.metrics.generation = generation;
        Ok(0)
    })
}
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments, reason = "Narrow numeric C ABI")]
pub extern "C" fn kr_set_anchor(
    handle: u64,
    generation: u64,
    sequence: u64,
    position_ms: f64,
    sampled_native_ms: f64,
    now_native_ms: f64,
    playing: bool,
    rate: f64,
    snap: bool,
) -> i32 {
    with(handle, |engine| {
        let accepted = engine.timeline.anchor(
            generation,
            sequence,
            position_ms,
            sampled_native_ms,
            now_native_ms,
            playing,
            rate,
        )?;
        if accepted && snap {
            // Explicit seeks/track discontinuities teleport instead of
            // traversing every intervening line.
            engine.scroll.snap_next();
            engine.appearance.reset();
        }
        Ok(if accepted { 0 } else { 1 })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn kr_resize(handle: u64, width: u32, height: u32, scale: f32) -> i32 {
    with(handle, |engine| {
        dimensions(width, height, scale)?;
        if (width, height, scale) == (engine.metrics.width, engine.metrics.height, engine.scale) {
            return Ok(0);
        }
        let started = Instant::now();
        let position = engine.metrics.position_ms;
        let old_target = engine
            .layout
            .as_ref()
            .map(|layout| layout.scroll_target(position));
        let key = engine
            .settings
            .as_ref()
            .map(|settings| {
                crate::scene::LayoutCache::key_with_credits(
                    &engine.track_id,
                    &engine.lines,
                    settings,
                    width,
                    height,
                    scale,
                    engine.credits.as_ref(),
                )
            })
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let layout = if engine.lines.is_empty() {
            None
        } else if let Some(cached) = engine.layout_cache.take(&key) {
            Some(cached)
        } else {
            Some(
                TrackScene::with_fonts_credits(
                    engine.lines.clone(),
                    width,
                    height,
                    scale,
                    engine.settings.as_ref(),
                    engine.credits.as_ref(),
                    &mut engine.fonts,
                )
                .map_err(|e| e.to_string())?,
            )
        };
        engine
            .surface
            .resize(width, height, scale)
            .map_err(|e| e.to_string())?;
        if let (Some(old_target), Some(layout)) = (old_target, &layout) {
            engine.scroll.remap(
                old_target,
                layout.scroll_target(position),
                f64::from(scale / engine.scale),
            );
            engine.scroll.configure(
                layout.style().unwrap_or(crate::typography::Style::Spicy),
                f64::from(scale),
                layout.lines.len(),
            );
        }
        if let Some(old) = engine.layout.take() {
            engine
                .layout_cache
                .insert(std::mem::take(&mut engine.layout_key), old);
        }
        engine.layout_key = key;
        engine.layout = layout;
        engine.appearance.reset();
        engine.scale = scale;
        engine.metrics.width = width;
        engine.metrics.height = height;
        engine.metrics.layout_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(0)
    })
}
/// Skia auto-follow ownership. Disabling freezes the viewport at its current
/// visual offset; enabling lets the next frame ease toward the authoritative one.
#[unsafe(no_mangle)]
pub extern "C" fn kr_set_following(handle: u64, following: bool) -> i32 {
    with(handle, |engine| {
        engine.following = following;
        Ok(0)
    })
}
/// Manual drag delta in logical points. Also takes follow ownership like Skia's
/// `onTouchStart`/`onScrollBeginDrag` path.
#[unsafe(no_mangle)]
pub extern "C" fn kr_scroll_by(handle: u64, dy: f64) -> i32 {
    with(handle, |engine| {
        if !dy.is_finite() {
            return Err("Invalid scroll delta".into());
        }
        let max_offset = engine.layout.as_ref().map_or(0.0, TrackScene::max_scroll);
        let scale = f64::from(engine.scale.max(0.001));
        let viewport = f64::from(engine.metrics.height);
        engine.scroll.drag(dy * scale, max_offset, viewport);
        engine.following = false;
        Ok(0)
    })
}
/// Manual fling velocity in logical points per millisecond. Negative values
/// move content up (finger swiped up); the native model owns deceleration.
#[unsafe(no_mangle)]
pub extern "C" fn kr_fling(handle: u64, velocity: f64) -> i32 {
    with(handle, |engine| {
        if !velocity.is_finite() {
            return Err("Invalid fling velocity".into());
        }
        let max_offset = engine.layout.as_ref().map_or(0.0, TrackScene::max_scroll);
        let scale = f64::from(engine.scale.max(0.001));
        let viewport = f64::from(engine.metrics.height);
        engine.scroll.fling(velocity * scale, max_offset, viewport);
        engine.following = false;
        Ok(0)
    })
}
/// Logical surface point to source line index, or -1 outside every row.
#[unsafe(no_mangle)]
pub extern "C" fn kr_hit_test(handle: u64, y: f64) -> i32 {
    if !y.is_finite() {
        error("Invalid hit-test point");
        return -1;
    }
    with(handle, |engine| {
        let Some(layout) = engine.layout.as_ref() else {
            return Ok(-1);
        };
        Ok(layout
            .hit_test(
                y * f64::from(engine.scale),
                engine.scroll.position(),
                engine.scroll.row_adjustments(),
                engine.metrics.position_ms,
            )
            .map_or(-1, |index| index as i32))
    })
}
struct PreparedDrawable<T> {
    drawable: T,
    native_ms: f64,
    preparation_ms: f64,
}

/// Never shape with a drawable held. A stall crossing a geometry boundary
/// retires that drawable before retrying. No animation state is sampled here.
fn prepare_drawable<T>(
    layout: &mut TrackScene,
    timeline: &Timeline,
    manual_scroll: Option<f64>,
    mut clock: impl FnMut() -> f64,
    mut acquire: impl FnMut() -> Result<Option<T>, String>,
) -> Result<Option<PreparedDrawable<T>>, String> {
    let mut preparation_ms = 0.0;
    for _ in 0..2 {
        let position = timeline.position(clock());
        let started = Instant::now();
        layout.prepare(position).map_err(|e| e.to_string())?;
        if let Some(scroll) = manual_scroll {
            layout.prepare_viewport(scroll).map_err(|e| e.to_string())?;
        }
        preparation_ms += started.elapsed().as_secs_f64() * 1000.0;
        let key = layout.preparation_key(position);
        let Some(drawable) = acquire()? else {
            return Ok(None);
        };
        let native_ms = clock();
        if layout.preparation_key(timeline.position(native_ms)) == key {
            return Ok(Some(PreparedDrawable {
                drawable,
                native_ms,
                preparation_ms,
            }));
        }
        drop(drawable);
    }
    // No drawable for a fully prepared current frame. The native owner's
    // existing bounded unavailable-drawable retry supplies another fresh clock.
    Ok(None)
}

/// Returns 0 after present call, 1 awaiting input, 2 no drawable, 3 GPU capacity, -1 failure.
#[unsafe(no_mangle)]
pub extern "C" fn kr_render(handle: u64, native_ms: f64, sampled_native_ms: f64) -> i32 {
    with(handle, |engine| {
        let frame_started = Instant::now();
        if !native_ms.is_finite()
            || native_ms < 0.0
            || !sampled_native_ms.is_finite()
            || sampled_native_ms < 0.0
        {
            return Err("Invalid native frame clock".into());
        }
        let Some(layout) = &mut engine.layout else {
            return Ok(1);
        };
        if !engine.timeline.anchored {
            return Ok(1);
        }
        let ready = engine.surface.ready().map_err(|e| e.to_string())?;
        engine.metrics.poll_ms = engine.surface.timing.poll_ms;
        engine.metrics.completed = engine.surface.completed();
        engine.metrics.outstanding = engine.surface.outstanding();
        if !ready {
            engine.metrics.gpu_busy += 1;
            return Ok(3);
        }
        let Some(prepared) = prepare_drawable(
            layout,
            &engine.timeline,
            (!engine.following).then_some(engine.scroll.position()),
            || {
                frame_clock(
                    native_ms,
                    sampled_native_ms,
                    frame_started.elapsed().as_secs_f64() * 1000.0,
                )
            },
            || engine.surface.acquire().map_err(|e| e.to_string()),
        )?
        else {
            return Ok(2);
        };
        let frame = prepared.drawable;
        let native_ms = prepared.native_ms;
        engine.metrics.target_native_ms = native_ms;
        let position = engine.timeline.position(native_ms);
        let started = Instant::now();
        // Geometry changes reach the tween through `command.offset`; remapping
        // here would clear the spring history every frame.
        let command = layout.scroll_command(position, engine.scroll.position());
        let scroll = engine.scroll.sample(&command, native_ms, engine.following);
        let effect = crate::appearance::LIVE_EFFECT;
        engine.appearance.prepare(layout, position, native_ms);
        engine
            .appearance
            .advance(layout, position, native_ms, engine.timeline.playing, effect);
        let band = layout.frame_appearance(
            position,
            scroll,
            engine.scroll.row_adjustments(),
            &engine.appearance,
            &mut engine.scene,
            effect,
        );
        engine.metrics.animating = u32::from(
            engine.scroll.animating()
                || engine.appearance.animating()
                || engine.appearance.interlude_animating(),
        );
        engine.metrics.position_ms = position;
        engine.metrics.cpu_scene_ms =
            prepared.preparation_ms + started.elapsed().as_secs_f64() * 1000.0;
        let (stats, present) = engine
            .surface
            .render_appearance(
                &engine.scene,
                band,
                frame,
                crate::appearance::LIVE_EFFECT.glow(),
            )
            .map_err(|e| e.to_string())?;
        engine.metrics.frames += 1;
        engine.metrics.cpu_encode_ms = stats.cpu_encode_ms;
        engine.metrics.gpu_interval_ms = stats.gpu_interval_ms.unwrap_or(-1.0);
        engine.metrics.wait_ms = stats.wait_readback_ms;
        engine.metrics.cpu_blit_ms = present;
        engine.metrics.acquire_ms = engine.surface.timing.acquire_ms;
        engine.metrics.blit_submit_ms = engine.surface.timing.submit_ms;
        engine.metrics.present_call_ms = engine.surface.timing.present_call_ms;
        engine.metrics.completed = engine.surface.completed();
        engine.metrics.outstanding = engine.surface.outstanding();
        Ok(0)
    })
}
/// # Safety
/// `out` points to a writable Metrics value.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_metrics(handle: u64, out: *mut Metrics) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return Err("Null metrics pointer".into());
        }
        // SAFETY: caller owns this output buffer.
        unsafe {
            out.write(engine.metrics);
        }
        Ok(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn kr_destroy(handle: u64) -> i32 {
    boundary(-1, || {
        engines()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle);
        0
    })
}
/// # Safety
/// `out` references `capacity` writable bytes. Output is always NUL-terminated if capacity > 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_copy_error(out: *mut c_char, capacity: usize) {
    boundary((), || {
        if out.is_null() || capacity == 0 {
            return;
        }
        ERROR.with(|message| {
            let message = message.borrow();
            let count = message.len().min(capacity - 1);
            // SAFETY: caller provides the writable buffer.
            unsafe {
                std::ptr::copy_nonoverlapping(message.as_ptr(), out.cast(), count);
                out.add(count).write(0);
            }
        });
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn abi_v8_metrics_layout_matches_header() {
        assert_eq!(kr_abi_version(), 8);
        assert_eq!(std::mem::size_of::<Metrics>(), 152);
        assert_eq!(std::mem::offset_of!(Metrics, capabilities), 80);
        assert_eq!(std::mem::offset_of!(Metrics, animating), 84);
        assert_eq!(std::mem::offset_of!(Metrics, acquire_ms), 88);
        assert_eq!(std::mem::offset_of!(Metrics, completed), 120);
    }
    fn preparation_track() -> TrackScene {
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../test/background-voices.json")).unwrap();
        let packet =
            TrackPacket::parse(&serde_json::to_vec(&data["cases"][0]["packet"]).unwrap()).unwrap();
        let settings = packet.settings.clone().unwrap();
        let mut fonts = crate::typography::Fonts::default();
        fonts
            .register(
                include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"),
                include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"),
            )
            .unwrap();
        TrackScene::with_fonts(
            packet.into_lines(),
            390,
            640,
            1.0,
            Some(&settings),
            &mut fonts,
        )
        .unwrap()
    }

    #[test]
    fn acquisition_stall_retires_drawable_before_preparing_the_new_window() {
        use std::{cell::Cell, rc::Rc};
        struct Drawable(Rc<Cell<usize>>);
        impl Drop for Drawable {
            fn drop(&mut self) {
                self.0.set(self.0.get() - 1);
            }
        }
        let mut layout = preparation_track();
        let before = layout.lines[0].start + 1.0;
        let after = layout.lines[1].background_end + 2000.0;
        assert_ne!(
            layout.preparation_key(before),
            layout.preparation_key(after)
        );
        let mut timeline = Timeline::default();
        timeline.replace(1);
        timeline.anchor(1, 1, 0.0, 0.0, 0.0, true, 1.0).unwrap();
        let mut times = [before, after, after, after].into_iter();
        let held = Rc::new(Cell::new(0));
        let mut acquisitions = 0;
        let prepared = prepare_drawable(
            &mut layout,
            &timeline,
            None,
            || times.next().unwrap(),
            || {
                assert_eq!(
                    held.get(),
                    0,
                    "previous drawable must be released before retry"
                );
                acquisitions += 1;
                held.set(held.get() + 1);
                Ok(Some(Drawable(held.clone())))
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(acquisitions, 2);
        assert_eq!(prepared.native_ms, after);
        assert_eq!(held.get(), 1);
        let mut expected = preparation_track();
        expected.prepare(before).unwrap();
        expected.prepare(after).unwrap();
        assert_eq!(
            layout.layout_json().unwrap(),
            expected.layout_json().unwrap()
        );
        drop(prepared);
        assert_eq!(held.get(), 0);
    }

    #[test]
    fn unavailable_drawable_prepares_without_sampling_animation_and_pause_holds_time() {
        let mut layout = preparation_track();
        let position = layout.lines[0].start + 1.0;
        let mut timeline = Timeline::default();
        timeline.replace(1);
        timeline
            .anchor(1, 1, position, 0.0, 0.0, false, 1.0)
            .unwrap();
        let result =
            prepare_drawable::<()>(&mut layout, &timeline, Some(0.0), || 100_000.0, || Ok(None))
                .unwrap();
        assert!(result.is_none());
        assert!(layout.geometry_ready(0));
        assert_eq!(timeline.position(100_000.0), position);
        let prepared = prepare_drawable(
            &mut layout,
            &timeline,
            Some(0.0),
            || 200_000.0,
            || Ok(Some(())),
        )
        .unwrap()
        .unwrap();
        assert_eq!(prepared.native_ms, 200_000.0);
        assert_eq!(timeline.position(prepared.native_ms), position);
    }

    #[test]
    fn layout_copy_size_query_short_buffer_and_cached_copy() {
        let mut lines = crate::fixture().unwrap();
        lines.truncate(1);
        let mut layout = TrackScene::from_lines(lines, 390, 640, 1.0).unwrap();
        assert!(layout.diagnostics.iter().all(serde_json::Value::is_null));
        // SAFETY: null output is a size query with no buffer access.
        let capacity =
            unsafe { copy_layout_receipt(&mut layout, std::ptr::null_mut(), 0) }.unwrap();
        let mut short = vec![0xa5; capacity - 1];
        // SAFETY: the short buffer has the advertised capacity.
        assert_eq!(
            unsafe { copy_layout_receipt(&mut layout, short.as_mut_ptr(), short.len()) }.unwrap(),
            capacity
        );
        assert!(
            short.iter().all(|b| *b == 0xa5),
            "short copy must not write partial JSON"
        );
        let mut bytes = vec![0xa5; capacity + 2];
        let allocations = crate::allocation_probe::measure(|| {
            // SAFETY: the output buffer exceeds the advertised capacity.
            assert_eq!(
                unsafe { copy_layout_receipt(&mut layout, bytes.as_mut_ptr(), capacity) }.unwrap(),
                capacity
            );
        });
        assert_eq!(
            allocations, 0,
            "size query and copy must reuse the serialized snapshot"
        );
        assert_eq!(bytes[capacity - 1], 0);
        assert_eq!(&bytes[capacity..], &[0xa5, 0xa5]);
        let receipt: serde_json::Value = serde_json::from_slice(&bytes[..capacity - 1]).unwrap();
        assert_eq!(receipt.as_array().unwrap().len(), 1);
        assert_eq!(receipt[0]["text"], layout.lines[0].text);
    }
    #[test]
    fn panic_containment_and_invalid_handles() {
        assert_eq!(boundary(-7, || panic!("test panic")), -7);
        assert_eq!(kr_render(u64::MAX, 0.0, 0.0), -1);
        assert_eq!(kr_destroy(u64::MAX), 0);
        assert_eq!(kr_set_following(u64::MAX, false), -1);
        assert_eq!(kr_scroll_by(u64::MAX, 10.0), -1);
        assert_eq!(kr_hit_test(u64::MAX, 10.0), -1);
        let mut message = [0i8; 256];
        // SAFETY: stack output buffer has the advertised capacity.
        unsafe {
            kr_copy_error(message.as_mut_ptr(), message.len());
        }
        assert_ne!(message[0], 0);
    }
}
