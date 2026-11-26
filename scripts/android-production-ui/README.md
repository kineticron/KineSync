# Android production UI Robo script

`production-ui-robo.json` exercises the English release UI in portrait. Start on a fresh test installation or at the non-fullscreen player after setup. The first-run Skip and Skip player tour actions are optional.

The script selects the AMLL and Spicy Lyrics styles from the player menu, opens Settings, and selects Mobile-Only playback. It asserts that Mobile-Only is checked, expands Advanced, and scrolls to the Save mobile API settings button. The only Settings screenshot follows an assertion that this button is present. The script leaves the save button and the three masked credential fields untouched and returns to the player.

The Firebase execution header enables strict matching and ends the crawl when the script completes. The file consists of this header followed by the action array. Robo uses `ELEMENT_SCROLL_INTO_VIEW` to find the Settings action, Mobile-Only, Advanced, and Save mobile API settings inside their scroll views. The Settings button's accessible name can include icon glyphs. The other targets use exact accessible names. [Firebase Robo execution options](https://firebase.google.com/docs/test-lab/android/robo-scripts-reference#execution_options)

## Separate device smoke tests

The Robo script covers one session. Use a device with a configured playback source for these follow-up checks.

1. Force-stop and reopen the app on the same installation with its data intact. Start playback and confirm that timed lyrics appear in Rust. Switch between AMLL and Spicy and confirm that both styles render.
2. On a test installation of an older build, save Skia as the renderer and upgrade in place. Cold-launch the new build without clearing app data. Confirm that the Rust lyric surface appears when timed lyrics are ready and that changing the lyric style still uses Rust. Use Rust diagnostics on a development build to confirm renderer identity.
3. Rotate from portrait to landscape and back during playback. Then background the app with Home and resume it. Confirm that lyrics stay visible and current and that player controls respond after each transition.

The local script contract check is `node --test scripts/test/android-production-ui.test.cjs`. It checks the targets against app source. Scroll behavior and native accessibility matching require a device run.
