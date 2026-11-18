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
    pub next_cue_native_ms: f64,
    pub visible_changes: u32,
}
struct Engine {
    timeline: Timeline,
    lines: Vec<Line>,
    fonts: crate::typography::Fonts,
    settings: Option<crate::typography::Settings>,
    credits: Option<crate::live::Credits>,
    empty: Option<crate::live::EmptyState>,
    empty_scene: Option<vello::Scene>,
    overlay: vello::Scene,
    layout: Option<TrackScene>,
    layout_key: String,
    track_id: String,
    layout_cache: crate::scene::LayoutCache,
    #[cfg(not(test))]
    surface: SurfaceRenderer,
    #[cfg(test)]
    surface: TestSurface,
    scene: vello::Scene,
    scale: f32,
    metrics: Metrics,
    scroll: FollowScroll,
    appearance: crate::appearance::AppearanceState,
    /// Skia `following`: manual touch owns the viewport until explicitly resumed.
    following: bool,
    /// Inactive-line blur strength. Manual ownership makes every line sharp.
    /// Re-engaging follow eases this back to one so blur cannot snap on.
    blur: BlurRamp,
}

// Host tests can register real engines for CPU-only ABI calls without a native window.
#[cfg(test)]
struct TestSurface(Option<SurfaceRenderer>);

#[cfg(test)]
impl std::ops::Deref for TestSurface {
    type Target = SurfaceRenderer;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("test engine has no native surface")
    }
}

#[cfg(test)]
impl std::ops::DerefMut for TestSurface {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("test engine has no native surface")
    }
}

/// Blur restoration is deliberately one-way and time based. Manual ownership
/// takes effect on the next frame, while a re-engaged follow ramps over a short
/// interval that keeps the default blur continuous.
const BLUR_RESTORE_MS: f64 = 220.0;

#[derive(Clone, Copy, Debug)]
struct BlurRamp {
    value: f32,
    from: f32,
    start_ms: f64,
    target: f32,
    /// The next actual render frame anchors the tween. A command path can run
    /// long after the last rendered frame, so using its timestamp here would
    /// skip the whole ramp after an idle manual view.
    pending_start: bool,
}

impl Default for BlurRamp {
    fn default() -> Self {
        Self {
            value: 1.0,
            from: 1.0,
            start_ms: 0.0,
            target: 1.0,
            pending_start: false,
        }
    }
}

impl BlurRamp {
    /// A new song never inherits the previous song's sharp manual viewport.
    fn reset(&mut self) {
        *self = Self::default();
    }

    /// Manual drag, inertia or an explicit follow cancel removes blur now.
    fn sharp(&mut self) {
        self.value = 0.0;
        self.from = 0.0;
        self.start_ms = 0.0;
        self.target = 0.0;
        self.pending_start = false;
    }

    /// Start or continue a smooth return to the default blur. Calling this
    /// again during the same ramp must not restart it. The first render after
    /// this call keeps the sharp frame and anchors the 220 ms tween to its own
    /// clock rather than to a stale command timestamp.
    fn restore(&mut self) {
        if self.target < 1.0 {
            self.from = self.value;
            self.start_ms = 0.0;
            self.target = 1.0;
            self.pending_start = true;
        }
    }

