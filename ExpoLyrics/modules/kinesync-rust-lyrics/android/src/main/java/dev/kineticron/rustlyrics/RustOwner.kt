package dev.kineticron.rustlyrics

import android.content.Context
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.util.Log
import android.view.Surface
import java.util.concurrent.atomic.AtomicIntegerArray

internal fun logRustDiag(message: String) {
  Log.i("KSRustDiag", "monoNs=${System.nanoTime()} tid=${Process.myTid()} thread=${Thread.currentThread().name} $message")
}

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

  private enum class Diag {
    INIT, ENQUEUE, COALESCE, DRAIN, DIMENSIONS, ZERO_SIZE, ABI, CREATE,
    FONTS, TRACK, VISIBILITY, VISIBILITY_DENIED, DRAW_ENQUEUE, DRAW_START, DRAW_DENIED, RENDER, RENDER_FAILURE,
    FAILURE, DISPOSE, DESTROY
  }
  private val diagCounts = AtomicIntegerArray(Diag.entries.size)

  init {
    diag(Diag.INIT) { "owner.init workerTid=${thread.threadId} workerThread=${thread.name}" }
  }

  private fun takeDiag(event: Diag, limit: Int = 6): Boolean {
    val index = event.ordinal
    return diagCounts.get(index) < limit && diagCounts.getAndIncrement(index) < limit
  }

  private fun logDiag(details: String) {
    logRustDiag("owner=${System.identityHashCode(this)} texture=${System.identityHashCode(texture)} $details")
  }

  private inline fun diag(event: Diag, limit: Int = 6, details: () -> String) {
    if (takeDiag(event, limit)) logDiag(details())
  }

  private class SurfaceInput(val track: String, val generation: Long, val anchor: Anchor?, val width: Int, val height: Int, val scale: Float)

  private fun permitted(rendering: Boolean = false): Boolean {
    val denial: String?
    val allowed = synchronized(gate) {
      denial = if (rendering && retired) "retired" else if (rendering && !visible) "hidden" else null
      !retired && (!rendering || visible)
    }
    if (denial != null) diag(Diag.VISIBILITY_DENIED) { "owner.visibility denied=$denial" }
    return allowed
  }
  private fun emit(event: Map<String, Any?>) {
    val tagged = HashMap(event); tagged["generation"] = currentGeneration
    main.post { report(tagged) }
  }
  private fun failure() {
    failed = true
    diag(Diag.FAILURE) { "owner.failure handle=$handle generation=$currentGeneration" }
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
    diag(if (schedule) Diag.ENQUEUE else Diag.COALESCE) {
      "owner.input enqueue scheduled=$schedule surfaceUpdate=${update != null} updateGeneration=${update?.generation}"
    }
    if (schedule) worker.post { drainInput() }
  }

  private fun drainInput() {
    val logDrain = takeDiag(Diag.DRAIN)
    if (logDrain) logDiag("owner.input worker.start handle=$handle")
    val update: SurfaceInput?; val a: Anchor?; val forceSnap: Boolean
    synchronized(gate) {
      update = pendingUpdate; a = pendingAnchor; forceSnap = pendingSnap
      pendingSnap = false; pendingUpdate = null; pendingAnchor = null; inputScheduled = false
    }
    if (!permitted()) {
      if (logDrain) logDiag("owner.input worker.denied reason=retired")
      return
    }
    if (logDrain) logDiag("owner.input drain surfaceUpdate=${update != null} updateGeneration=${update?.generation}")
    if (update != null) applyUpdate(update, forceSnap)
    if (a != null && !failed && a.generation == currentGeneration && a.sequence > (anchor?.sequence ?: 0)) {
      anchor = a
      applyAnchor(forceSnap)
    }
    if (logDrain) logDiag("owner.input worker.end handle=$handle failed=$failed generation=$currentGeneration")
  }

  private fun applyUpdate(u: SurfaceInput, forceSnap: Boolean) {
    if (!permitted()) return
    if (failed) {
      if (u.generation <= currentGeneration) return
      if (handle != 0L) {
        val logDestroy = takeDiag(Diag.DESTROY)
        if (logDestroy) logDiag("owner.destroy enter reason=recovery handle=$handle")
        val status = RustBridge.destroy(handle)
        if (logDestroy) logDiag("owner.destroy exit reason=recovery handle=$handle status=$status")
        handle = 0
      }
      surface?.release(); surface = null
      failed = false; appliedTrack = ""
    }
    if (u.generation != currentGeneration) { currentGeneration = u.generation; anchor = null }
    val ua = u.anchor
    if (ua != null && ua.generation == currentGeneration && ua.sequence >= (anchor?.sequence ?: 0)) anchor = ua
    if (u.width <= 0 || u.height <= 0) {
      diag(Diag.ZERO_SIZE) { "owner.applyUpdate denied=dimensions size=${u.width}x${u.height} handle=$handle generation=$currentGeneration" }
      return
    }
    val w = minOf(8192, u.width); val h = minOf(8192, u.height)
    diag(Diag.DIMENSIONS) { "owner.applyUpdate size=${u.width}x${u.height} clamped=${w}x$h handle=$handle generation=$currentGeneration" }
    if (handle == 0L) {
      val logAbi = takeDiag(Diag.ABI)
      if (logAbi) logDiag("owner.abi enter")
      if (RustBridge.abiVersion() != 11) {
        if (logAbi) logDiag("owner.abi exit mismatch expected=11")
        failed = true; emit(mapOf("state" to "error", "message" to "Rust ABI mismatch")); return
      }
      if (logAbi) logDiag("owner.abi exit=11")
      val s = Surface(texture)
      surface = s
      val logCreate = takeDiag(Diag.CREATE)
      if (logCreate) logDiag("owner.create enter surface=${System.identityHashCode(s)} size=${w}x$h scale=${u.scale}")
      handle = RustBridge.create(s, w, h, u.scale)
      if (logCreate) logDiag("owner.create exit surface=${System.identityHashCode(s)} handle=$handle")
      if (handle == 0L) { s.release(); surface = null; failure(); return }
      val logFonts = takeDiag(Diag.FONTS)
      if (logFonts) logDiag("owner.fonts load.enter handle=$handle")
      val f = loadFonts(context)
      if (logFonts) logDiag("owner.fonts load.exit handle=$handle available=${f != null}")
      if (f == null) {
        failed = true
        emit(mapOf("state" to "error", "message" to "Bundled Rust lyric fonts unavailable; rebuild with the android fonts asset directory"))
        return
      }
      if (logFonts) logDiag("owner.fonts set.enter handle=$handle regularBytes=${f.first.size} boldBytes=${f.second.size}")
      val status = RustBridge.setFonts(handle, f.first, f.second)
      if (logFonts) logDiag("owner.fonts set.exit handle=$handle status=$status")
      if (status < 0) { failure(); return }
    } else if (width != u.width || height != u.height || scale != u.scale) {
      if (RustBridge.resize(handle, w, h, u.scale) < 0) { failure(); return }
    }
    width = u.width; height = u.height; scale = u.scale
    if (u.track.isNotEmpty() && u.track != appliedTrack) {
      val logTrack = takeDiag(Diag.TRACK)
      if (logTrack) logDiag("owner.track set.enter handle=$handle generation=$currentGeneration trackChars=${u.track.length}")
      val status = RustBridge.setTrack(handle, u.track.toByteArray(Charsets.UTF_8))
      if (logTrack) logDiag("owner.track set.exit handle=$handle generation=$currentGeneration status=$status")
      if (status < 0) { failure(); return }
      appliedTrack = u.track
      emit(mapOf("state" to "ready", "message" to "Rust Vulkan surface and live track ready"))
    }
    applyAnchor(forceSnap)
  }

  fun setVisible(v: Boolean) {
    val changed = synchronized(gate) {
      val changed = visible != v
      visible = v
      changed
    }
    if (changed) diag(Diag.VISIBILITY, 16) { "owner.visibility visible=$v" }
  }

  fun draw(targetMs: Double, resumeStepMs: Double, done: (FrameResult) -> Unit): Boolean {
    diag(Diag.DRAW_ENQUEUE) { "owner.draw enqueue" }
    return worker.post {
      diag(Diag.DRAW_START) { "owner.draw worker.start handle=$handle generation=$currentGeneration" }
      var result = 1; var animating = false; var nextCue = -1.0
      try {
        if (!permitted(true) || failed || handle == 0L) {
          diag(Diag.DRAW_DENIED) { "owner.draw denied failed=$failed handle=$handle generation=$currentGeneration" }
          return@post
        }
        val logRender = takeDiag(Diag.RENDER, 4)
        val sampled = RustBridge.nowMs()
        if (logRender) logDiag("owner.render enter handle=$handle generation=$currentGeneration")
        result = RustBridge.render(handle, maxOf(targetMs, sampled), sampled, resumeStepMs)
        if (logRender) logDiag("owner.render exit handle=$handle generation=$currentGeneration status=$result")
        if (result < 0) {
          diag(Diag.RENDER_FAILURE) { "owner.render failed handle=$handle generation=$currentGeneration status=$result" }
          failure(); return@post
        }
        val m = RustBridge.metrics(handle)
        if (m == null) {
          diag(Diag.RENDER_FAILURE) { "owner.metrics unavailable handle=$handle generation=$currentGeneration" }
          failure(); return@post
        }
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
    val logDispose = takeDiag(Diag.DISPOSE, 1)
    if (logDispose) logDiag("owner.dispose enqueue")
    worker.post {
      if (logDispose) logDiag("owner.dispose worker.start handle=$handle")
      if (handle != 0L) {
        if (logDispose) logDiag("owner.destroy enter reason=dispose handle=$handle")
        val status = RustBridge.destroy(handle)
        if (logDispose) logDiag("owner.destroy exit reason=dispose handle=$handle status=$status")
        handle = 0
      }
      surface?.release(); surface = null
      texture.release()
      if (logDispose) logDiag("owner.dispose worker.end")
    }
  }
}
