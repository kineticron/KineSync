# Following the Spotify app (Android)

Mobile-Only playback can follow either the built-in Spotify web player or the
Spotify app itself. Choose it in **Settings → Mobile-Only → Spotify app**.

## How it works

- `modules/kinesync-spotify-app` reads the Spotify app's media session through
  Android's `MediaSessionManager` (title, artist, album, duration, position,
  play state, and the Spotify track ID when Spotify exposes it) and sends
  play/pause/skip/seek back to it. Android only shares other apps' media
  sessions with apps that have **notification access**. KineSync's listener
  service exists for that grant and does not read notifications.
- `lib/spotify-app.ts` turns those updates into the same `PlaybackPacket`s the
  web player produces, so lyrics, timing, artwork and the player UI are shared.
  Without a Spotify ID, it resolves the catalog identity from title/artist
  first, exactly like the web-player source.
- Spicy Lyrics needs the Spotify track ID. Spotify usually puts it in the
  media session. When it does not, the catalog lookup finds it, which needs a
  Spotify web token. Instead of keeping the web player running,
  `SpotifyAppTracker` opens a hidden Spotify page only to check the sign-in and
  refresh that token, then closes it. Signing in is optional. Without it, the
  other lyric sources still work.

## Checks

```bash
npm run test:spotify-app
```
