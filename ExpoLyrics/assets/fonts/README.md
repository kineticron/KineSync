# Lyrics fonts

SF Pro Display Regular and Bold are carried over unchanged from the repository's
`skia-lyrics` branch. Both native lyric renderers register these faces under
`SF Pro Display` with Skia; experimental React Native text uses the same files
through `expo-font`. System fallback still supplies glyphs outside these faces.

Fonts load at runtime from Metro assets, so the existing development build can
load them without adding a native module or rebuilding the client.
