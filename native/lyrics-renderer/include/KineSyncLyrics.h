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
  double wait_ms, present_cpu_ms, layout_ms;
  uint32_t width, height;
} KRMetrics;
uint32_t kr_abi_version(void);
uint64_t kr_create(void *retained_ca_metal_layer, uint32_t width, uint32_t height, float scale);
int32_t kr_set_track(uint64_t handle, const uint8_t *bytes, size_t length);
int32_t kr_set_anchor(uint64_t handle, uint64_t generation, uint64_t sequence, double position_ms,
                      double sampled_native_ms, double now_native_ms, bool playing, double rate);
int32_t kr_resize(uint64_t handle, uint32_t width, uint32_t height, float scale);
int32_t kr_render(uint64_t handle, double native_ms);
int32_t kr_metrics(uint64_t handle, KRMetrics *out);
int32_t kr_destroy(uint64_t handle);
void kr_copy_error(char *out, size_t capacity);
#ifdef __cplusplus
}
#endif
#endif
