// Verifies every RustBridge external fun has a matching JNI symbol, and the CMake header path resolves.
const fs = require("fs"), path = require("path");
const d = __dirname;
const kt = fs.readFileSync(path.join(d, "src/main/java/dev/kineticron/rustlyrics/RustBridge.kt"), "utf8");
const cpp = fs.readFileSync(path.join(d, "src/main/cpp/kinesync_rust_lyrics.cpp"), "utf8");
const ext = [...kt.matchAll(/external fun (\w+)/g)].map((m) => m[1]);
const nat = [...cpp.matchAll(/^FN\(\w+, (\w+)\)/gm)].map((m) => m[1]);
const errs = [];
for (const n of ext) if (!nat.includes(n)) errs.push("missing JNI symbol " + n);
for (const n of nat) if (!ext.includes(n)) errs.push("unused JNI symbol " + n);
if (!/^#define FN\(type, name\)/m.test(cpp)) errs.push("FN macro must take a return type");
const header = path.resolve(d, "src/main/cpp", "../../../../../../../native/lyrics-renderer/include/KineSyncLyrics.h");
if (!fs.existsSync(header)) errs.push("header path unresolved " + header);
const view = fs.readFileSync(path.join(d, "src/main/java/dev/kineticron/rustlyrics/KineSyncRustLyricsView.kt"), "utf8");
const owner = fs.readFileSync(path.join(d, "src/main/java/dev/kineticron/rustlyrics/RustOwner.kt"), "utf8");
if (/textureView\.visibility\s*=/.test(view)) errs.push("TextureView must stay VISIBLE; use alpha");
// Settings must hide the retained texture even when a worker frame arrives late.
const viewMethod = (name) => view.match(new RegExp("\\bfun " + name + "\\([\\s\\S]*?\\n  \\}"))?.[0] || "";
const presentation = viewMethod("updatePresentationVisibility");
const alphaWrites = view.match(/textureView\.alpha\s*=/g) || [];
if (alphaWrites.length !== 1 || !/textureView\.alpha = if \(presentable\) 1f else 0f/.test(presentation)) {
  errs.push("all texture alpha writes must use the centralized presentation gate");
}
for (const name of ["lifecycle", "onDetachedFromWindow", "onSurfaceTextureAvailable", "onSurfaceTextureDestroyed"]) {
  if (!/updatePresentationVisibility\(\)/.test(viewMethod(name))) errs.push(name + " must update texture presentation");
}
for (const name of ["setActive", "onWindowVisibilityChanged", "onAttachedToWindow"]) {
  if (!/lifecycle\(\)/.test(viewMethod(name))) errs.push(name + " must apply the presentation lifecycle");
}
for (const name of ["onSurfaceTextureAvailable", "onSurfaceTextureDestroyed"]) {
  if (!/displayedGeneration = -1L/.test(viewMethod(name))) errs.push(name + " must invalidate the presented generation");
}
if (!/private var displayedGeneration = -1L/.test(view)) errs.push("a new view must start without presented content");
const frame = viewMethod("onFrame");
if (!/session != epoch/.test(frame) || !/frameRevision != requestedRevision \|\| r\.generation != generation/.test(frame) ||
    !/displayedGeneration = r\.generation/.test(frame) ||
    frame.lastIndexOf("lifecycle()") < frame.indexOf("displayedGeneration = r.generation")) {
  errs.push("frame completion must validate its session and revision, then apply the presentation lifecycle");
}
// Exercise the actual Kotlin Boolean expression, which also uses valid JS syntax.
const gate = presentation.match(/val presentable = ([\s\S]*?)\n    textureView\.alpha/);
if (!gate) {
  errs.push("missing texture presentation predicate");
} else {
  const fields = ["attached", "foreground", "enabled", "failed", "surfaceWaiting", "owner", "displayedGeneration", "generation"];
  const presentable = new Function(...fields, "return (" + gate[1] + ");");
  const state = { attached: true, foreground: true, enabled: true, failed: false, surfaceWaiting: false,
    owner: {}, displayedGeneration: 7, generation: 7 };
  const expectPresentation = (label, patch, expected) => {
    const sample = { ...state, ...patch };
    if (presentable(...fields.map((key) => sample[key])) !== expected) errs.push("texture presentation: " + label);
  };
  expectPresentation("current content", {}, true);
  expectPresentation("inactive retained content", { enabled: false }, false);
  expectPresentation("late current frame while inactive", { enabled: false, displayedGeneration: 7 }, false);
  expectPresentation("reactivation with current content", { enabled: true }, true);
  expectPresentation("reactivation with stale content", { enabled: true, generation: 8 }, false);
  expectPresentation("new surface without a frame", { displayedGeneration: -1, generation: 0 }, false);
  for (const patch of [{ attached: false }, { foreground: false }, { failed: true }, { surfaceWaiting: true }, { owner: null }]) {
    expectPresentation("late frame while " + JSON.stringify(patch), { ...patch, displayedGeneration: 7 }, false);
  }
}
if (!/override fun onLayout/.test(view)) errs.push("view must lay out its TextureView");
if (!/onSurfaceTextureDestroyed[\s\S]*?removeFrameCallback/.test(view)) errs.push("destroy must cancel Choreographer");
if (!/onDetachedFromWindow[\s\S]*?velocity\?\.recycle/.test(view)) errs.push("detach must recycle VelocityTracker");
if (!/profilerReason/.test(owner)) errs.push("metrics need profilerReason");
if (/new Owner\{/.test(cpp)) errs.push("use nothrow new");
if (!/override fun onTouchEvent\(event: MotionEvent\): Boolean = true/.test(view)) errs.push("view must claim touches via onTouchEvent");
if (!/override fun dispatchTouchEvent[\s\S]*?return super\.dispatchTouchEvent/.test(view)) errs.push("dispatchTouchEvent must still delegate to super");
if (/requestDisallowInterceptTouchEvent\(true\)/.test(view) === false) errs.push("drag should disallow parent intercept once dragging");
if (!/kPremul/.test(cpp)) errs.push("JNI creation boundary must document premultiplied alpha");
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log("android JNI contract ok:", ext.length, "functions");
