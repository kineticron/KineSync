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
