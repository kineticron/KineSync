# Android production UI Robo script

`production-ui-robo.json` is a single-session script for the English release UI in portrait. Start at a cold launch on a fresh installation or at the non-fullscreen player on an installation that has completed setup. The script allows the first-run Skip and Skip player tour actions to be absent. It requires the player menu, AMLL and Spicy style options, the Settings action, the Advanced section, both backend radio options, and the return to the player.

At the first missing-element event on both devices, the screenshots still show the player menu. The earlier exact-text tap on Settings had left that menu open, and the six coordinate swipes moved its content. Advanced is a button on the separate Settings screen with the explicit accessible name `Advanced`. The later `advanced-open.png` screenshots show that screen after navigation and expansion.

The script uses `ELEMENT_SCROLL_INTO_VIEW` for the Settings action, Advanced, Rust, and Skia. Each step selects the ScrollView as the container and the control as its child, followed by a required click on that same control. Robo searches forward for up to 50 scrolls. The Settings button's accessible name may include icon glyphs. The Advanced step uses the exact accessible name `Advanced`. The radio selectors match the backend name at the end of the description, as seen on the recorded Skia radio. The script visits Rust then Skia in their display order for the forward search, so Skia is the final selection it attempts. Native matching and scroll behavior remain unverified on device. [Firebase Robo script reference](https://firebase.google.com/docs/test-lab/android/robo-scripts-reference)

The script exercises two backend taps in one process. The screenshots capture the displayed UI for review. To check selection, inspect the checked radio and confirm that the renderer save warning is absent. Playback and renderer output require a configured source and a separate check.

## Separate device coverage

Cold relaunch, backend persistence, rotation, and background resume are unverified by this Robo phase. Use a separate local device pass when authorized.

1. On the same installation and Android user, select Skia and verify that its radio is checked. Finish the automation session. Force-stop and reopen KineSync externally while preserving its app data. Reopen Settings and confirm that Skia remains checked before tapping either option again.
2. Repeat with Rust. For automated follow-up, start a new independent inspection session on the same installation after each external restart and assert the native checked state before any selection action. A new run with cleared storage cannot establish persistence.
3. In an independent local pass, turn the screen to landscape and back to portrait, then background KineSync with Home and return to the existing app. Confirm the player is visible and interactive after each transition.

Robo owns the accessibility session. Use its built-in interactions during a run. The earlier shell hierarchy dumps collided with that session, and force-stop terminated it before later actions could execute.

The local script contract check is `node --test scripts/test/android-production-ui.test.cjs`. It checks source alignment and script scope. Device execution is needed to verify the scroll and selector behavior.
