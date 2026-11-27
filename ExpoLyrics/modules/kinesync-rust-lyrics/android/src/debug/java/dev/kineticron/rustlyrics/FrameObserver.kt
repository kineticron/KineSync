package dev.kineticron.rustlyrics

import android.view.View
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.views.ViewDefinitionBuilder
import expo.modules.kotlin.viewevent.ViewEvent

internal class FrameObserver(view: View) {
  private val onMetrics = ViewEvent<Map<String, Any?>>("onMetrics", view, null)

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

  fun start(hz: Double) {
    requestedHz = hz
    windowStart = RustBridge.nowMs() / 1000
    windowCallbacks = callbacks; windowPresent = presentCalls; windowBusy = busyCallbacks; windowMissed = missedEstimate
  }

  fun reset() { previousFrameNs = 0; previousStepNs = 0 }
  fun finishTick(start: Long) { tickMs = (System.nanoTime() - start) / 1e6 }
  fun callback() { callbacks++ }
  fun inactive() { inactive++ }
  fun busy() { busyCallbacks++ }
  fun idle() { idle++ }
  fun submit() { submitted++ }

  fun result(status: Int) {
    if (status == 0) presentCalls++
    if (status == 2) noDrawable++
  }

  fun interval(frameNs: Long, periodNs: Long) {
    if (previousFrameNs > 0) {
      val gap = frameNs - previousFrameNs
      intervalMs = gap / 1e6
      if (previousStepNs > 0) missedEstimate += maxOf(0.0, Math.rint(gap.toDouble() / previousStepNs) - 1).toLong()
    }
    previousFrameNs = frameNs
    previousStepNs = periodNs
  }

  fun emit(event: Map<String, Any?>) {
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
  }
}


internal fun ViewDefinitionBuilder<KineSyncRustLyricsView>.registerEvents() {
  Events("onStatus", "onMetrics")
  AsyncFunction("copyLayout") { view: KineSyncRustLyricsView, promise: Promise ->
    val owner = view.owner
    if (owner == null) {
      promise.reject("ERR_RUST_LAYOUT", "Rust owner unavailable", null)
    } else {
      owner.readOnWorker(FrameSample()::copyLayout) { bytes ->
        val receipt = bytes?.toString(Charsets.UTF_8)
        if (receipt.isNullOrEmpty()) promise.reject("ERR_RUST_LAYOUT", "No prepared Rust layout receipt", null)
        else promise.resolve(receipt)
      }
    }
  }.runOnQueue(Queues.MAIN)
}
