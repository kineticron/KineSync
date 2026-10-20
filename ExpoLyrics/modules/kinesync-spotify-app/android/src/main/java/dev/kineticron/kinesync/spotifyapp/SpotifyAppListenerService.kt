package dev.kineticron.kinesync.spotifyapp

import android.service.notification.NotificationListenerService

/**
 * Exists only so the user can grant KineSync notification access, which
 * Android requires before MediaSessionManager.getActiveSessions() returns
 * other apps' media sessions. Notifications are not read.
 */
class SpotifyAppListenerService : NotificationListenerService()