    /// Returns true while a restore still needs another frame. The native
    /// owners keep scheduling on this even when playback and scrolling pause.
    fn advance(&mut self, now_ms: f64) -> bool {
        if self.target <= 0.0 {
            self.value = 0.0;
            self.pending_start = false;
            return false;
        }
        if self.value >= 1.0 {
            self.value = 1.0;
            self.pending_start = false;
            return false;
        }
        if self.pending_start {
            self.start_ms = now_ms.max(0.0);
            self.pending_start = false;
            return true;
        }
        let progress = ((now_ms - self.start_ms) / BLUR_RESTORE_MS).clamp(0.0, 1.0);
        let eased = progress * progress * (3.0 - 2.0 * progress);
        self.value = (f64::from(self.from) + (1.0 - f64::from(self.from)) * eased) as f32;
        if progress >= 1.0 {
            self.value = 1.0;
            false
        } else {
            true
        }
    }
}
static ENGINES: OnceLock<Mutex<HashMap<u64, Engine>>> = OnceLock::new();
#[cfg(any(target_os = "ios", target_os = "android"))]
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
    11
}
/// # Safety
/// `layer` is a CAMetalLayer on iOS or ANativeWindow on Android.
/// The native owner retains it until kr_destroy completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kr_create(layer: *mut c_void, width: u32, height: u32, scale: f32) -> u64 {
    boundary(0, || {
        if let Err(message) = dimensions(width, height, scale) {
            error(message);
            return 0;
        }
        if layer.is_null() {
            error("Null native surface");
            return 0;
        }
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            let result = (|| -> Result<Engine, Box<dyn std::error::Error>> {
                #[cfg(target_os = "ios")]
                let backends = wgpu::Backends::METAL;
                #[cfg(target_os = "android")]
                let backends = wgpu::Backends::VULKAN;
                let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                    backends,
                    ..wgpu::InstanceDescriptor::new_without_display_handle()
                });
                // SAFETY: caller retains the layer, serial owner drops surface before releasing it.
                #[cfg(target_os = "ios")]
                let surface = unsafe {
                    instance
                        .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
                }?;
                // SAFETY: JNI owns an acquired ANativeWindow until after kr_destroy.
                #[cfg(target_os = "android")]
                let surface = unsafe {
                    use wgpu::rwh::{
                        AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle,
                        RawWindowHandle,
                    };
                    let window = std::ptr::NonNull::new(layer).ok_or("Null ANativeWindow")?;
                    instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                        raw_display_handle: Some(RawDisplayHandle::Android(
                            AndroidDisplayHandle::new(),
                        )),
                        raw_window_handle: RawWindowHandle::AndroidNdk(
                            AndroidNdkWindowHandle::new(window),
                        ),
                    })
                }?;
                let surface = pollster::block_on(SurfaceRenderer::new(
                    instance, surface, width, height, scale,
                ))?;
                Ok(Engine {
                    scroll: FollowScroll::default(),
                    appearance: crate::appearance::AppearanceState::default(),
                    following: true,
                    blur: BlurRamp::default(),
                    timeline: Timeline::default(),
                    lines: Vec::new(),
                    fonts: crate::typography::Fonts::default(),
                    settings: None,
                    credits: None,
                    empty: None,
                    empty_scene: None,
                    overlay: vello::Scene::new(),
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
                    #[cfg(not(test))]
                    surface,
                    #[cfg(test)]
                    surface: TestSurface(Some(surface)),
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
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            error("Rust native surfaces require an iOS or Android build");
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
        let track_changed = track_id != engine.track_id;
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
        let empty = packet.empty.clone();
        let lines = packet.into_lines();
        if let Some(empty) = empty {
            engine.empty_scene = Some(crate::credits::empty_scene(
                &empty,
                engine.metrics.width,
                engine.metrics.height,
                engine.scale,
                &mut engine.fonts,
            ));
            engine.empty = Some(empty);
            engine.layout = None;
            engine.lines.clear();
            engine.layout_key.clear();
            engine.track_id = track_id;
            engine.settings = Some(settings);
            engine.credits = None;
            reset_track_scroll(&mut engine.scroll, &mut engine.following, track_changed);
            if track_changed {
                engine.blur.reset();
            }
            engine.timeline.replace(generation);
            engine.appearance.reset();
            engine.metrics.generation = generation;
            engine.metrics.animating = 0;
            engine.metrics.visible_changes = 0;
            engine.metrics.next_cue_native_ms = -1.0;
            return Ok(0);
        }
        engine.empty = None;
        engine.empty_scene = None;
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
        let mut layout = if let Some(cached) = engine.layout_cache.take(&key) {
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
        if track_changed {
            reset_track_scroll(&mut engine.scroll, &mut engine.following, true);
            engine.blur.reset();
        }
        replace_track_scroll(
            &mut engine.scroll,
            engine.layout.as_ref(),
            &mut layout,
            engine.track_id == track_id,
            engine.following,
            engine.metrics.position_ms,
        )?;
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
        engine.appearance.reset();
        engine.metrics.generation = generation;
        Ok(0)
    })
}

