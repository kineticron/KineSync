package dev.kineticron.rustlyrics

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.MotionEvent
import android.view.TextureView
import android.view.VelocityTracker
import android.view.ViewConfiguration
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.ceil

private const val PIXEL_BURST_PRESENTS = 4

private enum class PixelBurstFailure(val code: Int) {
  Detached(20), WindowHidden(21), ViewResized(22), SurfaceReplaced(23), SurfaceResized(24),
  SurfaceDestroyed(25), BitmapCopy(26), SurfaceMissing(27), FixtureWait(28), WorkerWait(29),
  ConsumerWait(30), HoldExpired(31), FixtureChanged(32), HeldTimestampChanged(33), InvalidGeometry(34),
  WorkerStatus(35), ProducerReceipt(36), WorkerError(37), TrackGenerationChanged(38), AnchorChanged(39),
  Inactive(40), UnexpectedBufferBetweenDraws(41), ClaimWait(42), DrawWait(43), DrawableRetries(44),
  FixtureStyle(45),
}

private class PixelBurst(val dir: File, val id: Int, val deadlineNs: Long) {
  var fixtureGeneration: Long? = null
  var width = 0
  var height = 0
  var scale = 0f
  var updates = 0L
  var beforeUpdates = 0L
  var beforeNs = 0L
  var submittedNs = 0L
  var workerDoneNs = 0L
  var presentOrdinal = 0
  var submission = 0L
  val history = JSONArray()
}

private class ColdFirstPixel(val dir: File, val id: Int, val deadlineNs: Long) {
  var readyGeneration = -1L
  var readySequence = 0L
  var readyFollowEpoch = 0L
  var updates = 0L
  var request: ColdFirstRequest? = null
}

private data class ColdFirstRequest(
  val revision: Long, val generation: Long, val width: Int, val height: Int, val density: Float,
  val beforeNs: Long, val beforeUpdates: Long,
)

private class ColdFactorTrial(val ordinal: Int, val mode: Char, val deadlineNs: Long) {
  var readyGeneration = -1L
  var readySequence = 0L
  var readyFollowEpoch = 0L
  var attempts = 0
  var firstPresent = false
}

/**
 * Parity port of the Swift view. TextureView hosts a transparent Vulkan surface,
 * Choreographer replaces CADisplayLink, and all Rust work stays on the shared worker.
 */
