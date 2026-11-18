// JNI shim over the shared Rust C ABI. The Rust side owns the Vulkan surface;
// here we only pin the ANativeWindow until kr_destroy has returned.
#include <android/log.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <jni.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>
#include <cstdint>
#include <cstdlib>
#include <new>
#include <vector>
#include "KineSyncLyrics.h"

namespace {
struct Owner {
  uint64_t handle;
  ANativeWindow *window;
  // JNI calls for each owner are serialized on the shared worker.
  unsigned diagRenders;
  unsigned diagRenderFailures;
  unsigned diagFonts;
  unsigned diagTracks;
};
inline Owner *owner(jlong p) { return reinterpret_cast<Owner *>(p); }

bool takeDiag(unsigned &count, unsigned limit = 6) {
  if (count >= limit) return false;
  ++count;
  return true;
}
}  // namespace

#define DIAG(format, ...) do { \
  timespec stamp{}; \
  clock_gettime(CLOCK_MONOTONIC, &stamp); \
  char threadName[16]{}; \
  prctl(PR_GET_NAME, threadName, 0L, 0L, 0L); \
  __android_log_print(ANDROID_LOG_INFO, "KSRustDiag", "monoNs=%lld tid=%d thread=%s " format, \
      static_cast<long long>(stamp.tv_sec) * 1000000000LL + stamp.tv_nsec, \
      static_cast<int>(gettid()), threadName, __VA_ARGS__); \
} while (false)

#define FN(type, name) extern "C" JNIEXPORT type JNICALL Java_dev_kineticron_rustlyrics_RustBridge_##name

FN(jint, abiVersion)(JNIEnv *, jobject) { return static_cast<jint>(kr_abi_version()); }

// Creation boundary: the Surface comes from a non-opaque TextureView, whose consumer
// (HWUI) imports the buffer as premultiplied RGBA (kPremul, see
// https://android.googlesource.com/platform/frameworks/base/+/master/libs/hwui/AutoBackendTextureRelease.cpp).
// The Rust side must therefore pick a premultiplied/INHERIT composite alpha mode under Android WSI.
// Returns an opaque owner pointer, 0 on failure. The window is acquired here
// and released only by destroy, after kr_destroy.
FN(jlong, create)(JNIEnv *env, jobject, jobject surface, jint width, jint height, jfloat scale) {
  DIAG("jni.create window.enter size=%dx%d scale=%g", width, height, scale);
  ANativeWindow *window = ANativeWindow_fromSurface(env, surface);
  DIAG("jni.create window.exit window=%p", static_cast<void *>(window));
  if (!window) return 0;
  DIAG("jni.create kr_create.enter window=%p", static_cast<void *>(window));
  uint64_t handle = kr_create(window, static_cast<uint32_t>(width), static_cast<uint32_t>(height), scale);
  DIAG("jni.create kr_create.exit window=%p rustHandle=%llu",
      static_cast<void *>(window), static_cast<unsigned long long>(handle));
  if (handle == 0) {
    DIAG("jni.create window.release.enter window=%p reason=kr_createFailed", static_cast<void *>(window));
    ANativeWindow_release(window);
    DIAG("jni.create window.release.exit reason=kr_createFailed rustHandle=%llu",
        static_cast<unsigned long long>(handle));
    return 0;
  }
  Owner *o = new (std::nothrow) Owner{handle, window, 0, 0, 0, 0};
  if (!o) {
    DIAG("jni.create kr_destroy.enter reason=ownerAllocFailed rustHandle=%llu",
        static_cast<unsigned long long>(handle));
    jint status = kr_destroy(handle);
    DIAG("jni.create kr_destroy.exit rustHandle=%llu status=%d",
        static_cast<unsigned long long>(handle), status);
    DIAG("jni.create window.release.enter window=%p reason=ownerAllocFailed", static_cast<void *>(window));
    ANativeWindow_release(window);
    DIAG("jni.create window.release.exit reason=ownerAllocFailed rustHandle=%llu",
        static_cast<unsigned long long>(handle));
    return 0;
  }
  DIAG("jni.create exit handle=%lld rustHandle=%llu window=%p", static_cast<long long>(reinterpret_cast<jlong>(o)),
      static_cast<unsigned long long>(handle), static_cast<void *>(window));
  return reinterpret_cast<jlong>(o);
}

FN(jint, setFonts)(JNIEnv *env, jobject, jlong p, jbyteArray regular, jbyteArray bold) {
  jsize rl = env->GetArrayLength(regular), bl = env->GetArrayLength(bold);
  std::vector<uint8_t> r, b;
  try { r.resize(rl); b.resize(bl); } catch (...) { return -1; }
  env->GetByteArrayRegion(regular, 0, rl, reinterpret_cast<jbyte *>(r.data()));
  env->GetByteArrayRegion(bold, 0, bl, reinterpret_cast<jbyte *>(b.data()));
  const bool logFonts = takeDiag(owner(p)->diagFonts);
  if (logFonts) DIAG("jni.fonts kr_set_fonts.enter handle=%lld regularBytes=%d boldBytes=%d", static_cast<long long>(p), rl, bl);
  jint status = kr_set_fonts(owner(p)->handle, r.data(), r.size(), b.data(), b.size());
  if (logFonts) DIAG("jni.fonts kr_set_fonts.exit handle=%lld status=%d", static_cast<long long>(p), status);
  return status;
}