/// Scene replacement resets animation history, not same-track manual ownership.
pub(crate) fn replace_track_scroll(
    scroll: &mut FollowScroll,
    previous: Option<&TrackScene>,
    next: &mut TrackScene,
    same_track: bool,
    following: bool,
    time: f64,
) -> Result<(), String> {
    // Cached variants must not retain an anchor from an earlier activation.
    next.clear_manual_anchor();
    let pending_snap = same_track && scroll.explicit_snap_pending();
    let manual = previous
        .filter(|old| {
            same_track
                && !following
                && old.lines.len() == next.lines.len()
                && old.lines.iter().zip(&next.lines).all(|(a, b)| {
                    a.text == b.text
                        && a.start == b.start
                        && a.end == b.end
                        && a.background_end == b.background_end
                })
        })
        .map(|old| next.remap_manual_scroll(old, scroll.position(), time))
        .transpose()
        .map_err(|e| e.to_string())?;
    scroll.configure(
        next.style().unwrap_or(crate::typography::Style::Spicy),
        f64::from(next.scale),
        next.lines.len(),
    );
    scroll.reset();
    if let Some(position) = manual {
        scroll.restore_manual(position, next.max_scroll(), f64::from(next.height));
    }
    if pending_snap {
        scroll.snap_next();
    }
    Ok(())
}

pub(crate) fn resize_track_scroll(
    scroll: &mut FollowScroll,
    previous: &TrackScene,
    next: &mut TrackScene,
    following: bool,
    time: f64,
    ratio: f64,
) -> Result<(), String> {
    next.clear_manual_anchor();
    let manual = if following {
        None
    } else {
        Some(
            next.remap_manual_scroll(previous, scroll.position(), time)
                .map_err(|e| e.to_string())?,
        )
    };
    scroll.remap(
        previous.scroll_target(time),
        next.scroll_target(time),
        ratio,
    );
    scroll.configure(
        next.style().unwrap_or(crate::typography::Style::Spicy),
        f64::from(next.scale),
        next.lines.len(),
    );
    if let Some(position) = manual {
        scroll.relocate_manual(position, next.max_scroll(), f64::from(next.height));
    }
    Ok(())
}

/// A new song starts a fresh follow owner. Same-track packet revisions for
/// translation, credits or layout keep the user's manual ownership.
fn reset_track_scroll(scroll: &mut FollowScroll, following: &mut bool, track_changed: bool) {
    scroll.reset();
    if track_changed {
        scroll.resume_follow();
        *following = true;
    }
}

