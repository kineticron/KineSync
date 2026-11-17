//! KineSync's iOS layer-only dispatch boundary.
//!
//! The main thread must never wait for the renderer worker or take a lock held
//! by it while configuring. In particular, do not dispatch Surface::configure
//! here: wgpu-core may wait for GPU work before entering the HAL.

#[cfg(target_os = "ios")]
pub(super) fn configure_layer<T: Send>(work: impl FnOnce() -> T + Send) -> T {
    if objc2::MainThreadMarker::new().is_some() {
        return work();
    }

    // exec_sync uses dispatch_sync_f and permits scoped Send captures. Keep
    // panics inside Rust rather than unwinding through libdispatch's C frames.
    let mut result = None;
    dispatch2::DispatchQueue::main().exec_sync(|| {
        debug_assert!(objc2::MainThreadMarker::new().is_some());
        result = Some(std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)));
    });
    match result.expect("main queue completed the layer configuration") {
        Ok(value) => value,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

#[cfg(not(target_os = "ios"))]
pub(super) fn configure_layer<T>(work: impl FnOnce() -> T) -> T {
    work()
}
