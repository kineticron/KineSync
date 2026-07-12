# Lyrics fonts (San Francisco Pro)

The lyrics renderer works out of the box using each platform's native San
Francisco / Roboto. Bundle SF Pro here **only** if you want pixel-identical
lyrics across iOS *and* Android.

## Enable SF Pro (both platforms)

1. Download the faces into this folder (from your machine — CI/sandboxes often
   block raw.githubusercontent):

   ```sh
   cd ExpoLyrics/assets/fonts
   base=https://raw.githubusercontent.com/sahibjotsaggu/San-Francisco-Pro-Fonts/master
   curl -fLO $base/SF-Pro-Display-Regular.otf
   curl -fLO $base/SF-Pro-Display-Bold.otf
   ```

   (Or from Apple: https://developer.apple.com/fonts/ — "SF Pro".)

2. Uncomment the `require(...)` block in `sf-pro-sources.ts`.
3. Set `SF_PRO_ENABLED = true` in `constants/lyrics-typography.ts`.
4. In `app/_layout.tsx`, load the same faces on the RN side so the fallback
   `<Text>` matches (already wired behind `SF_PRO_ENABLED`).
5. Rebuild the native app (`npx expo run:ios` / `run:android`) — font assets
   are not picked up by a JS-only reload.

The lyrics use weight 700, so Regular + Bold is enough. Add more weights (Medium,
Semibold, …) to `sf-pro-sources.ts` only if you introduce other weights.
