# UI and motion

The player retains its artwork-driven layout. Shared chrome now uses a dark navy surface, mint actions, consistent rounded cards, clearer field focus, and larger touch targets. Onboarding pages scroll vertically on smaller phones and retain their selected page on rotation. The idle player offers a direct connection or Spotify action.

## Launch

`components/ui/launch-transition.tsx` holds the native splash until the local settings check, root layout, and logo are ready. The existing logo gives a small tilt and bounce, sends out a ring, then lifts away while the app appears over 1.05 seconds. It runs once per mounted app session, never on navigation or foregrounding. It does not wait for the bridge or Spotify to connect. Image decode failure has a fallback, and failed settings restoration opens setup instead of leaving the splash visible.

The native splash configuration in `app.json` uses the same navy background and 112-point logo. Regenerate native projects and rebuild to see that change. Expo Go and development builds do not fully reproduce the final native splash; validate the handoff in a release build. See [Expo's splash screen guidance](https://docs.expo.dev/versions/latest/sdk/splash-screen/).

## Performance and accessibility

- Launch and press effects use Reanimated transforms and opacity, without per-frame React updates or new packages.
- Launch overlays are removed after completion. Animations and the image fallback timer are cleaned up on unmount.
- System Reduce Motion skips the launch choreography and new screen entrances, disables the added press scaling, and stops the player's decorative ambient motion.
- Ambient loops also stop while artwork covers them, the screen loses focus, or the app backgrounds.
- Playback controls retain their gestures and long presses, with gentler springs and best-effort haptics.
- Setup hides the underlying navigator from accessibility, and inactive onboarding pages are hidden from screen readers. Inputs and playback controls have accessible labels.

## Validation

Checked TypeScript, lint, Android/iOS Hermes and web exports, and the existing artwork, mobile security, and Live Activity regression scripts. Browser checks cover initial launch, onboarding progression and scrolling at 320×568, 390×844 portrait, settings navigation, and 844×390 landscape. Native haptics, the OS splash handoff, and frame pacing still need a physical device/release build check; browser previews cannot verify those.