class KineSyncRustLyricsView(context: Context, appContext: AppContext) : ExpoView(context, appContext),
  TextureView.SurfaceTextureListener, Choreographer.FrameCallback {
  private val onStatus by EventDispatcher<Map<String, Any?>>()
  private val onMetrics by EventDispatcher<Map<String, Any?>>()
  private val main = Handler(Looper.getMainLooper())
  private val textureView = TextureView(context)
  private var owner: RustOwner? = null
  private var texture: SurfaceTexture? = null
  private var loggedUpdateSession = -1L
  private var pixelCaptureDir: File? = null
  private var pixelCaptureId = 0
  private var pixelUpdateSeen = false
  private var pixelCaptureSaved = false
  private var pixelInitialBufferNs = 0L
  private var pixelHoldUntilNs = 0L
  private var pixelBurst: PixelBurst? = null
  private var coldFirstPixel: ColdFirstPixel? = null
  private var coldFactorTrial: ColdFactorTrial? = null

  private var session = 0L
  private var generation = 0L
  private var sequence = 0L
  private var track = ""
  private var trackId = ""
  private var anchor: Anchor? = null
  private var enabled = true
  // Desired follow ownership, replayed when the owner is created or the track changes.
  private var following = true
  // Invalidates an asynchronous release handoff after a newer touch, track or follow command.
  private var followEpoch = 0L
  // A queued JS touch-down false must not undo a release recapture.
  private var releasePending = false
  private var releaseRecaptured = false
  private var releaseSerial = 0L
  // JS ownership epochs order touches, parent changes and track resets. Native
  // rejects true commands from an older epoch and while a newer touch is active.
  private var ownershipEpoch = 0L
  private var ownershipFloor = 0L
  private var touchActive = false
  private var foreground = true
  private var attached = false
  private var busy = false
  private var dirty = true
  private var frameRevision = 0L
  private var retryCount = 0
  private var retryBlocked = false
  private var retryWork: Runnable? = null
  private var displayedGeneration = -1L
  private var surfaceWaiting = false
  private var failed = false
  private var animating = false
  private var resumePending = false
  private var nextCueNativeMs = -1.0
  private var cueWork: Runnable? = null
  private var cueDeadline = -1.0
  private var callbackPosted = false

  private var callbacks = 0L
  private var submitted = 0L
  private var idle = 0L
  private var busyCallbacks = 0L
  private var inactive = 0L
  private var noDrawable = 0L
  private var presentCalls = 0L
  private var missedEstimate = 0L
  private var windowStart = 0.0
  private var windowCallbacks = 0L
  private var windowPresent = 0L
  private var windowBusy = 0L
  private var windowMissed = 0L
  private var previousFrameNs = 0L
  private var previousStepNs = 0L
  private var tickMs = 0.0
  private var intervalMs = 0.0
  private var requestedHz = 0.0

  // Gesture state. Rust takes logical (dp) units.
  private var velocity: VelocityTracker? = null
  private var downY = 0f
  private var lastY = 0f
  private var dragging = false
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private val maxFling = ViewConfiguration.get(context).scaledMaximumFlingVelocity.toFloat()
  private val density get() = resources.displayMetrics.density

  companion object { private val retryDelays = longArrayOf(100, 200, 400, 800) }

  init {
    clipChildren = true
    setBackgroundColor(Color.TRANSPARENT)
    textureView.isOpaque = false
    updatePresentationVisibility()
    textureView.surfaceTextureListener = this
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  // React Native does not lay out natively added children; size the texture to this view.
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l; val h = b - t
    textureView.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    textureView.layout(0, 0, w, h)
  }

  // Observe touches without consuming them so JS keeps tap and hold classification.
  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        velocity?.recycle(); velocity = VelocityTracker.obtain()
        downY = ev.y; lastY = ev.y; dragging = false
        // Invalidate an in-flight release before queued JS ownership arrives.
        releasePending = false
        releaseRecaptured = false
        touchActive = true
        ownershipFloor = maxOf(ownershipFloor, ownershipEpoch + 1)
        followEpoch++
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(ev)
        if (!dragging && kotlin.math.abs(ev.y - downY) > slop) {
          dragging = true; takeOwnership()
          parent?.requestDisallowInterceptTouchEvent(true)
        }
        if (dragging) {
          val dy = ev.y - lastY
          owner?.scrollBy(-dy / density.toDouble()); markDirty(); lifecycle()
        }
        lastY = ev.y
      }
      MotionEvent.ACTION_UP -> {
        velocity?.addMovement(ev)
        touchActive = false
        if (dragging) {
          velocity?.computeCurrentVelocity(1000, maxFling)
          fling(-(velocity?.yVelocity ?: 0f) / density.toDouble() / 1000.0)
        }
        velocity?.recycle(); velocity = null; dragging = false
      }
      MotionEvent.ACTION_CANCEL -> {
        touchActive = false
        if (dragging) fling(0.0)
        velocity?.recycle(); velocity = null; dragging = false
      }
    }
    velocity?.let { if (ev.actionMasked == MotionEvent.ACTION_DOWN) it.addMovement(ev) }
    return super.dispatchTouchEvent(ev)
  }

  // Claim the gesture so Android keeps routing MOVE/UP here for native drag and fling.
  // dispatchTouchEvent only observes; the React root still sees every event through its
  // own intercept path, so JS tap and hold classification is untouched. No native-gesture takeover.
  override fun onTouchEvent(event: MotionEvent): Boolean = true

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attached = true; foreground = windowVisibility == VISIBLE
    markDirty(); refresh(); lifecycle()
  }
  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    rejectColdFirst(1)
    abortPixelBurst(PixelBurstFailure.Detached)
    attached = false
    updatePresentationVisibility()
    velocity?.recycle(); velocity = null; dragging = false
    Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
    cancelRetry(); cancelCue()
    owner?.setVisible(false)
    busy = false; animating = false
  }
  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    foreground = visibility == VISIBLE
    if (!foreground) rejectColdFirst(1)
    if (!foreground) abortPixelBurst(PixelBurstFailure.WindowHidden)
    if (foreground) { markDirty(); refresh() }
    lifecycle()
  }
  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (pixelBurst?.fixtureGeneration != null) abortPixelBurst(PixelBurstFailure.ViewResized)
    markDirty(); refresh(); lifecycle()
  }

  // TextureView surface lifecycle. One owner per SurfaceTexture.
  private fun logSurface(event: String, st: SurfaceTexture, w: Int, h: Int) {
    val location = IntArray(2)
    textureView.getLocationInWindow(location)
    val transform = textureView.getTransform(Matrix())
    logRustDiag("$event texture=${System.identityHashCode(st)} session=$session generation=$generation " +
      "size=${w}x$h viewSize=${width}x$height windowOrigin=${location[0]},${location[1]} " +
      "bounds=${textureView.left},${textureView.top},${textureView.right},${textureView.bottom} " +
      "hardware=${textureView.isHardwareAccelerated} layerType=${textureView.layerType} " +
      "alpha=${textureView.alpha} viewMatrix=${textureView.matrix} textureTransform=$transform")
  }

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
    loseColdFactorSurface()
    rejectColdFirst(1)
    abortPixelBurst(PixelBurstFailure.SurfaceReplaced)
    texture = st
    session++
    pixelCaptureDir = if (context.packageName == "dev.kineticron.KineSync.testnov18") {
      File(context.filesDir, "rust-pixel-diag").takeIf { File(it, "arm").isFile }
    } else null
    if (session == 1L && pixelCaptureDir == null && context.packageName == "dev.kineticron.KineSync.testnov18") {
      val ticket = readPixelMarker(File(context.filesDir, "rust-pixel-diag"), "cold-factor").orEmpty()
      if (ticket.length == 3 && ticket[0] in '1'..'6' && ticket[1] == ' ' && ticket[2] in "BG") {
        coldFactorTrial = ColdFactorTrial(ticket[0] - '0', ticket[2], System.nanoTime() + 12_000_000_000L)
        logColdFactorSnapshot("ticket")
      }
    }
    val marker = pixelCaptureDir?.let { readPixelMarker(it, "arm") }.orEmpty()
    pixelCaptureId = marker.removePrefix("burst ").toIntOrNull() ?: 0
    if (pixelCaptureId !in 1..255) pixelCaptureDir = null
    if (marker.startsWith("burst ")) pixelCaptureDir?.let { dir ->
      pixelBurst = PixelBurst(dir, pixelCaptureId, System.nanoTime() + 18_000_000_000L)
    }
    if (marker == pixelCaptureId.toString()) pixelCaptureDir?.let { dir ->
      if (pixelMarker(dir, "cold-first") == pixelCaptureId) {
        coldFirstPixel = ColdFirstPixel(dir, pixelCaptureId, System.nanoTime() + 12_000_000_000L)
      }
    }
    pixelUpdateSeen = false
    pixelCaptureSaved = false
    pixelInitialBufferNs = if (pixelCaptureDir == null) 0L else st.timestamp
    pixelHoldUntilNs = 0L
    logSurface("surface.available", st, w, h)
    val epoch = session
    displayedGeneration = -1L
    failed = false; updatePresentationVisibility(); markDirty()
    owner = RustOwner(context, st) { event -> handleEvent(event, epoch) }
    refresh(); lifecycle()
  }
  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
    logSurface("surface.resize", st, w, h)
    if (pixelBurst?.fixtureGeneration != null) abortPixelBurst(PixelBurstFailure.SurfaceResized)
    markDirty(); refresh(); lifecycle()
  }
  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    logSurface("surface.destroy", st, textureView.width, textureView.height)
    rejectColdFirst(1)
    abortPixelBurst(PixelBurstFailure.SurfaceDestroyed)
    loseColdFactorSurface()
    pixelCaptureDir = null
    pixelHoldUntilNs = 0L
    Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
    cancelRetry(); cancelCue()
    val o = owner
    if (o != null) { o.dispose(); owner = null } else st.release()
    texture = null
    session++; busy = false; animating = false
    displayedGeneration = -1L
    updatePresentationVisibility()
    // Owner releases the texture after kr_destroy, so the view must not.
    return false
  }
  override fun onSurfaceTextureUpdated(st: SurfaceTexture) {
    if (loggedUpdateSession != session) {
      loggedUpdateSession = session
      logSurface("surface.firstUpdate", st, textureView.width, textureView.height)
    }
    if (st === texture) pixelBurst?.let { it.updates++ }
    if (st === texture) coldFirstPixel?.let { it.updates++ }
    if (pixelCaptureDir == null || st !== texture || pixelUpdateSeen) return
    pixelUpdateSeen = true
    logRustDiag("pixelDiag.update capture=$pixelCaptureId session=$session " +
      "texture=${System.identityHashCode(st)} callbackNs=${st.timestamp} initialNs=$pixelInitialBufferNs")
  }

  private fun awaitPixelBitmap(dir: File, expectedGeneration: Long) {
    val st = texture ?: return
    val epoch = session
    val id = pixelCaptureId
    val width = textureView.width
    val height = textureView.height
    val cold = coldFirstPixel
    main.post(object : Runnable {
      override fun run() {
        if (session != epoch || texture !== st || pixelCaptureDir != dir || pixelCaptureId != id ||
          pixelHoldUntilNs == 0L || pixelMarker(dir, "release") == id) return
        val timestamp = st.timestamp
        val request = cold?.request
        if (cold != null && (coldFirstPixel !== cold || !coldFirstRequestCurrent(request))) {
          rejectColdFirst(3)
          return
        }
        if (generation != expectedGeneration || textureView.width != width || textureView.height != height ||
          System.nanoTime() >= pixelHoldUntilNs) {
          logRustDiag("pixelDiag.textureUnpaired capture=$id session=$epoch updateSeen=$pixelUpdateSeen " +
            "bufferNs=$timestamp initialNs=$pixelInitialBufferNs generation=$generation " +
            "expectedGeneration=$expectedGeneration size=${textureView.width}x${textureView.height} expectedSize=${width}x$height")
          if (cold != null) rejectColdFirst(4)
          return
        }
        if (!pixelUpdateSeen || displayedGeneration != expectedGeneration || textureView.alpha != 1f ||
          timestamp == 0L || timestamp == pixelInitialBufferNs ||
          (cold != null && request != null &&
            (cold.updates <= request.beforeUpdates || timestamp <= maxOf(0L, request.beforeNs)))) {
          main.postDelayed(this, 16L)
          return
        }
        savePixelBitmap(dir, st, timestamp, cold = cold)
      }
    })
  }

  private fun pixelGeometry(st: SurfaceTexture): JSONArray {
    val origin = IntArray(2)
    textureView.getLocationOnScreen(origin)
    val view = FloatArray(9).also { textureView.matrix.getValues(it) }
    val content = FloatArray(9).also { textureView.getTransform(Matrix()).getValues(it) }
    val uv = FloatArray(16).also { st.getTransformMatrix(it) }
    return JSONArray().apply {
      put(origin[0]); put(origin[1]); put(textureView.width); put(textureView.height); put(textureView.alpha.toDouble())
      for (values in arrayOf(view, content, uv)) for (value in values) put(value.toDouble())
    }
  }

  private fun savePixelBitmap(dir: File, st: SurfaceTexture, textureTimestamp: Long, burst: PixelBurst? = null,
                              cold: ColdFirstPixel? = null) {
    try {
      val geometry = if (burst != null || cold != null) pixelGeometry(st) else null
      val bitmap = textureView.bitmap ?: error("TextureView bitmap unavailable")
      try {
        check(st === texture && st.timestamp == textureTimestamp) { "SurfaceTexture buffer changed during bitmap copy" }
        if (geometry != null) {
          check(geometry.toString() == pixelGeometry(st).toString() && st.timestamp == textureTimestamp) {
            "SurfaceTexture geometry changed during bitmap copy"
          }
        }
        check(bitmap.config == Bitmap.Config.ARGB_8888)
        check(bitmap.rowBytes >= bitmap.width * 4 && bitmap.byteCount == bitmap.rowBytes * bitmap.height)
        val raw = ByteBuffer.allocate(bitmap.byteCount)
        bitmap.copyPixelsToBuffer(raw)
        File(dir, "frame-1-textureview.raw").writeBytes(raw.array())
        val file = File(dir, "frame-1-textureview.png")
        file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        val rawSha = pixelSha256(raw.array())
        val pngSha = pixelSha256(file.readBytes())
        val metadata = JSONObject()
          .put("frame", 1).put("capture", pixelCaptureId).put("session", session).put("generation", generation)
          .put("texture", System.identityHashCode(st)).put("bufferNs", textureTimestamp)
          .put("width", bitmap.width).put("height", bitmap.height).put("rawRowBytes", bitmap.rowBytes)
          .put("config", bitmap.config.toString()).put("byteOrder", ByteOrder.nativeOrder().toString())
          .put("colorSpace", bitmap.colorSpace?.name).put("premultiplied", bitmap.isPremultiplied)
          .put("rawSha256", rawSha).put("pngSha256", pngSha)
        // Keep the buffer held while the runner takes its matching screen crop.
        pixelHoldUntilNs = System.nanoTime() + 10_000_000_000L
        if (burst != null) {
          metadata.put("presentOrdinal", burst.presentOrdinal).put("presentHistory", burst.history)
            .put("geometry", geometry).put("holdUntilNs", pixelHoldUntilNs)
        }
        if (cold != null) {
          val request = checkNotNull(cold.request)
          check(coldFirstRequestCurrent(request) && st.timestamp == textureTimestamp)
          metadata.put("geometry", geometry).put("holdUntilNs", pixelHoldUntilNs)
            .put("requestedRevision", request.revision).put("beforeNs", request.beforeNs)
        }
        File(dir, "frame-1-textureview.json").writeText(metadata.toString(2))
        pixelCaptureSaved = true
        logRustDiag("pixelDiag.texture capture=$pixelCaptureId frame=1 session=$session generation=$generation " +
          "texture=${System.identityHashCode(st)} bufferNs=$textureTimestamp size=${bitmap.width}x${bitmap.height} " +
          "rawSha256=$rawSha pngSha256=$pngSha path=${file.absolutePath}")
      } finally {
        bitmap.recycle()
      }
    } catch (error: Exception) {
      logRustDiag("pixelDiag.textureFailed capture=$pixelCaptureId frame=1 session=$session error=$error")
      if (burst != null) abortPixelBurst(PixelBurstFailure.BitmapCopy)
      if (cold != null) rejectColdFirst(6)
    }
  }

  private fun pixelSha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun readPixelMarker(dir: File, name: String): String? =
    runCatching { File(dir, name).readText().trim() }.getOrNull()

  private fun pixelMarker(dir: File, name: String): Int? = readPixelMarker(dir, name)?.toIntOrNull()

  private fun pixelReady(dir: File): Boolean =
    !File(dir, "arm").exists() && pixelMarker(dir, "frame-1.ready") == pixelCaptureId

  private fun logColdFactorSnapshot(phase: String, requested: Long = -1L, result: FrameResult? = null) {
    val trial = coldFactorTrial ?: return
    val st = texture ?: return
    logRustDiag("pixelDiag.coldFactor phase=$phase trial=${trial.ordinal} mode=${trial.mode} " +
      "texture=${System.identityHashCode(st)} session=$session generation=$generation " +
      "sequence=$sequence followEpoch=$ownershipEpoch revision=$frameRevision priorPresents=$presentCalls " +
      "attempt=${trial.attempts} requestedRevision=$requested workerGeneration=${result?.generation ?: -1L} " +
      "status=${result?.status ?: -1}")
  }

  private fun loseColdFactorSurface() {
    if (coldFactorTrial?.firstPresent == false) logColdFactorSnapshot("surfaceLost")
    coldFactorTrial = null
  }

  private fun endColdFirst() {
    coldFirstPixel = null
    pixelCaptureDir = null
    pixelHoldUntilNs = 0L
  }

  private fun rejectColdFirst(code: Int) {
    val cold = coldFirstPixel ?: return
    runCatching { File(cold.dir, "cold-first-failed").writeText("${cold.id} $code") }
    logRustDiag("pixelDiag.coldFirstRejected capture=${cold.id} code=$code session=$session generation=$generation " +
      "requestedRevision=${cold.request?.revision} currentRevision=$frameRevision displayedGeneration=$displayedGeneration")
    endColdFirst()
  }

  private fun coldFirstRequestCurrent(request: ColdFirstRequest?): Boolean = request != null &&
    request.revision == frameRevision && request.generation == generation && request.width == textureView.width &&
    request.height == textureView.height && request.density == density && attached && foreground && enabled && !failed

  private fun endPixelBurst() {
    pixelBurst = null
    pixelCaptureDir = null
    pixelHoldUntilNs = 0L
  }

  private fun abortPixelBurst(reason: PixelBurstFailure) {
    val burst = pixelBurst ?: return
    runCatching {
      val marker = File(burst.dir, "burst-failed")
      if (!marker.exists()) marker.writeText("${burst.id} ${reason.code}")
    }
    logRustDiag("pixelDiag.burstAborted capture=${burst.id} session=$session code=${reason.code} reason=$reason")
    endPixelBurst()
  }

  private fun pausedPixelCredits(): Boolean {
    val a = anchor ?: return false
    return trackId == "fx-track-credits" && a.generation == generation && !a.playing && a.positionMs == 51600.0
  }

  // Returns true while a draw is gated on a consumer latch, or while the final buffer is held.
  private fun gatePixelBurst(burst: PixelBurst): Boolean {
    val st = texture
    if (pixelMarker(burst.dir, "release") == burst.id) {
      endPixelBurst()
      return false
    }
    val failure = readPixelMarker(burst.dir, "burst-failed")?.substringBefore(' ')?.toIntOrNull()
    if (failure == burst.id) {
      endPixelBurst()
      return true
    }
    if (st == null) {
      abortPixelBurst(PixelBurstFailure.SurfaceMissing)
      return true
    }
    val now = System.nanoTime()
    val expectedGeneration = burst.fixtureGeneration
    val armPending = File(burst.dir, "arm").exists()
    if (now >= (if (pixelCaptureSaved) pixelHoldUntilNs else burst.deadlineNs)) {
      abortPixelBurst(when {
        pixelCaptureSaved -> PixelBurstFailure.HoldExpired
        armPending -> PixelBurstFailure.ClaimWait
        busy -> PixelBurstFailure.WorkerWait
        expectedGeneration == null -> PixelBurstFailure.FixtureWait
        burst.presentOrdinal > burst.history.length() -> PixelBurstFailure.ConsumerWait
        else -> PixelBurstFailure.DrawWait
      })
      return true
    }
    if (expectedGeneration != null && (!pausedPixelCredits() || generation != expectedGeneration ||
        textureView.width != burst.width || textureView.height != burst.height || density != burst.scale)) {
      abortPixelBurst(PixelBurstFailure.FixtureChanged)
      return true
    }
    if (busy || !pausedPixelCredits() || armPending) return true
    if (pixelCaptureSaved) {
      val finalNs = burst.history.optJSONObject(PIXEL_BURST_PRESENTS - 1)?.optLong("bufferNs")
      if (st.timestamp != finalNs) abortPixelBurst(PixelBurstFailure.HeldTimestampChanged)
      return true
    }
    if (burst.presentOrdinal == burst.history.length()) return false
    val timestamp = st.timestamp
    if (displayedGeneration != expectedGeneration || textureView.alpha != 1f ||
      burst.updates <= burst.beforeUpdates || timestamp <= maxOf(0L, burst.beforeNs)) return true
    val geometry = runCatching { pixelGeometry(st) }.getOrElse {
      abortPixelBurst(PixelBurstFailure.InvalidGeometry)
      return true
    }
    if (st.timestamp != timestamp) return true
    burst.history.put(JSONObject().put("ordinal", burst.presentOrdinal).put("submission", burst.submission)
      .put("session", session).put("generation", generation).put("texture", System.identityHashCode(st))
      .put("beforeNs", burst.beforeNs).put("bufferNs", timestamp).put("submittedNs", burst.submittedNs)
      .put("beforeUpdates", burst.beforeUpdates).put("updates", burst.updates)
      .put("workerDoneNs", burst.workerDoneNs).put("observedNs", now).put("geometry", geometry))
    logRustDiag("pixelDiag.burstLatch capture=${burst.id} ordinal=${burst.presentOrdinal} session=$session " +
      "generation=$generation texture=${System.identityHashCode(st)} beforeNs=${burst.beforeNs} bufferNs=$timestamp")
    if (burst.presentOrdinal == PIXEL_BURST_PRESENTS) {
      savePixelBitmap(burst.dir, st, timestamp, burst)
    }
    return true
  }

  private fun recordPixelBurstPresent(burst: PixelBurst, result: FrameResult) {
    if (result.status != 0) {
      if (result.status != 2 && result.status != 3) abortPixelBurst(PixelBurstFailure.WorkerStatus)
      return
    }
    val receipt = readPixelMarker(burst.dir, "burst-present")?.split(' ').orEmpty()
    val ordinal = burst.presentOrdinal + 1
    val submission = receipt.getOrNull(2)?.toLongOrNull() ?: 0L
    if (receipt.size != 3 || receipt[0].toIntOrNull() != burst.id || receipt[1].toIntOrNull() != ordinal ||
      submission != burst.submission + 1 || result.generation != burst.fixtureGeneration ||
      (ordinal == PIXEL_BURST_PRESENTS && !pixelReady(burst.dir))) {
      abortPixelBurst(PixelBurstFailure.ProducerReceipt)
      return
    }
    burst.presentOrdinal = ordinal
    burst.submission = submission
    burst.workerDoneNs = System.nanoTime()
  }

  private fun handleEvent(event: Map<String, Any?>, epoch: Long) {
    if (session != epoch || (event["generation"] as? Long) != generation) return
    if (event["state"] == "metrics") {
      val elapsed = RustBridge.nowMs() / 1000 - windowStart
      if (elapsed < 1) return
      val m = HashMap(event)
      m["uiTickMs"] = tickMs; m["displayIntervalMs"] = intervalMs
      m["callbackTotal"] = callbacks; m["submitted"] = submitted; m["idle"] = idle; m["busy"] = busyCallbacks
      m["inactive"] = inactive; m["noDrawable"] = noDrawable; m["missedObservedIntervalsEstimate"] = missedEstimate
      m["requestedHz"] = requestedHz; m["windowSeconds"] = elapsed
      m["deliveredCallbackHz"] = (callbacks - windowCallbacks) / elapsed
      m["busyCallbacksInWindow"] = busyCallbacks - windowBusy
      m["missedIntervalsInWindow"] = missedEstimate - windowMissed
      m["presentCallRate"] = (presentCalls - windowPresent) / elapsed
      windowStart = RustBridge.nowMs() / 1000
      windowCallbacks = callbacks; windowPresent = presentCalls; windowBusy = busyCallbacks; windowMissed = missedEstimate
      onMetrics(m)
    } else {
      if (event["state"] == "error") {
        rejectColdFirst(5)
        abortPixelBurst(PixelBurstFailure.WorkerError)
        failed = true; updatePresentationVisibility()
        Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
      }
      if (event["state"] == "ready") {
        coldFactorTrial?.let { trial ->
          trial.readyGeneration = generation
          trial.readySequence = sequence
          trial.readyFollowEpoch = ownershipEpoch
          logColdFactorSnapshot("ready")
        }
        coldFirstPixel?.let { cold ->
          cold.readyGeneration = generation
          cold.readySequence = sequence
          cold.readyFollowEpoch = ownershipEpoch
          logRustDiag("pixelDiag.coldFirstReady capture=${cold.id} session=$session generation=$generation " +
            "sequence=$sequence followEpoch=$ownershipEpoch")
        }
        markDirty(); lifecycle()
      }
      onStatus(event)
    }
  }

  fun setTrack(value: String) {
    if (value.length > 2_000_000) return
    val id = try { JSONObject(value).getLong("generation") } catch (_: Exception) { return }
    if (id <= generation) return
    val nextTrackId = try { JSONObject(value).getString("track_id") } catch (_: Exception) { return }
    if (pixelBurst?.fixtureGeneration != null) abortPixelBurst(PixelBurstFailure.TrackGenerationChanged)
    generation = id; sequence = 0; anchor = null; animating = false
    ownershipEpoch = 0; ownershipFloor = 0; touchActive = false
    releasePending = false; releaseRecaptured = false
    // Only a track identity change restores follow. Translation, credit and
    // layout revisions keep the user's manual ownership.
    if (nextTrackId != trackId) {
      trackId = nextTrackId
      following = true
      releasePending = false
      followEpoch++
    }
    failed = false; updatePresentationVisibility()
    track = value; markDirty(); refresh(); lifecycle()
  }
  fun copyLayout(promise: Promise) {
    val o = owner ?: return promise.reject("ERR_RUST_LAYOUT", "Rust owner unavailable", null)
    o.copyLayout { r -> if (r != null) promise.resolve(r) else promise.reject("ERR_RUST_LAYOUT", "No prepared Rust layout receipt", null) }
  }
  fun setAnchor(value: String) {
    val next = try {
      val j = JSONObject(value)
      Anchor(j.getLong("generation"), j.getLong("sequence"), j.getDouble("positionMs"), j.getDouble("nativeMs"),
        j.getBoolean("playing"), j.getDouble("rate"), j.getBoolean("snap"))
    } catch (_: Exception) {
      failed = true; updatePresentationVisibility(); lifecycle()
      onStatus(mapOf("state" to "error", "generation" to generation, "message" to "Invalid Rust playback anchor"))
      return
    }
    if (next.generation != generation || next.sequence <= sequence) return
    if (pixelBurst?.fixtureGeneration != null && (next.playing || next.positionMs != 51600.0)) {
      abortPixelBurst(PixelBurstFailure.AnchorChanged)
    }
    sequence = next.sequence; anchor = next; markDirty()
    owner?.setAnchor(next)
    lifecycle()
  }
  fun setActive(value: Boolean) {
    enabled = value
    if (!value) rejectColdFirst(1)
    if (!value) abortPixelBurst(PixelBurstFailure.Inactive)
    if (value) { markDirty(); refresh() }
    lifecycle()
  }
  fun setFollowing(value: Boolean, epoch: Double, commandGeneration: Double, gesture: Boolean) {
    if (!epoch.isFinite() || epoch < 0 || !commandGeneration.isFinite() || commandGeneration < 0) return
    if (commandGeneration.toLong() != generation) return
    val nextEpoch = epoch.toLong()
    // A delayed touch-down false belongs to the release gesture even when the
    // near recapture already won physical ownership. Record its epoch without
    // undoing the recapture, then re-announce the recapture at that epoch so JS
    // can accept the current gesture instead of rejecting an older event.
    if (lateGestureOwnershipAllowed(value, gesture, nextEpoch)) {
      ownershipEpoch = nextEpoch
      if (releaseRecaptured) emitRecapturedFollow()
      return
    }
    if (!followCommandAllowed(value, nextEpoch)) return
    ownershipEpoch = nextEpoch
    if (value) ownershipFloor = maxOf(ownershipFloor, nextEpoch)
    releasePending = false
    releaseRecaptured = false
    following = value; followEpoch++; owner?.setFollowing(value); markDirty(); lifecycle()
  }
  private fun lateGestureOwnershipAllowed(value: Boolean, gesture: Boolean, nextEpoch: Long): Boolean {
    if (nextEpoch <= ownershipEpoch) return false
    if (value || !gesture || !releasePending) return false
    return true
  }
  private fun emitRecapturedFollow() {
    onStatus(mapOf("state" to "follow", "generation" to generation,
      "ownershipEpoch" to ownershipEpoch,
      "message" to "Auto-follow resumed near the active line"))
  }
  // A true from before a newer touch, or while that touch owns the viewport,
  // must not reclaim follow even when its JS callback is delayed.
  private fun followCommandAllowed(value: Boolean, nextEpoch: Long): Boolean {
    if (nextEpoch <= ownershipEpoch) return false
    if (value && (touchActive || nextEpoch <= ownershipFloor)) return false
    return true
  }
  // Native drag starts ownership without consuming a JS epoch. The following
  // JS false command still records the epoch and keeps command ordering intact.
  private fun takeOwnership() {
    releasePending = false
    releaseRecaptured = false
    following = false
    followEpoch++
    owner?.setFollowing(false)
    markDirty(); lifecycle()
  }
  fun scrollBy(dy: Double) {
    if (!dy.isFinite() || dy == 0.0) return
    owner?.scrollBy(dy); markDirty(); lifecycle()
  }
  fun fling(v: Double) {
    if (!v.isFinite()) return
    val releaseSession = session
    val releaseGeneration = generation
    val releaseEpoch = followEpoch
    releaseSerial++
    val serial = releaseSerial
    releasePending = true
    releaseRecaptured = false
    owner?.fling(v, RustBridge.nowMs()) { resumed ->
      if (session == releaseSession && generation == releaseGeneration && followEpoch == releaseEpoch && releaseSerial == serial && !failed) {
        if (resumed) {
          following = true
          releaseRecaptured = true
          emitRecapturedFollow()
        } else {
          releasePending = false
          releaseRecaptured = false
        }
      }
    }
    markDirty(); lifecycle()
  }
  fun hitTest(x: Double, y: Double, promise: Promise) {
    if (!x.isFinite() || !y.isFinite()) return promise.reject("ERR_RUST_HIT", "Invalid lyric hit-test point", null)
    val o = owner ?: return promise.resolve(-1)
    o.hitTest(x, y) { promise.resolve(it) }
  }

  private fun refresh() {
    if (!attached || !foreground || !enabled || failed) return
    val o = owner ?: return
    val d = density
    o.update(track, generation, anchor, width, height, d)
    o.setFollowing(following)
  }

  // Alpha preserves the TextureView surface while inactive. Every presentation,
  // including a late worker completion, must pass the current lifecycle gate.
  private fun updatePresentationVisibility() {
    val presentable = attached && foreground && enabled && !failed && !surfaceWaiting &&
      owner != null && displayedGeneration == generation
    textureView.alpha = if (presentable) 1f else 0f
  }

  private fun lifecycle() {
    updatePresentationVisibility()
    val visible = attached && foreground && enabled && !failed && width > 0 && height > 0 && owner != null
    owner?.setVisible(visible)
    if (!visible) { cancelRetry(); cancelCue(); resumePending = false }
    if (visible && retryWork == null && !retryBlocked && (dirty || animating || pixelBurst != null)) {
      cancelCue()
      if (!callbackPosted) {
        val hz = display?.refreshRate?.toDouble() ?: 60.0
        requestedHz = hz
        windowStart = RustBridge.nowMs() / 1000
        windowCallbacks = callbacks; windowPresent = presentCalls; windowBusy = busyCallbacks; windowMissed = missedEstimate
        callbackPosted = true
        Choreographer.getInstance().postFrameCallback(this)
      }
    } else {
      Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
      previousFrameNs = 0; previousStepNs = 0
      if (visible && !busy && retryWork == null && !retryBlocked) {
        resumePending = anchor?.playing == true && (anchor?.rate ?: 0.0) > 0
        scheduleCue()
      }
    }
  }

  private fun cancelCue() { cueWork?.let { main.removeCallbacks(it) }; cueWork = null; cueDeadline = -1.0 }
  private fun cancelRetry() { retryWork?.let { main.removeCallbacks(it) }; retryWork = null }

  private fun scheduleCue() {
    val a = anchor
    if (!nextCueNativeMs.isFinite() || nextCueNativeMs < 0 || a?.playing != true || a.rate <= 0) { cancelCue(); return }
    if (cueWork != null && cueDeadline == nextCueNativeMs) return
    cancelCue()
    val deadline = nextCueNativeMs
    val revision = frameRevision
    val epoch = session
    val hz = display?.refreshRate?.toDouble() ?: 60.0
    val delay = maxOf(0.0, deadline - RustBridge.nowMs() - 1000 / hz).toLong()
    val work = object : Runnable {
      override fun run() {
        val an = anchor
        if (session != epoch || frameRevision != revision || nextCueNativeMs != deadline || cueDeadline != deadline ||
          cueWork !== this || !attached || !foreground || !enabled || failed || an?.playing != true || an.rate <= 0) return
        cancelCue(); markDirty(); lifecycle()
      }
    }
    cueDeadline = deadline; cueWork = work
    main.postDelayed(work, delay)
  }

  override fun doFrame(frameTimeNanos: Long) {
    callbackPosted = false
    val start = System.nanoTime()
    try { tick(frameTimeNanos) } finally { tickMs = (System.nanoTime() - start) / 1e6 }
  }

  private fun tick(frameNs: Long) {
    callbacks++
    if (!attached || !foreground || !enabled || failed || retryBlocked || retryWork != null) { inactive++; lifecycle(); return }
    val burst = pixelBurst
    if (burst != null && (gatePixelBurst(burst) || pixelBurst == null)) { repost(); return }
    if (burst == null && pixelHoldUntilNs != 0L) {
      val released = pixelCaptureDir?.let { pixelMarker(it, "release") == pixelCaptureId } == true
      if (!released && System.nanoTime() < pixelHoldUntilNs) { repost(); return }
      logRustDiag("pixelDiag.holdEnd capture=$pixelCaptureId frame=1 session=$session " +
        "updateSeen=$pixelUpdateSeen bitmapSaved=$pixelCaptureSaved released=$released")
      if (coldFirstPixel != null && !released) rejectColdFirst(4) else endColdFirst()
    }
    if (previousFrameNs > 0) {
      val gap = frameNs - previousFrameNs
      intervalMs = gap / 1e6
      if (previousStepNs > 0) missedEstimate += maxOf(0.0, Math.rint(gap.toDouble() / previousStepNs) - 1).toLong()
    }
    previousFrameNs = frameNs
    val periodNs = (1e9 / (display?.refreshRate?.toDouble() ?: 60.0)).toLong()
    previousStepNs = periodNs
    coldFactorTrial?.let { trial ->
      if (!trial.firstPresent && System.nanoTime() >= trial.deadlineNs) {
        logColdFactorSnapshot("timeout")
        coldFactorTrial = null
      } else if (trial.attempts == 0) {
        val ready = trial.readyGeneration == generation && ownershipEpoch > trial.readyFollowEpoch &&
          sequence > trial.readySequence && pausedPixelCredits()
        if (!ready && trial.mode == 'G') { repost(); return }
      }
    }
    // Keep the loop alive for the next vsync while work is pending.
    if (busy) { busyCallbacks++; repost(); return }
    val cold = coldFirstPixel
    if (cold != null) {
      if (pixelMarker(cold.dir, "release") == cold.id) { endColdFirst(); repost(); return }
      if (System.nanoTime() >= cold.deadlineNs) { rejectColdFirst(2); repost(); return }
      // JS handles ready by sending a fresh follow epoch and then a fresh anchor. Both
      // commands dirty the frame, so consume them before submitting the first draw.
      if (cold.readyGeneration != generation || ownershipEpoch <= cold.readyFollowEpoch ||
        sequence <= cold.readySequence || !pausedPixelCredits()) { repost(); return }
      if (cold.request?.generation != generation) {
        val style = runCatching { JSONObject(track).optJSONObject("settings")?.optString("style") }.getOrNull()
        if (style != "amll") { rejectColdFirst(7); repost(); return }
      }
    }
    if (!dirty && !animating && burst == null) { idle++; lifecycle(); return }
    val o = owner ?: run { inactive++; return }
    if (burst != null) {
      if (burst.fixtureGeneration == null) {
        val style = runCatching { JSONObject(track).optJSONObject("settings")?.optString("style") }.getOrNull()
        if (style != "amll") {
          abortPixelBurst(PixelBurstFailure.FixtureStyle)
          repost()
          return
        }
        burst.fixtureGeneration = generation
        burst.width = textureView.width
        burst.height = textureView.height
        burst.scale = density
      }
      burst.beforeNs = texture?.timestamp ?: 0L
      if (burst.presentOrdinal > 0 &&
        burst.beforeNs != burst.history.optJSONObject(burst.presentOrdinal - 1)?.optLong("bufferNs")) {
        abortPixelBurst(PixelBurstFailure.UnexpectedBufferBetweenDraws)
        repost()
        return
      }
      burst.beforeUpdates = burst.updates
      burst.submittedNs = System.nanoTime()
    }
    busy = true; dirty = false; submitted++
    val epoch = session
    val requestedRevision = frameRevision
    coldFactorTrial?.let { trial ->
      if (!trial.firstPresent) {
        trial.attempts++
        if (trial.attempts == 1) logColdFactorSnapshot("submit", requestedRevision)
      }
    }
    if (cold != null) {
      cold.request = ColdFirstRequest(requestedRevision, generation, textureView.width, textureView.height, density,
        texture?.timestamp ?: 0L, cold.updates)
      logRustDiag("pixelDiag.coldFirstSubmit capture=${cold.id} session=$session generation=$generation " +
        "revision=$requestedRevision sequence=$sequence followEpoch=$ownershipEpoch")
    }
    val resumeStepMs = if (resumePending) periodNs / 1e6 else 0.0
    resumePending = false
    o.draw((frameNs + periodNs) / 1e6, resumeStepMs) { r -> onFrame(r, epoch, requestedRevision, resumeStepMs) }
    repost()
  }

  private fun repost() {
    if (!callbackPosted && attached) { callbackPosted = true; Choreographer.getInstance().postFrameCallback(this) }
  }

  private fun onFrame(r: FrameResult, epoch: Long, requestedRevision: Long, resumeStepMs: Double) {
    if (session != epoch) return
    busy = false
    coldFactorTrial?.let { trial ->
      if (!trial.firstPresent) {
        if (trial.attempts == 1) logColdFactorSnapshot("result", requestedRevision, r)
        if (System.nanoTime() >= trial.deadlineNs) {
          logColdFactorSnapshot("timeout", requestedRevision, r)
          coldFactorTrial = null
        } else if (r.status == 0) {
          logColdFactorSnapshot("present", requestedRevision, r)
          trial.firstPresent = true
        }
      }
    }
    val burst = pixelBurst
    if (burst != null) recordPixelBurstPresent(burst, r)
    coldFirstPixel?.let { cold ->
      if (r.status == 0) {
        if (r.generation != generation || !coldFirstRequestCurrent(cold.request)) rejectColdFirst(3)
        else if (!pixelReady(cold.dir)) rejectColdFirst(5)
      } else if (r.status <= 1) rejectColdFirst(5)
    }
    if (burst == null && r.status == 0 && pixelHoldUntilNs == 0L) pixelCaptureDir?.let { dir ->
      if (pixelReady(dir)) {
        pixelHoldUntilNs = System.nanoTime() + 10_000_000_000L
        logRustDiag("pixelDiag.hold capture=$pixelCaptureId frame=1 session=$session generation=${r.generation} " +
          "revisionCurrent=${frameRevision == requestedRevision && r.generation == generation}")
        // A TextureView listener may run before RenderThread latches the buffer timestamp.
        // Post outside the draw callback and let this hold protect the first buffer until the latch.
        awaitPixelBitmap(dir, r.generation)
      } else {
        pixelCaptureDir = null
      }
    }
    if (r.status == 0) presentCalls++
    if (r.status == 2) noDrawable++
    if (r.status == 3) dirty = true
    if (frameRevision != requestedRevision || r.generation != generation) { lifecycle(); return }
    animating = r.animating
    if (r.status != 0 && resumeStepMs > 0) resumePending = true
    when (r.status) {
      3 -> {}
      2 -> scheduleRetry(requestedRevision, epoch)
      1 -> retryBlocked = true
      0 -> {
        nextCueNativeMs = r.nextCueMs
        retryCount = 0
        if (surfaceWaiting || displayedGeneration != r.generation) {
          surfaceWaiting = false; displayedGeneration = r.generation
          onStatus(mapOf("state" to "presented", "generation" to r.generation, "message" to "Rust submitted a present call for the current track"))
        }
      }
    }
    lifecycle()
  }

  private fun markDirty() {
    if (coldFirstPixel != null && pixelHoldUntilNs != 0L) rejectColdFirst(3)
    cancelCue(); nextCueNativeMs = -1.0
    dirty = true; frameRevision++; retryCount = 0; retryBlocked = false; cancelRetry()
  }

  private fun scheduleRetry(revision: Long, epoch: Long) {
    dirty = true
    if (retryCount >= retryDelays.size) {
      rejectColdFirst(5)
      abortPixelBurst(PixelBurstFailure.DrawableRetries)
      retryBlocked = true; surfaceWaiting = true; updatePresentationVisibility()
      onStatus(mapOf("state" to "waiting", "generation" to generation,
        "message" to "Rust surface unavailable after bounded retries. Resume, seek, resize or recreate to retry."))
      return
    }
    val delay = retryDelays[retryCount++]
    val work = object : Runnable {
      override fun run() {
        if (session != epoch || frameRevision != revision || !attached || !foreground || !enabled || failed) return
        retryWork = null; lifecycle()
      }
    }
    retryWork = work
    main.postDelayed(work, delay)
  }
}
