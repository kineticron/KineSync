package dev.kineticron.rustlyrics

import android.content.Context
import android.graphics.Color
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
import org.json.JSONObject
import kotlin.math.ceil

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

  private var session = 0L
  private var generation = 0L
  private var sequence = 0L
  private var track = ""
  private var anchor: Anchor? = null
  private var enabled = true
  // Desired follow ownership, replayed when the owner is created or the track changes.
  private var following = true
  private var foreground = true
  private var attached = false
  private var busy = false
  private var dirty = true
  private var frameRevision = 0L
  private var retryCount = 0
  private var retryBlocked = false
  private var retryWork: Runnable? = null
  private var displayedGeneration = 0L
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
    textureView.alpha = 0f
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
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(ev)
        if (!dragging && kotlin.math.abs(ev.y - downY) > slop) {
          dragging = true; setFollowing(false)
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
        if (dragging) {
          velocity?.computeCurrentVelocity(1000, maxFling)
          fling(-(velocity?.yVelocity ?: 0f) / density.toDouble() / 1000.0)
        }
        velocity?.recycle(); velocity = null; dragging = false
      }
      MotionEvent.ACTION_CANCEL -> {
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
    attached = false
    velocity?.recycle(); velocity = null; dragging = false
    Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
    cancelRetry(); cancelCue()
    owner?.setVisible(false)
    busy = false; animating = false
  }
  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    foreground = visibility == VISIBLE
    if (foreground) { markDirty(); refresh() }
    lifecycle()
  }
  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    markDirty(); refresh(); lifecycle()
  }

  // TextureView surface lifecycle. One owner per SurfaceTexture.
  override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
    texture = st
    session++
    val epoch = session
    failed = false; textureView.alpha = 0f; markDirty()
    owner = RustOwner(context, st) { event -> handleEvent(event, epoch) }
    refresh(); lifecycle()
  }
  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) { markDirty(); refresh(); lifecycle() }
  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
    cancelRetry(); cancelCue()
    val o = owner
    if (o != null) { o.dispose(); owner = null } else st.release()
    texture = null
    session++; busy = false; animating = false
    // Owner releases the texture after kr_destroy, so the view must not.
    return false
  }
  override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}

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
        failed = true; textureView.alpha = 0f
        Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
      }
      if (event["state"] == "ready") { markDirty(); lifecycle() }
      onStatus(event)
    }
  }

  fun setTrack(value: String) {
    if (value.length > 2_000_000) return
    val id = try { JSONObject(value).getLong("generation") } catch (_: Exception) { return }
    if (id <= generation) return
    generation = id; sequence = 0; anchor = null; animating = false
    following = true
    failed = false; textureView.alpha = 0f
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
      failed = true; textureView.alpha = 0f; lifecycle()
      onStatus(mapOf("state" to "error", "generation" to generation, "message" to "Invalid Rust playback anchor"))
      return
    }
    if (next.generation != generation || next.sequence <= sequence) return
    sequence = next.sequence; anchor = next; markDirty()
    owner?.setAnchor(next)
    lifecycle()
  }
  fun setActive(value: Boolean) {
    enabled = value
    if (value) { markDirty(); refresh() }
    lifecycle()
  }
  fun setFollowing(value: Boolean) { following = value; owner?.setFollowing(value); markDirty(); lifecycle() }
  fun scrollBy(dy: Double) {
    if (!dy.isFinite() || dy == 0.0) return
    owner?.scrollBy(dy); markDirty(); lifecycle()
  }
  fun fling(v: Double) { if (!v.isFinite()) return; owner?.fling(v); markDirty(); lifecycle() }
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

  private fun lifecycle() {
    val visible = attached && foreground && enabled && !failed && width > 0 && height > 0 && owner != null
    owner?.setVisible(visible)
    if (!visible) { cancelRetry(); cancelCue(); resumePending = false }
    if (visible && retryWork == null && !retryBlocked && (dirty || animating)) {
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
    if (previousFrameNs > 0) {
      val gap = frameNs - previousFrameNs
      intervalMs = gap / 1e6
      if (previousStepNs > 0) missedEstimate += maxOf(0.0, Math.rint(gap.toDouble() / previousStepNs) - 1).toLong()
    }
    previousFrameNs = frameNs
    val periodNs = (1e9 / (display?.refreshRate?.toDouble() ?: 60.0)).toLong()
    previousStepNs = periodNs
    // Keep the loop alive for the next vsync while work is pending.
    if (busy) { busyCallbacks++; repost(); return }
    if (!dirty && !animating) { idle++; lifecycle(); return }
    val o = owner ?: run { inactive++; return }
    busy = true; dirty = false; submitted++
    val epoch = session
    val requestedRevision = frameRevision
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
        textureView.alpha = 1f
        if (surfaceWaiting || displayedGeneration != r.generation) {
          surfaceWaiting = false; displayedGeneration = r.generation
          onStatus(mapOf("state" to "presented", "generation" to r.generation, "message" to "Rust submitted a present call for the current track"))
        }
      }
    }
    lifecycle()
  }

  private fun markDirty() {
    cancelCue(); nextCueNativeMs = -1.0
    dirty = true; frameRevision++; retryCount = 0; retryBlocked = false; cancelRetry()
  }

  private fun scheduleRetry(revision: Long, epoch: Long) {
    dirty = true
    if (retryCount >= retryDelays.size) {
      retryBlocked = true; surfaceWaiting = true; textureView.alpha = 0f
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
