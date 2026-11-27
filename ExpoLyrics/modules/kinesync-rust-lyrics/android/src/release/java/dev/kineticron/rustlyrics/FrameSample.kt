package dev.kineticron.rustlyrics

internal class FrameSample {
  private val state = DoubleArray(2)
  private external fun fillFrameState(owner: Long, out: DoubleArray): Boolean

  fun read(owner: Long) = fillFrameState(owner, state)
  val animating get() = state[0] != 0.0
  val nextCue get() = state[1]

  fun failureMessage() = "Lyrics renderer unavailable."

  @Suppress("UNUSED_PARAMETER")
  fun emit(sampled: Double, anchor: Anchor?, report: (Map<String, Any?>) -> Unit) {}
}
