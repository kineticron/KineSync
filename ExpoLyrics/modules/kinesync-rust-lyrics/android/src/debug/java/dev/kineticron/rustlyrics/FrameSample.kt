package dev.kineticron.rustlyrics

internal class FrameSample {
  private companion object {
    const val M_FRAMES = 0; const val M_GENERATION = 1; const val M_POSITION = 2; const val M_CPU_SCENE = 3
    const val M_CPU_ENCODE = 4; const val M_GPU_INTERVAL = 5; const val M_WAIT = 6; const val M_CPU_BLIT = 7
    const val M_LAYOUT = 8; const val M_WIDTH = 9; const val M_HEIGHT = 10; const val M_CAPS = 11
    const val M_ANIMATING = 12; const val M_ACQUIRE = 13; const val M_BLIT_SUBMIT = 14; const val M_POLL = 15
    const val M_PRESENT_CALL = 16; const val M_COMPLETED = 17; const val M_OUTSTANDING = 18; const val M_GPU_BUSY = 19
    const val M_TARGET = 20; const val M_NEXT_CUE = 21; const val M_VISIBLE_CHANGES = 22
    const val METRIC_SLOT_COUNT = 23
  }

  private val m = DoubleArray(METRIC_SLOT_COUNT)
  private var lastMetrics = 0.0
  external fun copyLayout(owner: Long): ByteArray?
  private external fun lastError(): String
  fun failureMessage() = lastError()

  private external fun fillMetrics(owner: Long, out: DoubleArray): Boolean

  fun read(owner: Long) = fillMetrics(owner, m)
  val animating get() = m[M_ANIMATING] != 0.0
  val nextCue get() = m[M_NEXT_CUE]

  fun emit(sampled: Double, anchor: Anchor?, report: (Map<String, Any?>) -> Unit) {
    val now = RustBridge.nowMs() / 1000
    if (now - lastMetrics < 1) return
    lastMetrics = now
    val caps = m[M_CAPS].toLong()
    report(mapOf(
      "state" to "metrics", "frames" to m[M_FRAMES], "sampleNativeMs" to sampled,
      "targetNativeMs" to m[M_TARGET], "playing" to (anchor?.playing ?: false), "rate" to (anchor?.rate ?: 1.0),
      "positionMs" to m[M_POSITION], "cpuSceneMs" to m[M_CPU_SCENE],
      "visibleChanges" to (m[M_VISIBLE_CHANGES] != 0.0), "nextCueNativeMs" to nextCue,
      "cpuEncodeMs" to m[M_CPU_ENCODE], "gpuIntervalMs" to m[M_GPU_INTERVAL],
      "waitMs" to m[M_WAIT], "cpuBlitMs" to m[M_CPU_BLIT],
      "acquireMs" to m[M_ACQUIRE], "blitSubmitMs" to m[M_BLIT_SUBMIT],
      "pollMs" to m[M_POLL], "presentCallMs" to m[M_PRESENT_CALL],
      "gpuCompleted" to m[M_COMPLETED], "gpuOutstanding" to m[M_OUTSTANDING],
      "gpuBusy" to m[M_GPU_BUSY],
      "gpuRendering" to ((caps and 1L) != 0L), "computeBlur" to ((caps and 2L) != 0L),
      "adapterTimestampQuery" to ((caps and 4L) != 0L), "adapterEncoderTimestamp" to ((caps and 8L) != 0L),
      "enabledBracketFeatures" to ((caps and 16L) != 0L),
      "profilerReason" to (if ((caps and 4L) == 0L) "adapter has no timestamp queries"
        else if ((caps and 8L) == 0L) "adapter has no encoder timestamp feature (required by whole-Vello bracket)"
        else "live timestamp readback disabled to avoid an extra worker/GPU wait"),
      "layoutMs" to m[M_LAYOUT], "width" to m[M_WIDTH], "height" to m[M_HEIGHT],
      "note" to "CPU wall costs only. Present-call rate is not scanout.",
    ))
  }
}
