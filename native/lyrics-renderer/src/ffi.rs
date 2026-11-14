//! C ABI. All calls are serialized by the native owner; registry also rejects stale handles.
//! Panics are caught before crossing C. Pointer buffers must be valid for their supplied length.
use crate::{
    Line,
    gpu::SurfaceRenderer,
    live::{Timeline, TrackPacket},
    motion::Scroll,
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
    pub present_wait_ms: f64,
    pub layout_ms: f64,
    pub width: u32,
    pub height: u32,
    pub capabilities: u32,
    pub animating: u32,
}
struct Engine {
    timeline: Timeline,
    lines: Vec<Line>,
    layout: Option<TrackScene>,
    surface: SurfaceRenderer,
    scene: vello::Scene,
    scale: f32,
    metrics: Metrics,
    scroll: Scroll,
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
    2
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
                    scroll: Scroll::default(),
                    timeline: Timeline::default(),
                    lines: Vec::new(),
                    layout: None,
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
        let lines = packet.into_lines();
        let started = Instant::now();
        let layout = TrackScene::from_lines(
            lines.clone(),
            engine.metrics.width,
            engine.metrics.height,
            engine.scale,
        )
        .map_err(|e| e.to_string())?;
        engine.metrics.layout_ms = started.elapsed().as_secs_f64() * 1000.0;
        engine.lines = lines;
        engine.layout = Some(layout);
        engine.timeline.replace(generation);
        engine.scroll.reset();
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
            engine.scroll.reset();
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
        let layout = if engine.lines.is_empty() {
            None
        } else {
            Some(
                TrackScene::from_lines(engine.lines.clone(), width, height, scale)
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
        }
        engine.layout = layout;
        engine.scale = scale;
        engine.metrics.width = width;
        engine.metrics.height = height;
        engine.metrics.layout_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(0)
    })
}
/// Returns 0 if presented, 1 if awaiting track/anchor, 2 for retryable surface acquisition, -1 on failure.
#[unsafe(no_mangle)]
pub extern "C" fn kr_render(handle: u64, native_ms: f64) -> i32 {
    with(handle, |engine| {
        if !native_ms.is_finite() || native_ms < 0.0 {
            return Err("Invalid native frame clock".into());
        }
        let Some(layout) = &engine.layout else {
            return Ok(1);
        };
        if !engine.timeline.anchored {
            return Ok(1);
        }
        let position = engine.timeline.position(native_ms);
        let started = Instant::now();
        let scroll = engine
            .scroll
            .sample(layout.scroll_target(position), native_ms);
        let band = layout.frame_at(position, scroll, &mut engine.scene);
        engine.metrics.animating = u32::from(engine.scroll.animating());
        engine.metrics.position_ms = position;
        engine.metrics.cpu_scene_ms = started.elapsed().as_secs_f64() * 1000.0;
        let Some((stats, present)) = engine
            .surface
            .render(&engine.scene, band)
            .map_err(|e| e.to_string())?
        else {
            return Ok(2);
        };
        engine.metrics.frames += 1;
        engine.metrics.cpu_encode_ms = stats.cpu_encode_ms;
        engine.metrics.gpu_interval_ms = stats.gpu_interval_ms.unwrap_or(-1.0);
        engine.metrics.wait_ms = stats.wait_readback_ms;
        engine.metrics.present_wait_ms = present;
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
    fn abi_v2_metrics_layout_matches_header() {
        assert_eq!(kr_abi_version(), 2);
        assert_eq!(std::mem::size_of::<Metrics>(), 88);
        assert_eq!(std::mem::offset_of!(Metrics, capabilities), 80);
        assert_eq!(std::mem::offset_of!(Metrics, animating), 84);
    }
    #[test]
    fn panic_containment_and_invalid_handles() {
        assert_eq!(boundary(-7, || panic!("test panic")), -7);
        assert_eq!(kr_render(u64::MAX, 0.0), -1);
        assert_eq!(kr_destroy(u64::MAX), 0);
        let mut message = [0i8; 256];
        // SAFETY: stack output buffer has the advertised capacity.
        unsafe {
            kr_copy_error(message.as_mut_ptr(), message.len());
        }
        assert_ne!(message[0], 0);
    }
}
