#ifndef KINESYNC_LYRICS_H
#define KINESYNC_LYRICS_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
  uint64_t frames, generation;
  double position_ms, cpu_scene_ms, cpu_encode_ms, gpu_interval_ms;
  double wait_ms, cpu_blit_ms, layout_ms;
  uint32_t width, height;
  /* GPU Vello=1, compute blur=2, adapter timestamps=4, encoder timestamps=8,
     enabled bracket features=16. Live profiler readback is disabled. */
  uint32_t capabilities, animating;
  double acquire_ms, blit_submit_ms, poll_ms, present_call_ms;
  uint64_t completed, outstanding, gpu_busy;
  double target_native_ms;
  /* ABI9: absolute monotonic wakeup in ms, -1 when none.
     animating requests continuous frames, including retained animation history. */
  double next_cue_native_ms;
  uint32_t visible_changes;
} KRMetrics;
uint32_t kr_abi_version(void);
/* ABI 10 adds footer hit targets and static empty packets. ABI9 added idle-frame scheduling metrics and a resume display step.
   Schema6 includes background voices. The ABI is the client compatibility gate. */
/* Native owner retains CAMetalLayer (iOS) or acquired ANativeWindow (Android)
   until kr_destroy completes. Same ABI10 contract on both platforms. */
uint64_t kr_create(void *retained_native_surface, uint32_t width, uint32_t height, float scale);
/* ABI8: font bytes copied once before the first track; immutable owner font set. */
int32_t kr_set_fonts(uint64_t handle, const uint8_t *regular, size_t regular_length, const uint8_t *bold, size_t bold_length);
size_t kr_copy_layout_json(uint64_t handle, uint8_t *out, size_t capacity);
int32_t kr_set_track(uint64_t handle, const uint8_t *bytes, size_t length);
int32_t kr_set_anchor(uint64_t handle, uint64_t generation, uint64_t sequence, double position_ms,
                      double sampled_native_ms, double now_native_ms, bool playing, double rate, bool snap);
int32_t kr_resize(uint64_t handle, uint32_t width, uint32_t height, float scale);
/* ABI 7: Skia-parity follow ownership, manual drag and row hit-testing. */
int32_t kr_set_following(uint64_t handle, bool following);
int32_t kr_scroll_by(uint64_t handle, double dy_logical_points);
/* Finger-lift velocity in logical points per millisecond (iOS inertia). */
int32_t kr_fling(uint64_t handle, double velocity_logical_points_per_ms);
/* ABI10: x/y logical points. >=0 row, -1 miss, -2 footer seek, -3 maker, -4 uploader. */
int32_t kr_hit_test(uint64_t handle, double x_logical_points, double y_logical_points);
/* ABI 7: 0 present called (not scanout), 1 input, 2 no drawable, 3 GPU full, -1 error. */
/* ABI9: resume_step_ms is one display interval on waking, zero otherwise. */
int32_t kr_render(uint64_t handle, double target_native_ms, double sampled_native_ms, double resume_step_ms);
int32_t kr_metrics(uint64_t handle, KRMetrics *out);
int32_t kr_destroy(uint64_t handle);
void kr_copy_error(char *out, size_t capacity);
#ifdef __cplusplus
}
#endif
#endif
