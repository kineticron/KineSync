package dev.kineticron.kinesync.spotifyapp

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Follows the Spotify app's own playback through Android's media-session API,
 * so KineSync does not need to run the Spotify web player to know what is
 * playing. Requires notification access (see [SpotifyAppListenerService]).
 */
class KineSyncSpotifyAppModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private var sessionManager: MediaSessionManager? = null
  private var controller: MediaController? = null
  private var watching = false

  private val context: Context?
    get() = try {
      appContext.reactContext?.applicationContext
    } catch (_: Exception) {
      null
    }

  private val listenerComponent: ComponentName?
    get() = context?.let { ComponentName(it, SpotifyAppListenerService::class.java) }

  private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
    attach(pickSpotify(controllers))
  }

  private val controllerCallback = object : MediaController.Callback() {
    override fun onMetadataChanged(metadata: MediaMetadata?) = emit()

    override fun onPlaybackStateChanged(state: PlaybackState?) = emit()

    override fun onSessionDestroyed() {
      attach(null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("KineSyncSpotifyApp")

    Events(EVENT_PLAYBACK)

    Function("hasNotificationAccess") {
      hasNotificationAccess()
    }

    Function("openNotificationAccessSettings") {
      openNotificationAccessSettings()
    }

    // Returns false when notification access has not been granted yet.
    Function("startWatching") {
      handler.post { startWatching() }
      hasNotificationAccess()
    }

    Function("stopWatching") {
      handler.post { stopWatching() }
    }

    Function("getPlayback") {
      snapshot()
    }

    Function("sendCommand") { command: String, positionMs: Double? ->
      val controls = controller?.transportControls ?: return@Function false
      when (command) {
        "play" -> controls.play()
        "pause" -> controls.pause()
        "toggle" -> if (controller?.playbackState?.state == PlaybackState.STATE_PLAYING) controls.pause() else controls.play()
        "next" -> controls.skipToNext()
        "previous" -> controls.skipToPrevious()
        "seek" -> controls.seekTo((positionMs ?: 0.0).toLong().coerceAtLeast(0L))
        else -> return@Function false
      }
      true
    }

    OnDestroy {
      handler.post { stopWatching() }
    }
  }

  private fun hasNotificationAccess(): Boolean {
    val ctx = context ?: return false
    val enabled = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
    val component = listenerComponent ?: return false
    return enabled.split(':').any { ComponentName.unflattenFromString(it) == component }
  }

  private fun openNotificationAccessSettings() {
    val ctx = context ?: return
    val component = listenerComponent
    val detail = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && component != null) {
      Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
        .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString())
    } else {
      null
    }
    val list = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    for (intent in listOfNotNull(detail, list)) {
      try {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return
      } catch (_: ActivityNotFoundException) {
        // Some devices lack the per-app screen; fall back to the list.
      }
    }
  }

  private fun startWatching() {
    val ctx = context ?: return
    val component = listenerComponent ?: return
    if (!hasNotificationAccess()) {
      emit()
      return
    }
    val manager = sessionManager ?: (ctx.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager)
      ?: return
    sessionManager = manager
    try {
      if (!watching) {
        manager.addOnActiveSessionsChangedListener(sessionsListener, component, handler)
        watching = true
      }
      attach(pickSpotify(manager.getActiveSessions(component)))
    } catch (error: SecurityException) {
      // Access was revoked between the check and the call.
      Log.w(TAG, "Notification access is required to follow Spotify", error)
      watching = false
      attach(null)
    }
  }

  private fun stopWatching() {
    if (watching) {
      try {
        sessionManager?.removeOnActiveSessionsChangedListener(sessionsListener)
      } catch (_: Exception) {
      }
    }
    watching = false
    controller?.unregisterCallback(controllerCallback)
    controller = null
  }

  private fun pickSpotify(controllers: List<MediaController>?): MediaController? =
    controllers?.firstOrNull { it.packageName in SPOTIFY_PACKAGES }

  private fun attach(next: MediaController?) {
    val current = controller
    if (current?.sessionToken == next?.sessionToken && current != null) {
      emit()
      return
    }
    current?.unregisterCallback(controllerCallback)
    controller = next
    next?.registerCallback(controllerCallback, handler)
    emit()
  }

  private fun emit() {
    sendEvent(EVENT_PLAYBACK, snapshot() ?: mapOf("active" to false, "hasAccess" to hasNotificationAccess()))
  }

  private fun snapshot(): Map<String, Any?>? {
    val current = controller ?: return null
    val metadata = current.metadata ?: return null
    val title = metadata.getString(MediaMetadata.METADATA_KEY_TITLE)
      ?: metadata.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
      ?: return null
    val state = current.playbackState
    val isPlaying = state?.state == PlaybackState.STATE_PLAYING
    val speed = state?.playbackSpeed?.takeIf { it > 0f } ?: 1f
    var position = state?.position?.coerceAtLeast(0L) ?: 0L
    val updatedAt = state?.lastPositionUpdateTime ?: 0L
    if (isPlaying && updatedAt > 0L) {
      position += ((SystemClock.elapsedRealtime() - updatedAt).coerceAtLeast(0L) * speed).toLong()
    }
    val duration = metadata.getLong(MediaMetadata.METADATA_KEY_DURATION).coerceAtLeast(0L)
    if (duration > 0L) position = position.coerceAtMost(duration)
    return mapOf(
      "active" to true,
      "hasAccess" to true,
      "title" to title,
      "artist" to (metadata.getString(MediaMetadata.METADATA_KEY_ARTIST)
        ?: metadata.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
        ?: ""),
      "album" to (metadata.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: ""),
      "durationMs" to duration.toDouble(),
      "positionMs" to position.toDouble(),
      "isPlaying" to isPlaying,
      "playbackSpeed" to speed.toDouble(),
      "spotifyTrackId" to findSpotifyTrackId(metadata),
      "artworkUrl" to findWebArtwork(metadata),
      "sampledAtMs" to System.currentTimeMillis().toDouble(),
    )
  }

  private var idTrackKey = ""
  private var idValue = ""

  /** Spotify may expose its track URI in the media id or URI fields. */
  private fun findSpotifyTrackId(metadata: MediaMetadata): String {
    // Scanning reads every key as text (non-text keys log a warning), and
    // getMetadata() returns a new object each call, so scan once per track.
    val trackKey = listOf(
      metadata.getString(MediaMetadata.METADATA_KEY_TITLE),
      metadata.getString(MediaMetadata.METADATA_KEY_ARTIST),
      metadata.getLong(MediaMetadata.METADATA_KEY_DURATION),
    ).joinToString("\u0000")
    if (trackKey == idTrackKey) return idValue
    idTrackKey = trackKey
    idValue = scanSpotifyTrackId(metadata)
    return idValue
  }

  private fun scanSpotifyTrackId(metadata: MediaMetadata): String {
    for (key in metadata.keySet()) {
      val value = try {
        metadata.getString(key)
      } catch (_: Exception) {
        null
      } ?: continue
      SPOTIFY_TRACK_ID.find(value)?.let { return it.groupValues[1] }
    }
    return ""
  }

  private fun findWebArtwork(metadata: MediaMetadata): String {
    for (key in ARTWORK_KEYS) {
      val value = metadata.getString(key) ?: continue
      if (value.startsWith("https://") || value.startsWith("http://")) return value
    }
    return ""
  }

  private companion object {
    const val TAG = "KineSyncSpotifyApp"
    const val EVENT_PLAYBACK = "onPlayback"
    val SPOTIFY_PACKAGES = setOf("com.spotify.music", "com.spotify.lite")
    val SPOTIFY_TRACK_ID = Regex("""(?:spotify:track:|open\.spotify\.com/track/)([A-Za-z0-9]{22})""")
    val ARTWORK_KEYS = listOf(
      MediaMetadata.METADATA_KEY_ALBUM_ART_URI,
      MediaMetadata.METADATA_KEY_ART_URI,
      MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI,
    )
  }
}
