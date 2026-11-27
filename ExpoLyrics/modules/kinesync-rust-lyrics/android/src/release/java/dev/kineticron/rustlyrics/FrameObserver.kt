package dev.kineticron.rustlyrics

import android.view.View
import expo.modules.kotlin.views.ViewDefinitionBuilder

// Shared call sites are compiled out by the variant's constant BuildConfig.DEBUG.
@Suppress("UNUSED_PARAMETER")
internal class FrameObserver(view: View) {
  fun start(hz: Double) {}
  fun reset() {}
  fun finishTick(start: Long) {}
  fun callback() {}
  fun inactive() {}
  fun busy() {}
  fun idle() {}
  fun submit() {}
  fun result(status: Int) {}
  fun interval(frameNs: Long, periodNs: Long) {}
  fun emit(event: Map<String, Any?>) {}
}


internal fun ViewDefinitionBuilder<KineSyncRustLyricsView>.registerEvents() {
  Events("onStatus")
}
