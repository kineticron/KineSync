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
  // TextureView and frame callbacks report on the UI thread.
  private enum class Diag {
    INIT, ATTACH, DETACH, WINDOW, LAYOUT, SIZE, AVAILABLE, RESIZE, DESTROY, UPDATED, OWNER_CREATE,
    REFRESH_REJECT, REFRESH_NO_OWNER, REFRESH_UPDATE, PRESENTATION,
    DRAW_GATE, DRAW_BUSY, DRAW_REQUEST, DRAW_RESULT, DRAW_FAILURE, STATUS
  }
  private val diagCounts = IntArray(Diag.entries.size)
  private var diagUpdatedSession = -1L
  private var diagPresentationFlags = -1
  private var diagPresentationSession = -1L
  private var diagPresentationGeneration = -1L
  private var diagDisplayedGeneration = -2L

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
    diag(Diag.INIT) { "view.init" }
    clipChildren = true
    setBackgroundColor(Color.TRANSPARENT)
    textureView.isOpaque = false
    updatePresentationVisibility()
    textureView.surfaceTextureListener = this
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private inline fun diag(event: Diag, limit: Int = 8, st: SurfaceTexture? = texture, details: () -> String) {
    val index = event.ordinal
    if (diagCounts[index] >= limit) return
    diagCounts[index]++
    logRustDiag("view=${System.identityHashCode(this)} textureView=${System.identityHashCode(textureView)} " +
      "texture=${System.identityHashCode(st)} owner=${System.identityHashCode(owner)} " +
      "session=$session generation=$generation ${details()}")
  }

  private fun diagSurfaceState() = "available=${textureView.isAvailable} size=${width}x$height " +
    "textureSize=${textureView.width}x${textureView.height} ownerPresent=${owner != null} " +
    "attached=$attached foreground=$foreground enabled=$enabled failed=$failed surfaceWaiting=$surfaceWaiting"

  // React Native does not lay out natively added children; size the texture to this view.
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l; val h = b - t
    textureView.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    textureView.layout(0, 0, w, h)
    diag(Diag.LAYOUT) { "view.layout changed=$changed layout=${w}x$h ${diagSurfaceState()}" }
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
    diag(Diag.ATTACH) { "view.attach ${diagSurfaceState()}" }
    markDirty(); refresh(); lifecycle()
  }
  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    attached = false
    diag(Diag.DETACH) { "view.detach ${diagSurfaceState()}" }
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
    diag(Diag.WINDOW) { "view.windowVisibility visibility=$visibility ${diagSurfaceState()}" }
    if (foreground) { markDirty(); refresh() }
    lifecycle()
  }
  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    diag(Diag.SIZE) { "view.size old=${oldw}x$oldh new=${w}x$h ${diagSurfaceState()}" }
    markDirty(); refresh(); lifecycle()
  }

  // TextureView surface lifecycle. One owner per SurfaceTexture.
  override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
    texture = st
    session++
    diag(Diag.AVAILABLE, st = st) { "surface.available callbackSize=${w}x$h ${diagSurfaceState()}" }
    val epoch = session
    displayedGeneration = -1L
    failed = false; updatePresentationVisibility(); markDirty()
    diag(Diag.OWNER_CREATE, 16) { "view.owner create.enter" }
    owner = RustOwner(context, st) { event -> handleEvent(event, epoch) }
    diag(Diag.OWNER_CREATE, 16) { "view.owner create.exit" }
    refresh(); lifecycle()
  }
  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
    diag(Diag.RESIZE, st = st) { "surface.resize callbackSize=${w}x$h ${diagSurfaceState()}" }
    markDirty(); refresh(); lifecycle()
  }
  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    diag(Diag.DESTROY, st = st) { "surface.destroy ${diagSurfaceState()}" }
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
    if (diagUpdatedSession != session) {
      diagUpdatedSession = session
      diag(Diag.UPDATED, st = st) { "surface.firstUpdate ${diagSurfaceState()}" }
    }
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
        failed = true; updatePresentationVisibility()
        Choreographer.getInstance().removeFrameCallback(this); callbackPosted = false
      }
      if (event["state"] == "ready") { markDirty(); lifecycle() }
      diag(Diag.STATUS, 16) {
        val state = when (event["state"]) {
          "error" -> "error"
          "ready" -> "ready"
          else -> "other"
        }
        "view.status state=$state"
      }
      onStatus(event)
    }
  }

  fun setTrack(value: String) {
    if (value.length > 2_000_000) return
    val id = try { JSONObject(value).getLong("generation") } catch (_: Exception) { return }
    if (id <= generation) return
    val nextTrackId = try { JSONObject(value).getString("track_id") } catch (_: Exception) { return }
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
      diag(Diag.STATUS, 16) { "view.status state=error source=anchorValidation" }
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
    diag(Diag.STATUS, 16) { "view.status state=follow" }
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
    if (!attached || !foreground || !enabled || failed) {
      diag(Diag.REFRESH_REJECT) { "view.refresh rejected=lifecycle ${diagSurfaceState()}" }
      return
    }
    val o = owner ?: run {
      diag(Diag.REFRESH_NO_OWNER) { "view.refresh rejected=noOwner ${diagSurfaceState()}" }
      return
    }
    val d = density
    diag(Diag.REFRESH_UPDATE) { "view.refresh ownerUpdate size=${width}x$height trackChars=${track.length}" }
    o.update(track, generation, anchor, width, height, d)
    o.setFollowing(following)
  }

  // Alpha preserves the TextureView surface while inactive. Every presentation,
  // including a late worker completion, must pass the current lifecycle gate.
  private fun updatePresentationVisibility() {
    val presentable = attached && foreground && enabled && !failed && !surfaceWaiting &&
      owner != null && displayedGeneration == generation
    textureView.alpha = if (presentable) 1f else 0f
    if (diagCounts[Diag.PRESENTATION.ordinal] < 24) {
      var flags = 0
      if (textureView.isAvailable) flags = flags or 1
      if (owner != null) flags = flags or 2
      if (attached) flags = flags or 4
      if (foreground) flags = flags or 8
      if (enabled) flags = flags or 16
      if (failed) flags = flags or 32
      if (surfaceWaiting) flags = flags or 64
      if (flags != diagPresentationFlags || session != diagPresentationSession ||
        generation != diagPresentationGeneration || displayedGeneration != diagDisplayedGeneration) {
        diagPresentationFlags = flags
        diagPresentationSession = session
        diagPresentationGeneration = generation
        diagDisplayedGeneration = displayedGeneration
        diag(Diag.PRESENTATION, 24) {
          "view.presentation alpha=${textureView.alpha} presentable=$presentable " +
            "displayedGeneration=$displayedGeneration ${diagSurfaceState()}"
        }
      }
    }
  }

  private fun lifecycle() {
    updatePresentationVisibility()
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
    if (!attached || !foreground || !enabled || failed || retryBlocked || retryWork != null) {
      diag(Diag.DRAW_GATE) {
        "view.draw denied=lifecycle retryBlocked=$retryBlocked retryPending=${retryWork != null} ${diagSurfaceState()}"
      }
      inactive++; lifecycle(); return
    }
    if (previousFrameNs > 0) {
      val gap = frameNs - previousFrameNs
      intervalMs = gap / 1e6
      if (previousStepNs > 0) missedEstimate += maxOf(0.0, Math.rint(gap.toDouble() / previousStepNs) - 1).toLong()
    }
    previousFrameNs = frameNs
    val periodNs = (1e9 / (display?.refreshRate?.toDouble() ?: 60.0)).toLong()
    previousStepNs = periodNs
    // Keep the loop alive for the next vsync while work is pending.
    if (busy) {
      diag(Diag.DRAW_BUSY, 4) { "view.draw waitingForWorker submitted=$submitted callbacks=$callbacks" }
      busyCallbacks++; repost(); return
    }
    if (!dirty && !animating) { idle++; lifecycle(); return }
    val o = owner ?: run {
      diag(Diag.DRAW_GATE) { "view.draw denied=noOwner ${diagSurfaceState()}" }
      inactive++; return
    }
    busy = true; dirty = false; submitted++
    val epoch = session
    val requestedRevision = frameRevision
    val resumeStepMs = if (resumePending) periodNs / 1e6 else 0.0
    resumePending = false
    diag(Diag.DRAW_REQUEST) { "view.draw request=$submitted revision=$requestedRevision" }
    o.draw((frameNs + periodNs) / 1e6, resumeStepMs) { r -> onFrame(r, epoch, requestedRevision, resumeStepMs) }
    repost()
  }

  private fun repost() {
    if (!callbackPosted && attached) { callbackPosted = true; Choreographer.getInstance().postFrameCallback(this) }
  }

  private fun onFrame(r: FrameResult, epoch: Long, requestedRevision: Long, resumeStepMs: Double) {
    diag(if (r.status != 0) Diag.DRAW_FAILURE else Diag.DRAW_RESULT) {
      "view.draw result=${r.status} resultSession=$epoch resultGeneration=${r.generation} " +
        "requestedRevision=$requestedRevision currentRevision=$frameRevision"
    }
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
        if (surfaceWaiting || displayedGeneration != r.generation) {
          surfaceWaiting = false; displayedGeneration = r.generation
          diag(Diag.STATUS, 16) { "view.status state=presented" }
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
      retryBlocked = true; surfaceWaiting = true; updatePresentationVisibility()
      diag(Diag.STATUS, 16) { "view.status state=waiting retries=$retryCount" }
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