FN(jint, setTrack)(JNIEnv *env, jobject, jlong p, jbyteArray bytes) {
  jsize n = env->GetArrayLength(bytes);
  std::vector<uint8_t> v;
  try { v.resize(n); } catch (...) { return -1; }
  env->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte *>(v.data()));
  const bool logTrack = takeDiag(owner(p)->diagTracks);
  if (logTrack) DIAG("jni.track kr_set_track.enter handle=%lld bytes=%d", static_cast<long long>(p), n);
  jint status = kr_set_track(owner(p)->handle, v.data(), v.size());
  if (logTrack) DIAG("jni.track kr_set_track.exit handle=%lld status=%d", static_cast<long long>(p), status);
  return status;
}

FN(jint, setAnchor)(JNIEnv *, jobject, jlong p, jlong generation, jlong sequence, jdouble position,
                   jdouble sampled, jdouble now, jboolean playing, jdouble rate, jboolean snap) {
  return kr_set_anchor(owner(p)->handle, static_cast<uint64_t>(generation), static_cast<uint64_t>(sequence),
                       position, sampled, now, playing == JNI_TRUE, rate, snap == JNI_TRUE);
}

FN(jint, resize)(JNIEnv *, jobject, jlong p, jint width, jint height, jfloat scale) {
  return kr_resize(owner(p)->handle, static_cast<uint32_t>(width), static_cast<uint32_t>(height), scale);
}

FN(jint, setFollowing)(JNIEnv *, jobject, jlong p, jboolean following) {
  return kr_set_following(owner(p)->handle, following == JNI_TRUE);
}
FN(jint, scrollBy)(JNIEnv *, jobject, jlong p, jdouble dy) { return kr_scroll_by(owner(p)->handle, dy); }
FN(jint, fling)(JNIEnv *, jobject, jlong p, jdouble velocity, jdouble nativeMs) { return kr_fling(owner(p)->handle, velocity, nativeMs); }
FN(jint, hitTest)(JNIEnv *, jobject, jlong p, jdouble x, jdouble y) { return kr_hit_test(owner(p)->handle, x, y); }

FN(jint, render)(JNIEnv *, jobject, jlong p, jdouble target, jdouble sampled, jdouble resume) {
  Owner *o = owner(p);
  const bool logRender = takeDiag(o->diagRenders, 4);
  if (logRender) DIAG("jni.render kr_render.enter handle=%lld rustHandle=%llu",
      static_cast<long long>(p), static_cast<unsigned long long>(o->handle));
  jint status = kr_render(o->handle, target, sampled, resume);
  if (logRender) DIAG("jni.render kr_render.exit handle=%lld status=%d", static_cast<long long>(p), status);
  if (status < 0 && takeDiag(o->diagRenderFailures)) {
    DIAG("jni.render failed handle=%lld status=%d", static_cast<long long>(p), status);
  }
  return status;
}

// Fixed slot order, mirrored by RustBridge.METRIC_* in Kotlin.
FN(jdoubleArray, metrics)(JNIEnv *env, jobject, jlong p) {
  KRMetrics m{};
  if (kr_metrics(owner(p)->handle, &m) < 0) return nullptr;
  const double v[] = {
      (double)m.frames, (double)m.generation, m.position_ms, m.cpu_scene_ms, m.cpu_encode_ms,
      m.gpu_interval_ms, m.wait_ms, m.cpu_blit_ms, m.layout_ms, (double)m.width,
      (double)m.height, (double)m.capabilities, (double)m.animating, m.acquire_ms, m.blit_submit_ms,
      m.poll_ms, m.present_call_ms, (double)m.completed, (double)m.outstanding, (double)m.gpu_busy,
      m.target_native_ms, m.next_cue_native_ms, (double)m.visible_changes};
  jdoubleArray out = env->NewDoubleArray(sizeof(v) / sizeof(v[0]));
  if (!out) return nullptr;
  env->SetDoubleArrayRegion(out, 0, sizeof(v) / sizeof(v[0]), v);
  return out;
}

FN(jbyteArray, copyLayout)(JNIEnv *env, jobject, jlong p) {
  uint64_t h = owner(p)->handle;
  size_t capacity = kr_copy_layout_json(h, nullptr, 0);
  if (capacity == 0 || capacity > 8000000) return nullptr;
  std::vector<uint8_t> bytes;
  try { bytes.resize(capacity); } catch (...) { return nullptr; }
  size_t actual = kr_copy_layout_json(h, bytes.data(), bytes.size());
  if (actual != capacity) return nullptr;
  // Rust appends a NUL terminator, as on iOS.
  jbyteArray out = env->NewByteArray(static_cast<jsize>(capacity - 1));
  if (!out) return nullptr;
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(capacity - 1), reinterpret_cast<jbyte *>(bytes.data()));
  return out;
}

FN(jstring, lastError)(JNIEnv *env, jobject) {
  char buffer[2048] = {0};
  kr_copy_error(buffer, sizeof(buffer));
  return env->NewStringUTF(buffer);
}

// kr_destroy first, then the window pin is dropped.
FN(jint, destroy)(JNIEnv *, jobject, jlong p) {
  Owner *o = owner(p);
  DIAG("jni.destroy kr_destroy.enter handle=%lld rustHandle=%llu",
      static_cast<long long>(p), static_cast<unsigned long long>(o->handle));
  jint result = kr_destroy(o->handle);
  DIAG("jni.destroy kr_destroy.exit handle=%lld status=%d", static_cast<long long>(p), result);
  DIAG("jni.destroy window.release.enter handle=%lld window=%p",
      static_cast<long long>(p), static_cast<void *>(o->window));
  ANativeWindow_release(o->window);
  DIAG("jni.destroy window.release.exit handle=%lld", static_cast<long long>(p));
  delete o;
  return result;
}