// Internal monotonic input clock. No cross-language clock or ABI change.
fn gesture_clock_ms() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
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
        let mut layout = if engine.lines.is_empty() {
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
        if let (Some(previous), Some(layout)) = (engine.layout.as_ref(), &mut layout) {
            resize_track_scroll(
                &mut engine.scroll,
                previous,
                layout,
                engine.following,
                position,
                f64::from(scale / engine.scale),
            )?;
        }
        if let Some(old) = engine.layout.take() {
            engine
                .layout_cache
                .insert(std::mem::take(&mut engine.layout_key), old);
        }
        engine.layout_key = key;
        engine.layout = layout;
        engine.appearance.reset();
        if let Some(empty) = &engine.empty {
            engine.empty_scene = Some(crate::credits::empty_scene(
                empty,
                width,
                height,
                scale,
                &mut engine.fonts,
            ));
        }
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
        // A footer tap can take manual ownership without a drag or fling.
        // Retain the current offset within the live scene's scroll bounds.
        if engine.following
            && !following
            && let Some(layout) = &engine.layout
        {
            engine
                .scroll
                .set_manual_bounds(layout.max_scroll(), f64::from(layout.height));
        }
        engine.following = following;
        if following {
            engine.scroll.resume_follow();
            if let Some(layout) = &mut engine.layout {
                layout.clear_manual_anchor();
            }
            engine.blur.restore();
        } else {
            engine.blur.sharp();
        }
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
        if let Some(layout) = &mut engine.layout {
            layout.clear_manual_anchor();
        }
        let scale = f64::from(engine.scale.max(0.001));
        let viewport = f64::from(engine.metrics.height);
        let target = release_target(
            engine.layout.as_ref(),
            engine.timeline.anchored,
            engine.metrics.generation,
            engine.timeline.generation,
            engine.metrics.position_ms,
        );
        engine
            .scroll
            .note_manual_input(dy * scale, target, gesture_clock_ms());
        engine.scroll.drag(dy * scale, max_offset, viewport);
        engine.following = false;
        engine.blur.sharp();
        Ok(0)
    })
}
/// Release recapture needs an anchored timeline whose generation matches the
/// prepared layout. Without both, the current offset is not an active target.
fn release_target(
    layout: Option<&TrackScene>,
    anchored: bool,
    layout_generation: u64,
    timeline_generation: u64,
    position_ms: f64,
) -> Option<f64> {
    if !anchored || layout_generation != timeline_generation {
        return None;
    }
    layout.map(|layout| layout.scroll_target(position_ms))
}

/// Manual fling velocity in logical points per millisecond. Negative values
/// move content up (finger swiped up); the native model owns deceleration.
/// `native_ms` is the release monotonic clock, so an anchor accepted after the
/// last rendered frame still classifies the current song time. Returns 1 when
/// the release re-engaged auto-follow, 0 when it stayed manual.
#[unsafe(no_mangle)]
pub extern "C" fn kr_fling(handle: u64, velocity: f64, native_ms: f64) -> i32 {
    with(handle, |engine| {
        if !velocity.is_finite() || !native_ms.is_finite() || native_ms < 0.0 {
            return Err("Invalid fling release".into());
        }
        let max_offset = engine.layout.as_ref().map_or(0.0, TrackScene::max_scroll);
        if let Some(layout) = &mut engine.layout {
            layout.clear_manual_anchor();
        }
        let scale = f64::from(engine.scale.max(0.001));
        let viewport = f64::from(engine.metrics.height);
        // A release close to the active line hands ownership back to follow.
        // A far release keeps manual ownership, and an active drag never
        // reaches this path because `kr_scroll_by` only freezes follow.
        let target = release_target(
            engine.layout.as_ref(),
            engine.timeline.anchored,
            engine.metrics.generation,
            engine.timeline.generation,
            engine.timeline.position(native_ms),
        );
        let resume = engine.scroll.release(
            velocity * scale,
            max_offset,
            viewport,
            target,
            gesture_clock_ms(),
        );
        engine.following = resume;
        if resume {
            engine.scroll.resume_follow();
            engine.blur.restore();
        } else {
            engine.blur.sharp();
        }
        Ok(if resume { 1 } else { 0 })
    })
}
/// Logical surface point to row index or ABI10 footer target from the shared layout.
#[unsafe(no_mangle)]
pub extern "C" fn kr_hit_test(handle: u64, x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        error("Invalid hit-test point");
        return -1;
    }
    with(handle, |engine| {
        let Some(layout) = engine.layout.as_ref() else {
            return Ok(-1);
        };
        let footer = layout.footer_hit(
            x * f64::from(engine.scale),
            y * f64::from(engine.scale),
            engine.scroll.position(),
            engine.metrics.position_ms,
        );
        if footer != -1 {
            return Ok(footer);
        }
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
    manual_scroll: Option<f64>,
}

/// Never shape with a drawable held. A stall crossing a geometry boundary
/// retires that drawable before retrying. No animation state is sampled here.
fn prepare_drawable<T>(
    layout: &mut TrackScene,
    timeline: &Timeline,
    mut manual_scroll: Option<f64>,
    mut clock: impl FnMut() -> f64,
    mut acquire: impl FnMut() -> Result<Option<T>, String>,
) -> Result<Option<PreparedDrawable<T>>, String> {
    let mut preparation_ms = 0.0;
    for _ in 0..2 {
        let position = timeline.position(clock());
        let started = Instant::now();
        layout.prepare(position).map_err(|e| e.to_string())?;
        if let Some(scroll) = manual_scroll {
            manual_scroll = Some(
                layout
                    .prepare_manual_viewport(scroll)
                    .map_err(|e| e.to_string())?,
            );
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
                manual_scroll: manual_scroll.filter(|_| layout.has_manual_anchor()),
            }));
        }
        drop(drawable);
    }
    // No drawable for a fully prepared current frame. The native owner's
    // existing bounded unavailable-drawable retry supplies another fresh clock.
    Ok(None)
}

