package dev.kineticron.rustlyrics

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KineSyncRustLyricsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KineSyncRustLyrics")
    Function("abiVersion") { RustBridge.abiVersion() }
    Function("monotonicMs") { RustBridge.nowMs() }
    View(KineSyncRustLyricsView::class) {
      Events("onStatus", "onMetrics")
      Prop("trackJson") { view: KineSyncRustLyricsView, value: String -> view.setTrack(value) }
      Prop("active") { view: KineSyncRustLyricsView, value: Boolean -> view.setActive(value) }
      AsyncFunction("copyLayout") { view: KineSyncRustLyricsView, promise: Promise -> view.copyLayout(promise) }.runOnQueue(Queues.MAIN)
      AsyncFunction("setAnchor") { view: KineSyncRustLyricsView, value: String -> view.setAnchor(value) }.runOnQueue(Queues.MAIN)
      AsyncFunction("setFollowing") { view: KineSyncRustLyricsView, value: Boolean -> view.setFollowing(value) }.runOnQueue(Queues.MAIN)
      AsyncFunction("scrollBy") { view: KineSyncRustLyricsView, dy: Double -> view.scrollBy(dy) }.runOnQueue(Queues.MAIN)
      AsyncFunction("fling") { view: KineSyncRustLyricsView, velocity: Double -> view.fling(velocity) }.runOnQueue(Queues.MAIN)
      AsyncFunction("hitTest") { view: KineSyncRustLyricsView, x: Double, y: Double, promise: Promise -> view.hitTest(x, y, promise) }.runOnQueue(Queues.MAIN)
    }
  }
}
