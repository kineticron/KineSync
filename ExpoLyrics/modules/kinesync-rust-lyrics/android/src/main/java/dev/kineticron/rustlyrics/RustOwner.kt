package dev.kineticron.rustlyrics

import android.content.Context
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.view.Surface

internal data class Anchor(
  val generation: Long, val sequence: Long, val positionMs: Double,
  val nativeMs: Double, val playing: Boolean, val rate: Double, val snap: Boolean,
)

internal data class FrameResult(val status: Int, val generation: Long, val animating: Boolean, val nextCueMs: Double)

/**
 * Every Rust call runs on one shared worker thread, never on UI. Retirement is
 * queued behind pending work and releases the Surface only after kr_destroy.
 */
internal class RustOwner(
  private val context: Context,
  private val texture: SurfaceTexture,
  private val report: (Map<String, Any?>) -> Unit,
) {
  companion object {
    // Shared so an old owner retires before a rapid remount creates a new surface.
    private val thread = HandlerThread("kinesync-rust-lyrics", Process.THREAD_PRIORITY_DISPLAY).also { it.start() }
    private val worker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var fonts: Pair<ByteArray, ByteArray>? = null
    private fun loadFonts(context: Context): Pair<ByteArray, ByteArray>? {
      fonts?.let { return it }
      return try {
        val a = context.applicationContext.assets
        val r = a.open("SF-Pro-Display-Regular.otf").use { it.readBytes() }
        val b = a.open("SF-Pro-Display-Bold.otf").use { it.readBytes() }
        Pair(r, b).also { fonts = it }
      } catch (_: Exception) { null }
    }
  }

  private val gate = Any()
  private var retired = false
  private var visible = false
  // Worker only below.
  private var surface: Surface? = null
  private var handle = 0L
  private var failed = false
  @Volatile private var currentGeneration = 0L
  private var appliedTrack = ""
  private var anchor: Anchor? = null
  private var width = 0
  private var height = 0
  private var scale = 0f
  private var lastMetrics = 0.0
  // Gate-guarded latest-wins input.
  private var pendingUpdate: SurfaceInput? = null
  private var pendingAnchor: Anchor? = null
  private var pendingSnap = false
  private var inputScheduled = false

  private class SurfaceInput(val track: String, val generation: Long, val anchor: Anchor?, val width: Int, val height: Int, val scale: Float)

  private fun permitted(rendering: Boolean = false) = synchronized(gate) { !retired && (!rendering || visible) }
  private fun emit(event: Map<String, Any?>) {
    val tagged = HashMap(event); tagged["generation"] = currentGeneration
    main.post { report(tagged) }
  }
  private fun failure() {
    failed = true
    emit(mapOf("state" to "error", "message" to RustBridge.lastError()))
  }
  private fun applyAnchor(forceSnap: Boolean = false) {
    val a = anchor ?: return
    if (handle == 0L) return
    if (RustBridge.setAnchor(handle, a.generation, a.sequence, a.positionMs, a.nativeMs, RustBridge.nowMs(),
        a.playing, a.rate, a.snap || forceSnap) < 0) failure()
  }

  fun update(track: String, generation: Long, anchor: Anchor?, width: Int, height: Int, scale: Float) =
    enqueue(SurfaceInput(track, generation, anchor, width, height, scale), null)
  fun setAnchor(value: Anchor) = enqueue(null, value)

  // Gestures bypass the coalescer so deltas stay in touch order.
  private fun post(block: () -> Unit) = worker.post { if (permitted() && handle != 0L && !failed) block() }
  fun setFollowing(v: Boolean) = post { if (RustBridge.setFollowing(handle, v) < 0) failure() }
  fun scrollBy(dy: Double) { if (dy.isFinite()) post { if (RustBridge.scrollBy(handle, dy) < 0) failure() } }
  fun fling(v: Double, nativeMs: Double, done: (Boolean) -> Unit) { if (v.isFinite() && nativeMs.isFinite() && nativeMs >= 0.0) post {
    val result = RustBridge.fling(handle, v, nativeMs)
    if (result < 0) failure()
    else { val resumed = result == 1; main.post { done(resumed) } }
  } }
  fun hitTest(x: Double, y: Double, done: (Int) -> Unit) = worker.post {
    val idx = if (permitted() && handle != 0L && !failed) RustBridge.hitTest(handle, x, y) else -1
    main.post { done(idx) }
  }
  fun copyLayout(done: (String?) -> Unit) = worker.post {
    val bytes = if (permitted() && handle != 0L) RustBridge.copyLayout(handle) else null
    val s = bytes?.toString(Charsets.UTF_8)
    main.post { done(if (s.isNullOrEmpty()) null else s) }
  }

  private fun enqueue(update: SurfaceInput?, a: Anchor?) {
    val schedule: Boolean
    synchronized(gate) {
      if (retired) return
      if (update != null) pendingUpdate = update
      if (a != null) { pendingAnchor = a; pendingSnap = pendingSnap || a.snap }
      schedule = !inputScheduled
      inputScheduled = true
    }
    if (schedule) worker.post { drainInput() }
  }

  private fun drainInput() {
    val update: SurfaceInput?; val a: Anchor?; val forceSnap: Boolean
    synchronized(gate) {
      update = pendingUpdate; a = pendingAnchor; forceSnap = pendingSnap
      pendingSnap = false; pendingUpdate = null; pendingAnchor = null; inputScheduled = false
    }
    if (!permitted()) return
    if (update != null) applyUpdate(update, forceSnap)
    if (a != null && !failed && a.generation == currentGeneration && a.sequence > (anchor?.sequence ?: 0)) {
      anchor = a
      applyAnchor(forceSnap)
    }
  }

  private fun applyUpdate(u: SurfaceInput, forceSnap: Boolean) {
    if (!permitted()) return
    if (failed) {
      if (u.generation <= currentGeneration) return
      if (handle != 0L) { RustBridge.destroy(handle); handle = 0 }
      surface?.release(); surface = null
      failed = false; appliedTrack = ""
    }
    if (u.generation != currentGeneration) { currentGeneration = u.generation; anchor = null }
    val ua = u.anchor
    if (ua != null && ua.generation == currentGeneration && ua.sequence >= (anchor?.sequence ?: 0)) anchor = ua
    if (u.width <= 0 || u.height <= 0) return
    val w = minOf(8192, u.width); val h = minOf(8192, u.height)
    if (handle == 0L) {
      if (RustBridge.abiVersion() != 11) { failed = true; emit(mapOf("state" to "error", "message" to "Rust ABI mismatch")); return }
      val s = Surface(texture)
      surface = s
      handle = RustBridge.create(s, w, h, u.scale)
      if (handle == 0L) { s.release(); surface = null; failure(); return }
      val f = loadFonts(context)
      if (f == null) {
        failed = true
        emit(mapOf("state" to "error", "message" to "Bundled Rust lyric fonts unavailable; rebuild with the android fonts asset directory"))
        return
      }
      if (RustBridge.setFonts(handle, f.first, f.second) < 0) { failure(); return }
    } else if (width != u.width || height != u.height || scale != u.scale) {
      if (RustBridge.resize(handle, w, h, u.scale) < 0) { failure(); return }
    }
    width = u.width; height = u.height; scale = u.scale
    if (u.track.isNotEmpty() && u.track != appliedTrack) {
      if (RustBridge.setTrack(handle, u.track.toByteArray(Charsets.UTF_8)) < 0) { failure(); return }
      appliedTrack = u.track
      emit(mapOf("state" to "ready", "message" to "Rust Vulkan surface and live track ready"))
    }
    applyAnchor(forceSnap)
  }

  fun setVisible(v: Boolean) = synchronized(gate) { visible = v }

  fun draw(targetMs: Double, resumeStepMs: Double, done: (FrameResult) -> Unit) = worker.post {
    var result = 1; var animating = false; var nextCue = -1.0
    try {
      if (!permitted(true) || failed || handle == 0L) return@post
      val sampled = RustBridge.nowMs()
      result = RustBridge.render(handle, maxOf(targetMs, sampled), sampled, resumeStepMs)
      if (result < 0) { failure(); return@post }
      val m = RustBridge.metrics(handle)
      if (m == null) { failure(); return@post }
      animating = m[RustBridge.M_ANIMATING] != 0.0
      nextCue = m[RustBridge.M_NEXT_CUE]
      val now = RustBridge.nowMs() / 1000
      if (result == 0 && now - lastMetrics >= 1) {
        lastMetrics = now
        val caps = m[RustBridge.M_CAPS].toLong()
        emit(mapOf(
          "state" to "metrics", "frames" to m[RustBridge.M_FRAMES], "sampleNativeMs" to sampled,
          "targetNativeMs" to m[RustBridge.M_TARGET], "playing" to (anchor?.playing ?: false), "rate" to (anchor?.rate ?: 1.0),
          "positionMs" to m[RustBridge.M_POSITION], "cpuSceneMs" to m[RustBridge.M_CPU_SCENE],
          "visibleChanges" to (m[RustBridge.M_VISIBLE_CHANGES] != 0.0), "nextCueNativeMs" to nextCue,
          "cpuEncodeMs" to m[RustBridge.M_CPU_ENCODE], "gpuIntervalMs" to m[RustBridge.M_GPU_INTERVAL],
          "waitMs" to m[RustBridge.M_WAIT], "cpuBlitMs" to m[RustBridge.M_CPU_BLIT],
          "acquireMs" to m[RustBridge.M_ACQUIRE], "blitSubmitMs" to m[RustBridge.M_BLIT_SUBMIT],
          "pollMs" to m[RustBridge.M_POLL], "presentCallMs" to m[RustBridge.M_PRESENT_CALL],
          "gpuCompleted" to m[RustBridge.M_COMPLETED], "gpuOutstanding" to m[RustBridge.M_OUTSTANDING],
          "gpuBusy" to m[RustBridge.M_GPU_BUSY],
          "gpuRendering" to ((caps and 1L) != 0L), "computeBlur" to ((caps and 2L) != 0L),
          "adapterTimestampQuery" to ((caps and 4L) != 0L), "adapterEncoderTimestamp" to ((caps and 8L) != 0L),
          "enabledBracketFeatures" to ((caps and 16L) != 0L),
          "profilerReason" to (if ((caps and 4L) == 0L) "adapter has no timestamp queries"
            else if ((caps and 8L) == 0L) "adapter has no encoder timestamp feature (required by whole-Vello bracket)"
            else "live timestamp readback disabled to avoid an extra worker/GPU wait"),
          "layoutMs" to m[RustBridge.M_LAYOUT], "width" to m[RustBridge.M_WIDTH], "height" to m[RustBridge.M_HEIGHT],
          "note" to "CPU wall costs only. Present-call rate is not scanout.",
        ))
      }
    } finally {
      val r = FrameResult(result, currentGeneration, animating, nextCue)
      main.post { done(r) }
    }
  }

  /** Never waits on UI. Queued behind pending work, then destroys and releases the texture. */
  fun dispose() {
    val should = synchronized(gate) {
      val s = !retired
      retired = true; visible = false
      pendingUpdate = null; pendingAnchor = null; pendingSnap = false
      s
    }
    if (!should) return
    worker.post {
      if (handle != 0L) { RustBridge.destroy(handle); handle = 0 }
      surface?.release(); surface = null
      texture.release()
    }
  }
}