#[cfg(test)]
pub(crate) fn manual_frame_for_test(
    layout: &mut TrackScene,
    scroll: &mut FollowScroll,
    time: f64,
    native_ms: f64,
) -> f64 {
    let mut timeline = Timeline::default();
    timeline.replace(1);
    timeline
        .anchor(1, 1, time, native_ms, native_ms, false, 1.0)
        .unwrap();
    let prepared = prepare_drawable(
        layout,
        &timeline,
        Some(scroll.position()),
        || native_ms,
        || Ok(Some(())),
    )
    .unwrap()
    .unwrap();
    if let Some(offset) = prepared.manual_scroll {
        scroll.relocate_manual(offset, layout.max_scroll(), f64::from(layout.height));
    }
    scroll.sample(
        &layout.scroll_command(time, scroll.position()),
        native_ms,
        false,
    )
}

/// A missing layout after an anchor is transient readiness, not missing input.
/// Report it like an unavailable drawable so the native owner retries instead
/// of parking the display loop until an unrelated handshake arrives.
fn missing_layout_status(anchored: bool) -> i32 {
    if anchored { 2 } else { 1 }
}

/// Returns 0 after present call, 1 awaiting input, 2 no drawable, 3 GPU capacity, -1 failure.
#[unsafe(no_mangle)]
pub extern "C" fn kr_render(
    handle: u64,
    native_ms: f64,
    sampled_native_ms: f64,
    resume_step_ms: f64,
) -> i32 {
    with(handle, |engine| {
        let frame_started = Instant::now();
        if !native_ms.is_finite()
            || native_ms < 0.0
            || !sampled_native_ms.is_finite()
            || sampled_native_ms < 0.0
            || !resume_step_ms.is_finite()
            || !(0.0..=1000.0).contains(&resume_step_ms)
        {
            return Err("Invalid native frame clock".into());
        }
        if let Some(scene) = &engine.empty_scene {
            if !engine.surface.ready().map_err(|e| e.to_string())? {
                return Ok(3);
            }
            let Some(frame) = engine.surface.acquire().map_err(|e| e.to_string())? else {
                return Ok(2);
            };
            let (stats, present) = engine
                .surface
                .render(scene, (0.0, engine.metrics.height as f32), frame)
                .map_err(|e| e.to_string())?;
            engine.metrics.frames += 1;
            engine.metrics.cpu_encode_ms = stats.cpu_encode_ms;
            engine.metrics.cpu_blit_ms = present;
            engine.metrics.target_native_ms = native_ms;
            engine.metrics.animating = 0;
            engine.metrics.next_cue_native_ms = -1.0;
            return Ok(0);
        }
        let Some(layout) = &mut engine.layout else {
            return Ok(missing_layout_status(engine.timeline.anchored));
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
        if let Some(scroll) = prepared.manual_scroll {
            engine
                .scroll
                .relocate_manual(scroll, layout.max_scroll(), f64::from(layout.height));
        }
        let native_ms = prepared.native_ms;
        engine.metrics.target_native_ms = native_ms;
        let position = engine.timeline.position(native_ms);
        let started = Instant::now();
        if resume_step_ms > 0.0 {
            engine.appearance.resume(native_ms, resume_step_ms);
            engine.scroll.resume(native_ms, resume_step_ms);
        }
        // Geometry changes reach the tween through `command.offset`; remapping
        // here would clear the spring history every frame.
        let command = layout.scroll_command(position, engine.scroll.position());
        let scroll = engine.scroll.sample(&command, native_ms, engine.following);
        let blur_animating = engine.blur.advance(native_ms);
        let blur = engine.blur.value;
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
        layout.frame_overlay(position, scroll, &mut engine.overlay);
        let schedule = layout.frame_schedule(
            position,
            scroll,
            engine.scroll.row_adjustments(),
            &engine.appearance,
            engine.scroll.animating(),
            engine.timeline.playing && engine.timeline.rate > 0.0,
        );
        engine.metrics.animating = u32::from(schedule.continuous || blur_animating);
        engine.metrics.visible_changes = u32::from(schedule.visible_changes);
        engine.metrics.next_cue_native_ms = crate::scheduling::native_cue(
            position,
            native_ms,
            engine.timeline.rate,
            schedule.next_cue,
        );
        engine.metrics.position_ms = position;
        engine.metrics.cpu_scene_ms =
            prepared.preparation_ms + started.elapsed().as_secs_f64() * 1000.0;
        let (stats, present) = engine
            .surface
            .render_overlay_scaled(
                &engine.scene,
                &engine.overlay,
                band,
                frame,
                crate::appearance::LIVE_EFFECT.glow(),
                blur,
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
    fn credits_switch_ffi_follow_disable_keeps_the_maker_viewport() {
        use crate::{credits_switch_tests::track, typography::Style};

        const HANDLE: u64 = u64::MAX - 1;
        let (width, height, scale) = (900, 1329, 1.5);
        let time = 51_600.0;
        let mut layout = track(Style::Spicy, width, height, scale);
        layout.prepare(time).unwrap();
        let mut timeline = Timeline::default();
        assert!(timeline.replace(1));
        assert!(
            timeline
                .anchor(1, 1, time, 1000.0, 1000.0, false, 1.0)
                .unwrap()
        );
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, f64::from(scale), layout.lines.len());
        let command = layout.scroll_command(time, 0.0);
        let before_tap = scroll.sample(&command, 1000.0, true);
        assert!(before_tap > 0.0 && before_tap <= layout.max_scroll());
        let engine = Engine {
            timeline,
            lines: layout.lines.clone(),
            fonts: crate::typography::Fonts::default(),
            settings: None,
            credits: None,
            empty: None,
            empty_scene: None,
            overlay: vello::Scene::new(),
            layout: Some(layout),
            layout_key: String::new(),
            track_id: "fx-track-credits".into(),
            layout_cache: crate::scene::LayoutCache::default(),
            surface: TestSurface(None),
            scene: vello::Scene::new(),
            scale,
            metrics: Metrics {
                width,
                height,
                position_ms: time,
                generation: 1,
                ..Metrics::default()
            },
            scroll,
            appearance: crate::appearance::AppearanceState::default(),
            following: true,
            blur: BlurRamp::default(),
        };
        let previous = engines().lock().unwrap().insert(HANDLE, engine);
        assert!(previous.is_none());

        let status = kr_set_following(HANDLE, false);
        let sampled = with(HANDLE, |engine| {
            assert!(!engine.following);
            let layout = engine.layout.as_ref().unwrap();
            for frame in 0..10 {
                let native_ms = 1016.0 + f64::from(frame) * 16.0;
                let command = layout.scroll_command(
                    engine.timeline.position(native_ms),
                    engine.scroll.position(),
                );
                let offset = engine.scroll.sample(&command, native_ms, engine.following);
                assert_eq!(offset, before_tap);
                assert!(!engine.scroll.animating());
            }
            Ok(0)
        });
        assert_eq!(kr_destroy(HANDLE), 0);
        assert_eq!(status, 0);
        assert_eq!(sampled, 0);
    }

    #[test]
    fn abi_v11_metrics_layout_matches_header() {
        assert_eq!(kr_abi_version(), 11);
        assert_eq!(std::mem::size_of::<Metrics>(), 168);
        assert_eq!(std::mem::offset_of!(Metrics, capabilities), 80);
        assert_eq!(std::mem::offset_of!(Metrics, animating), 84);
        assert_eq!(std::mem::offset_of!(Metrics, acquire_ms), 88);
        assert_eq!(std::mem::offset_of!(Metrics, completed), 120);
        assert_eq!(std::mem::offset_of!(Metrics, next_cue_native_ms), 152);
        assert_eq!(std::mem::offset_of!(Metrics, visible_changes), 160);
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
    fn new_track_resets_manual_follow_ownership_and_snaps_to_its_target() {
        use crate::typography::Style;
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 3.0, 8);
        let old = crate::motion::Command {
            offset: 500.0,
            interval: 800.0,
            interlude: false,
            first_visible: 0,
            index: 1,
            visible: 0..8,
            scale: 3.0,
            style: Style::Spicy,
        };
        scroll.sample(&old, 0.0, true);
        scroll.note_manual_input(180.0, Some(old.offset), 0.0);
        scroll.drag(180.0, 2_000.0, 800.0);
        let mut following = false;
        reset_track_scroll(&mut scroll, &mut following, true);
        assert!(following, "a new song must not inherit manual ownership");
        let fresh = crate::motion::Command {
            offset: 900.0,
            ..old
        };
        assert_eq!(scroll.sample(&fresh, 2_000.0, true), 900.0);
        assert!(!scroll.animating());
        // The fresh song must not inherit the previous song's grace deadline.
        scroll.note_manual_input(-20.0, Some(880.0), 100.0);
        scroll.drag(-20.0, 2_000.0, 800.0);
        assert!(scroll.release(0.0, 2_000.0, 800.0, Some(880.0), 100.0));
    }

    #[test]
    fn same_track_revision_keeps_manual_follow_ownership() {
        use crate::typography::Style;
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Amll, 3.0, 8);
        let mut following = false;
        reset_track_scroll(&mut scroll, &mut following, false);
        assert!(
            !following,
            "translation, credits and layout revisions must keep manual ownership"
        );
    }

    #[test]
    fn manual_scroll_sharpens_and_follow_reengage_restores_blur_smoothly() {
        let mut blur = BlurRamp::default();
        assert_eq!(blur.value, 1.0);
        // Drag entry and inertia both keep every line sharp.
        blur.sharp();
        assert_eq!(blur.value, 0.0);
        assert!(!blur.advance(1_000.0));
        // A near-active release starts a tween rather than snapping blur on.
        // The first render remains sharp and anchors the tween.
        blur.restore();
        assert!(blur.advance(1_000.0));
        assert_eq!(blur.value, 0.0);
        let quarter = {
            blur.advance(1_055.0);
            blur.value
        };
        assert!(quarter > 0.0 && quarter < 1.0, "quarter value {quarter}");
        let half = {
            blur.advance(1_110.0);
            blur.value
        };
        assert!(half > quarter && half < 1.0, "half value {half}");
        assert!(blur.advance(1_219.0));
        assert!(!blur.advance(1_220.0));
        assert_eq!(blur.value, 1.0);
        // Repeated follow reconciliation during the ramp must not restart it.
        blur.sharp();
        blur.restore();
        blur.restore();
        assert!(blur.advance(2_000.0));
        blur.advance(2_110.0);
        assert!(blur.value > 0.0);
    }

    #[test]
    fn cancel_and_track_change_do_not_leave_stale_manual_blur() {
        let mut blur = BlurRamp::default();
        blur.sharp();
        blur.restore();
        assert!(blur.advance(4_000.0));
        blur.advance(4_100.0);
        assert!(blur.value > 0.0 && blur.value < 1.0);
        // A new drag during restoration cancels it and returns to sharp.
        blur.sharp();
        assert_eq!(blur.value, 0.0);
        assert!(!blur.advance(4_150.0));
        // A new track restores the default blur immediately.
        blur.reset();
        assert_eq!(blur.value, 1.0);
        assert!(!blur.advance(4_200.0));
        // An explicit follow cancel while already sharp stays inert.
        blur.sharp();
        blur.sharp();
        assert_eq!(blur.value, 0.0);
    }

    #[test]
    fn blur_restore_keeps_animating_while_playback_and_scroll_are_paused() {
        let mut blur = BlurRamp::default();
        blur.sharp();
        // The view was manual and paused long after its last frame.
        blur.restore();
        // The first actual frame after the idle gap is still sharp and only
        // anchors the tween, so a stale timestamp cannot skip the ramp.
        assert!(blur.advance(69_000.0));
        assert_eq!(blur.value, 0.0);
        // The render loop must keep requesting frames only because of blur.
        assert!(blur.advance(69_030.0));
        assert!(blur.value > 0.0 && blur.value < 1.0);
        assert!(blur.advance(69_219.0));
        assert!(!blur.advance(69_220.0));
        assert_eq!(blur.value, 1.0);
    }

    #[test]
    fn release_target_requires_ready_layout_anchor_and_matching_generation() {
        let track = preparation_track();
        let position = track.lines[0].start + 1.0;
        assert!(release_target(None, true, 1, 1, position).is_none());
        assert!(release_target(Some(&track), false, 1, 1, position).is_none());
        assert!(release_target(Some(&track), true, 1, 2, position).is_none());
        assert_eq!(
            release_target(Some(&track), true, 1, 1, position),
            Some(track.scroll_target(position))
        );
    }

    #[test]
    fn release_target_projects_the_current_anchor_and_rejects_an_old_song() {
        let track = preparation_track();
        let mut timeline = Timeline::default();
        assert!(timeline.replace(1));
        assert!(timeline.anchor(1, 1, 1_000.0, 0.0, 0.0, true, 1.0).unwrap());
        let projected = timeline.position(500.0);
        assert_eq!(
            release_target(
                Some(&track),
                timeline.anchored,
                1,
                timeline.generation,
                projected
            ),
            Some(track.scroll_target(projected)),
            "a seek accepted before the next frame uses the projected anchor"
        );
        // A new track before the next frame leaves the timeline unanchored and
        // rejects an anchor from the old song, so release cannot recapture.
        assert!(timeline.replace(2));
        assert!(
            !timeline
                .anchor(1, 2, 9_000.0, 500.0, 500.0, true, 1.0)
                .unwrap()
        );
        assert!(
            release_target(
                Some(&track),
                timeline.anchored,
                2,
                timeline.generation,
                1_500.0
            )
            .is_none()
        );
    }

    #[test]
    fn missing_layout_after_an_anchor_requests_retry_not_a_parked_loop() {
        assert_eq!(missing_layout_status(false), 1);
        assert_eq!(missing_layout_status(true), 2);
    }

    #[test]
    fn panic_containment_and_invalid_handles() {
        assert_eq!(boundary(-7, || panic!("test panic")), -7);
        assert_eq!(kr_render(u64::MAX, 0.0, 0.0, 0.0), -1);
        assert_eq!(kr_destroy(u64::MAX), 0);
        assert_eq!(kr_set_following(u64::MAX, false), -1);
        assert_eq!(kr_scroll_by(u64::MAX, 10.0), -1);
        assert_eq!(kr_hit_test(u64::MAX, 10.0, 10.0), -1);
        let mut message = [0i8; 256];
        // SAFETY: stack output buffer has the advertised capacity.
        unsafe {
            kr_copy_error(message.as_mut_ptr(), message.len());
        }
        assert_ne!(message[0], 0);
    }
}
