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
    7
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
        let registry = engines().lock().unwrap_or_else(|e| e.into_inner());
        let Some(engine) = registry.get(&handle) else {
            error("Unknown renderer handle");
            return 0;
        };
        let Some(layout) = &engine.layout else {
            error("No prepared layout");
            return 0;
        };
        let Ok(json) = serde_json::to_vec(&layout.diagnostics) else {
            error("Layout diagnostics serialization failed");
            return 0;
        };
        let needed = json.len() + 1;
        if !out.is_null() && capacity >= needed {
            // SAFETY: caller's advertised capacity covers bytes plus terminator.
            unsafe {
                std::ptr::copy_nonoverlapping(json.as_ptr(), out, json.len());
                *out.add(json.len()) = 0;
            }
        }
        needed
    })
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
        let settings = packet
            .settings
            .clone()
            .ok_or("ABI6 requires explicit style settings")?;
        if packet.lines.iter().any(|line| {
            line.paint
                .as_ref()
                .is_none_or(|p| p.words.iter().any(|w| w.appearance.is_none()))
        }) {
            return Err("ABI6 requires prepared voice metadata".into());
        }
        let lines = packet.into_lines();
        let started = Instant::now();
        let key = crate::scene::LayoutCache::key(
            &track_id,
            &lines,
            &settings,
            engine.metrics.width,
            engine.metrics.height,
            engine.scale,
        )
        .map_err(|e| e.to_string())?;
        let layout = if let Some(cached) = engine.layout_cache.take(&key) {
            cached
        } else {
            TrackScene::with_fonts(
                lines.clone(),
                engine.metrics.width,
                engine.metrics.height,
                engine.scale,
                Some(&settings),
                &mut engine.fonts,
            )
            .map_err(|e| e.to_string())?
        };
        engine.metrics.layout_ms = started.elapsed().as_secs_f64() * 1000.0;
        engine.lines = lines;
        engine.track_id = track_id;
        engine.settings = Some(settings);
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
                crate::scene::LayoutCache::key(
                    &engine.track_id,
                    &engine.lines,
                    settings,
                    width,
                    height,
                    scale,
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
                TrackScene::with_fonts(
                    engine.lines.clone(),
                    width,
                    height,
                    scale,
                    engine.settings.as_ref(),
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
        engine.scroll.drag(dy, max_offset);
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
            )
            .map_or(-1, |index| index as i32))
    })
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
        let Some(frame) = engine.surface.acquire().map_err(|e| e.to_string())? else {
            return Ok(2);
        };
        // nextDrawable may have waited. Retain the display target when still
        // future, otherwise use a refreshed sample in the same native clock.
        let native_ms = frame_clock(
            native_ms,
            sampled_native_ms,
            frame_started.elapsed().as_secs_f64() * 1000.0,
        );
        engine.metrics.target_native_ms = native_ms;
        let position = engine.timeline.position(native_ms);
        let started = Instant::now();
        layout.prepare(position).map_err(|e| e.to_string())?;
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
        engine.metrics.animating =
            u32::from(engine.scroll.animating() || engine.appearance.animating());
        engine.metrics.position_ms = position;
        engine.metrics.cpu_scene_ms = started.elapsed().as_secs_f64() * 1000.0;
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
    fn abi_v7_metrics_layout_matches_header() {
        assert_eq!(kr_abi_version(), 7);
        assert_eq!(std::mem::size_of::<Metrics>(), 152);
        assert_eq!(std::mem::offset_of!(Metrics, capabilities), 80);
        assert_eq!(std::mem::offset_of!(Metrics, animating), 84);
        assert_eq!(std::mem::offset_of!(Metrics, acquire_ms), 88);
        assert_eq!(std::mem::offset_of!(Metrics, completed), 120);
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
