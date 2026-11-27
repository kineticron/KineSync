package dev.kineticron.rustlyrics

/** Thin JNI surface over the Rust C ABI. All calls except abiVersion belong to the worker thread. */
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
  external fun fling(owner: Long, velocityLogicalPerMs: Double, nativeMs: Double): Int
  external fun hitTest(owner: Long, xLogical: Double, yLogical: Double): Int
  external fun render(owner: Long, targetMs: Double, sampledMs: Double, resumeStepMs: Double): Int
  external fun destroy(owner: Long): Int

  /** Monotonic clock shared with Choreographer (CLOCK_MONOTONIC). */
  fun nowMs(): Double = System.nanoTime() / 1_000_000.0
}
