//! Source guards cover iOS-only code on host CI. They do not replace device tests.

use sha2::{Digest, Sha256};
use std::path::Path;

const GPU: &str = include_str!("../src/gpu.rs");
const METAL: &str = include_str!("../vendor/wgpu-hal/src/metal/surface.rs");
const DISPATCH: &str = include_str!("../vendor/wgpu-hal/src/metal/layer_thread.rs");
const SWIFT: &str = include_str!(
    "../../../ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift"
);

fn between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    source
        .split_once(start)
        .unwrap()
        .1
        .split_once(end)
        .unwrap()
        .0
}

#[test]
fn initial_resize_and_outdated_all_use_the_patched_hal() {
    let renderer = GPU.split_once("impl SurfaceRenderer {").unwrap().1;
    let initial = renderer.split_once("pub fn resize(").unwrap().0;
    let resize = between(renderer, "pub fn resize(&mut self, width:", "pub fn ready(");
    let outdated = between(
        renderer,
        "CurrentSurfaceTexture::Outdated => {",
        "other => {",
    );
    assert!(initial.contains("surface.configure(&gpu.device, &config);"));
    assert!(resize.contains("self.surface.configure(&self.gpu.device, &self.config);"));
    assert!(outdated.contains("self.surface.configure(&self.gpu.device, &self.config);"));
    assert_eq!(GPU.matches(".configure(").count(), 3);

    let configure = between(METAL, "unsafe fn configure(", "unsafe fn unconfigure(");
    assert!(
        configure.contains(
            "super::layer_thread::configure_layer(|| self.configure_layer(device, config))"
        )
    );
    assert!(!configure.contains("render_layer.lock()"));
    assert!(!configure.contains("render_layer.set"));
}

#[test]
fn every_layer_setter_is_inside_the_main_thread_boundary() {
    let setters = between(METAL, "fn configure_layer(", "pub fn new(");
    assert!(setters.contains("debug_assert!("));
    assert!(setters.contains("objc2::MainThreadMarker::new().is_some()"));
    assert!(setters.contains("#[cfg(target_os = \"ios\")]"));
    let names = [
        "setOpaque",
        "setDevice",
        "setPixelFormat",
        "setFramebufferOnly",
        "setWantsExtendedDynamicRangeContent",
        "setColorspace",
        "setMaximumDrawableCount",
        "setDrawableSize",
        "setAllowsNextDrawableTimeout",
        "setDisplaySyncEnabled",
    ];
    for name in names {
        let call = format!("render_layer.{name}(");
        assert!(setters.contains(&call), "missing {name}");
    }
    assert_eq!(
        METAL.matches("render_layer.set").count(),
        setters.matches("render_layer.set").count()
    );
    for forbidden in ["nextDrawable(", ".submit(", ".poll(", "waitUntilCompleted("] {
        assert!(
            !setters.contains(forbidden),
            "main must not run {forbidden}"
        );
    }
}

#[test]
fn dispatch_is_scoped_ios_only_and_does_not_unwind_through_c() {
    let ios = between(DISPATCH, "#[cfg(target_os = \"ios\")]", "#[cfg(not(");
    assert!(ios.contains("FnOnce() -> T + Send"));
    assert!(ios.contains("T: Send"));
    let inline = ios
        .find("if objc2::MainThreadMarker::new().is_some()")
        .unwrap();
    let dispatched = ios.find("DispatchQueue::main().exec_sync").unwrap();
    assert!(inline < dispatched);
    assert!(ios[inline..dispatched].contains("return work();"));
    assert!(ios[dispatched..].contains("catch_unwind"));
    assert!(ios.contains("Err(payload) => std::panic::resume_unwind(payload)"));
    assert!(!DISPATCH.contains("exec_async("));
    assert!(!DISPATCH.contains("unsafe"));
}

#[test]
fn swift_keeps_gpu_work_and_retirement_asynchronous() {
    let owner = between(
        SWIFT,
        "private final class RustOwner:",
        "private final class MetalHost:",
    );
    for forbidden in [
        ".sync {",
        ".sync(",
        ".wait(",
        "DispatchSemaphore",
        "DispatchGroup",
    ] {
        assert!(
            !owner.contains(forbidden),
            "main must not wait: {forbidden}"
        );
    }
    let update = between(owner, "private func applyUpdate(", "func setVisible(");
    assert!(update.contains("dispatchPrecondition(condition: .onQueue(queue))"));
    assert!(update.contains("assert(!Thread.isMainThread"));
    let draw = between(owner, "func draw(", "func dispose(");
    assert!(draw.contains("queue.async {"));
    assert!(draw.contains("dispatchPrecondition(condition: .onQueue(self.queue))"));
    assert!(draw.contains("assert(!Thread.isMainThread"));
    let dispose = owner.split_once("func dispose(").unwrap().1;
    assert!(dispose.find("gate.unlock()").unwrap() < dispose.find("queue.async {").unwrap());
    assert!(dispose.contains("kr_destroy(self.handle)"));
    let drain = between(
        owner,
        "private func drainInput()",
        "private func applyUpdate(",
    );
    assert!(drain.find("gate.unlock()").unwrap() < drain.find("applyUpdate(").unwrap());
}

#[test]
fn cargo_resolves_the_vendor_patch_and_ios_only_dispatch_dependency() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains("wgpu-hal = { path = \"vendor/wgpu-hal\" }"));
    let lock = include_str!("../Cargo.lock");
    let hal = between(lock, "name = \"wgpu-hal\"", "[[package]]");
    assert!(hal.contains("version = \"30.0.1\""));
    assert!(!hal.contains("source ="));
    assert!(hal.contains("\"dispatch2\""));
    let vendor_manifest = include_str!("../vendor/wgpu-hal/Cargo.toml");
    assert!(vendor_manifest.contains(
        "[target.'cfg(target_os = \"ios\")'.dependencies.dispatch2]\nversion = \"=0.3.1\""
    ));
    let ci = include_str!("../../../scripts/ios-dev-ci/ci.cjs");
    assert!(ci.contains("'native/lyrics-renderer/vendor'"));
}

#[test]
fn upstream_files_are_intact_outside_the_documented_patch() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/wgpu-hal");
    let provenance: serde_json::Value =
        serde_json::from_str(include_str!("../vendor/wgpu-hal/KINESYNC-PROVENANCE.json")).unwrap();
    let mut modified = Vec::new();
    for (name, hashes) in provenance["files"].as_object().unwrap() {
        let bytes = std::fs::read(root.join(name)).unwrap();
        let actual = format!("{:x}", Sha256::digest(bytes));
        assert_eq!(actual, hashes["patched"].as_str().unwrap(), "{name}");
        if hashes["original"] != hashes["patched"] {
            modified.push(name.as_str());
        }
    }
    assert_eq!(
        modified,
        ["Cargo.toml", "src/metal/mod.rs", "src/metal/surface.rs"]
    );
}

#[cfg(not(target_os = "ios"))]
#[path = "../vendor/wgpu-hal/src/metal/layer_thread.rs"]
mod layer_thread;

#[cfg(not(target_os = "ios"))]
#[test]
fn non_ios_configuration_stays_inline_and_accepts_local_captures() {
    let value = std::rc::Rc::new(std::cell::Cell::new(0));
    let caller = std::thread::current().id();
    let result: Result<_, &str> = layer_thread::configure_layer(|| {
        assert_eq!(caller, std::thread::current().id());
        value.set(1);
        Err("configuration error")
    });
    assert_eq!(value.get(), 1);
    assert_eq!(result, Err::<(), _>("configuration error"));
}
