// JNI shim over the shared Rust C ABI. The Rust side owns the Vulkan surface;
// here we only pin the ANativeWindow until kr_destroy has returned.
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <jni.h>
#include <cstdint>
#include <cstdlib>
#include <new>
#include <vector>
#include "KineSyncLyrics.h"

namespace {
struct Owner {
  uint64_t handle;
  ANativeWindow *window;
};
inline Owner *owner(jlong p) { return reinterpret_cast<Owner *>(p); }
}  // namespace

#define FN(type, name) extern "C" JNIEXPORT type JNICALL Java_dev_kineticron_rustlyrics_RustBridge_##name

FN(jint, abiVersion)(JNIEnv *, jobject) { return static_cast<jint>(kr_abi_version()); }

// Creation boundary: the Surface comes from a non-opaque TextureView, whose consumer
// (HWUI) imports the buffer as premultiplied RGBA (kPremul, see
// https://android.googlesource.com/platform/frameworks/base/+/master/libs/hwui/AutoBackendTextureRelease.cpp).
// The Rust side must therefore pick a premultiplied/INHERIT composite alpha mode under Android WSI.
// Returns an opaque owner pointer, 0 on failure. The window is acquired here
// and released only by destroy, after kr_destroy.
FN(jlong, create)(JNIEnv *env, jobject, jobject surface, jint width, jint height, jfloat scale) {
  ANativeWindow *window = ANativeWindow_fromSurface(env, surface);
  if (!window) return 0;
  uint64_t handle = kr_create(window, static_cast<uint32_t>(width), static_cast<uint32_t>(height), scale);
  if (handle == 0) {
    ANativeWindow_release(window);
    return 0;
  }
  Owner *o = new (std::nothrow) Owner{handle, window};
  if (!o) {
    kr_destroy(handle);
    ANativeWindow_release(window);
    return 0;
  }
  return reinterpret_cast<jlong>(o);
}

FN(jint, setFonts)(JNIEnv *env, jobject, jlong p, jbyteArray regular, jbyteArray bold) {
  jsize rl = env->GetArrayLength(regular), bl = env->GetArrayLength(bold);
  std::vector<uint8_t> r, b;
  try { r.resize(rl); b.resize(bl); } catch (...) { return -1; }
  env->GetByteArrayRegion(regular, 0, rl, reinterpret_cast<jbyte *>(r.data()));
  env->GetByteArrayRegion(bold, 0, bl, reinterpret_cast<jbyte *>(b.data()));
  return kr_set_fonts(owner(p)->handle, r.data(), r.size(), b.data(), b.size());
}

FN(jint, setTrack)(JNIEnv *env, jobject, jlong p, jbyteArray bytes) {
  jsize n = env->GetArrayLength(bytes);
  std::vector<uint8_t> v;
  try { v.resize(n); } catch (...) { return -1; }
  env->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte *>(v.data()));
  return kr_set_track(owner(p)->handle, v.data(), v.size());
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
  return kr_render(owner(p)->handle, target, sampled, resume);
}

#define FRAME_FN(name) extern "C" JNIEXPORT jboolean JNICALL Java_dev_kineticron_rustlyrics_FrameSample_##name

#if KINESYNC_ANDROID_FRAME_DIAGNOSTICS
// Fixed slot order, mirrored by the Debug FrameSample.
FRAME_FN(fillMetrics)(JNIEnv *env, jobject, jlong p, jdoubleArray out) {
  constexpr jsize slotCount = 23;
  if (!p || !out || env->GetArrayLength(out) < slotCount) return JNI_FALSE;
  KRMetrics m{};
  if (kr_metrics(owner(p)->handle, &m) < 0) return JNI_FALSE;
  const double v[] = {
      (double)m.frames, (double)m.generation, m.position_ms, m.cpu_scene_ms, m.cpu_encode_ms,
      m.gpu_interval_ms, m.wait_ms, m.cpu_blit_ms, m.layout_ms, (double)m.width,
      (double)m.height, (double)m.capabilities, (double)m.animating, m.acquire_ms, m.blit_submit_ms,
      m.poll_ms, m.present_call_ms, (double)m.completed, (double)m.outstanding, (double)m.gpu_busy,
      m.target_native_ms, m.next_cue_native_ms, (double)m.visible_changes};
  static_assert(sizeof(v) / sizeof(v[0]) == slotCount, "metrics slot count mismatch");
  env->SetDoubleArrayRegion(out, 0, slotCount, v);
  return JNI_TRUE;
}

#define FRAME_DEBUG_FN(type, name) extern "C" JNIEXPORT type JNICALL Java_dev_kineticron_rustlyrics_FrameSample_##name

FRAME_DEBUG_FN(jbyteArray, copyLayout)(JNIEnv *env, jobject, jlong p) {
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

FRAME_DEBUG_FN(jstring, lastError)(JNIEnv *env, jobject) {
  char buffer[2048] = {0};
  kr_copy_error(buffer, sizeof(buffer));
  return env->NewStringUTF(buffer);
}

#else
FRAME_FN(fillFrameState)(JNIEnv *env, jobject, jlong p, jdoubleArray out) {
  constexpr jsize slotCount = 2;
  if (!p || !out || env->GetArrayLength(out) < slotCount) return JNI_FALSE;
  KRMetrics m{};
  if (kr_metrics(owner(p)->handle, &m) < 0) return JNI_FALSE;
  const double v[] = {(double)m.animating, m.next_cue_native_ms};
  env->SetDoubleArrayRegion(out, 0, slotCount, v);
  return JNI_TRUE;
}
#endif

// kr_destroy first, then the window pin is dropped.
FN(jint, destroy)(JNIEnv *, jobject, jlong p) {
  Owner *o = owner(p);
  jint result = kr_destroy(o->handle);
  ANativeWindow_release(o->window);
  delete o;
  return result;
}
