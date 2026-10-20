# Share lyrics

The share button sits with the player's bottom buttons (next to auto-scroll
and translate, and in the full-screen album view next to settings). It opens
the share screen on the line playing now.

- **Pick lines**: tap the first and the last line you want (four lines are
  picked to start). Translations are included when they are shown.
- **Picture**: a 1080-wide PNG with the blurred cover, the cover, title and
  artist at the top, the picked lines right under them, and the KineSync
  logo at the bottom left. The card is only as tall as its lyrics (up to
  9:16), so there is no empty space. Long picks shrink to fit.
- **Video** (Android and iOS): a silent 720-wide, 30 fps MP4 with the same
  layout. Every picked line stays on screen the whole time. With "Animated
  words" on (the default), each word moves like the player's Spicy lyrics:
  it lifts, grows and glows as it is sung, and held words wave letter by
  letter. Off, words fill with a plain highlight. Finished lines stay half
  lit, so the highlight moves down the card (line-synced lyrics light a whole
  line at once). Up to 60 seconds.

Both go out through the system share sheet.

## How the video is made

Every frame is drawn on its own at its exact song time
(`lib/share/share-timeline.ts` makes the motion a pure function of time) by
the same Skia code that draws the preview and the picture
(`components/share/share-card.ts`). Frames are read back as RGBA and passed
to `modules/kinesync-video-encoder`: on Android it converts them to YUV and
encodes H.264 with MediaCodec into an MP4 (MediaMuxer). On iOS it hands BGRA
frames to AVAssetWriter. Animated words use the player's own Spicy word
springs (`reference-word-motion.ts`) and glyph drawing
(`native-glyph-picture.tsx`), stepped by exactly 1/30 s per frame. Nothing is
recorded from the screen, so a slow phone takes longer but never drops or
stutters a frame. Making the video can be cancelled at any time.
