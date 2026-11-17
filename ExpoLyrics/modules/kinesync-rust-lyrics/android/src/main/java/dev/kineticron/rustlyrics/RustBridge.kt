package dev.kineticron.rustlyrics

/** Thin JNI surface over the Rust C ABI. All calls except abiVersion/lastError belong to the worker thread. */
internal object RustBridge {
  init { System.loadLibrary("kinesync_rust_lyrics") }
  external fun abiVersion(): Int
  external fun create(surface: android.view.Surface, width: Int, height: Int, scale: Float): Long
  external fun setFonts(owner: Long, regular: ByteArray, bold: ByteArray): Int
  external fun setTrack(owner: Long, bytes: ByteArray): Int
  external fun setAnchor(owner: Long, generation: Long, sequence: Long, positionMs: Double, sampledNativeMs: Double,
                         nowNativeMs: Double, playing: Boolean, rate: Double, snap: Boolean): Int
  external fun resize(owner: Long, width: Int, height: Int, scale: Float): Int
  external fun setFollowing(owner: Long, following: Boolean): Int
  external fun scrollBy(owner: Long, dyLogical: Double): Int
  external fun fling(owner: Long, velocityLogicalPerMs: Double): Int
  external fun hitTest(owner: Long, xLogical: Double, yLogical: Double): Int
  external fun render(owner: Long, targetMs: Double, sampledMs: Double, resumeStepMs: Double): Int
  external fun metrics(owner: Long): DoubleArray?
  external fun copyLayout(owner: Long): ByteArray?
  external fun lastError(): String
  external fun destroy(owner: Long): Int

  const val M_FRAMES = 0; const val M_GENERATION = 1; const val M_POSITION = 2; const val M_CPU_SCENE = 3
  const val M_CPU_ENCODE = 4; const val M_GPU_INTERVAL = 5; const val M_WAIT = 6; const val M_CPU_BLIT = 7
  const val M_LAYOUT = 8; const val M_WIDTH = 9; const val M_HEIGHT = 10; const val M_CAPS = 11
  const val M_ANIMATING = 12; const val M_ACQUIRE = 13; const val M_BLIT_SUBMIT = 14; const val M_POLL = 15
  const val M_PRESENT_CALL = 16; const val M_COMPLETED = 17; const val M_OUTSTANDING = 18; const val M_GPU_BUSY = 19
  const val M_TARGET = 20; const val M_NEXT_CUE = 21; const val M_VISIBLE_CHANGES = 22

  /** Monotonic clock shared with Choreographer (CLOCK_MONOTONIC). */
  fun nowMs(): Double = System.nanoTime() / 1_000_000.0
}
