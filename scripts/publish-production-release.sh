#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Pass at least one release asset." >&2
  exit 1
fi

head_sha=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')
if [[ "${head_sha}" != "${GITHUB_SHA}" ]]; then
  echo "Skipping release publish because main is now ${head_sha}."
  exit 0
fi

version=$(node scripts/release-version.js)

release_tag="v${version}"
commit_message=$(git log -1 --pretty=%s)
changelog="${commit_message}"
if [[ "${version}" == "1.1.0" ]]; then
  changelog=$(cat <<'CHANGELOG'
### UI rehaul

This release brings a UI rehaul with a refreshed player, simpler setup, and more ways to manage your lyrics.

- Updated the player, menus, settings, and empty screens with a cleaner layout and new animations.
- Added a guided player tour with sample lyrics to try the controls before you start listening.
- Improved fullscreen and landscape layouts, with controls that can hide to give lyrics more room.
- Improved lyric scrolling, word highlighting, duet spacing, and text display across languages.
- Added a Local Vault screen to browse saved lyrics, import and export TTML files, and copy lyrics from the Desktop Bridge.
- Added a searchable language picker for lyric translations.
- Added iOS Live Activities to show lyrics on the Lock Screen and Dynamic Island.
- Improved startup transitions, artwork loading, and playback timing.
- Fixed the Docker image build so the setup bundle can be included in the release.
CHANGELOG
  )
elif [[ "${version}" == "1.1.1" ]]
then
  changelog=$(cat <<'CHANGELOG'
- Fixed Android Mobile Only mode so Spotify connects without first playing a song in the browser.
- Song changes from other devices now update the player and lyrics while the Spotify browser is closed.
- Improved player startup and connection recovery.
CHANGELOG
  )
elif [[ "${version}" == "1.1.2" ]]
then
  changelog=$(cat <<'CHANGELOG'
- Fixed Live Activities that started successfully but displayed an empty Dynamic Island or Lock Screen surface.
- Shared the native lyrics activity data type between the app and widget while preserving Expo module linking.
- Added native simulator previews to iOS release builds and tightened IPA checks to reject the previous type mismatch.
CHANGELOG
  )
elif [[ "${version}" == "1.1.3" ]]
then
  changelog="Fix TTML incorrectly parsing background lyrics."
elif [[ "${version}" == "1.1.4" ]]
then
  changelog="Added album art and app branding, fixed source clipping, and removed Live Activity lyrics."
elif [[ "${version}" == "1.1.5" ]]
then
  changelog="Removed Live Activity checks from iOS CI."
fi
notes_file=$(mktemp)
trap 'rm -f "${notes_file}"' EXIT

cat > "${notes_file}" <<EOF
## Changelog

${changelog}

## Artifacts

- \`KineSync-Android.apk\`: Signed Android app.
- \`KineSync-iOS-unsigned.ipa\`: Unsigned iOS app.
- \`KineSync-Desktop-Windows-Setup.exe\`: Windows Desktop Bridge installer.
- \`kinesync-docker-setup.zip\`: Docker Desktop Bridge setup.
- Native runtime files: Windows source installation support.
EOF

if gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${release_tag}" >/dev/null 2>&1; then
  gh api --method PATCH \
    "repos/${GITHUB_REPOSITORY}/git/refs/tags/${release_tag}" \
    -f sha="${GITHUB_SHA}" -F force=true >/dev/null
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/git/refs" \
    -f ref="refs/tags/${release_tag}" -f sha="${GITHUB_SHA}" >/dev/null || \
    gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${release_tag}" >/dev/null
fi

if ! gh release view "${release_tag}" >/dev/null 2>&1; then
  gh release create "${release_tag}" \
    --verify-tag \
    --title "${release_tag}" \
    --notes-file "${notes_file}" \
    --draft || gh release view "${release_tag}" >/dev/null
fi

gh release edit "${release_tag}" \
  --title "${release_tag}" \
  --notes-file "${notes_file}" \
  --prerelease=false

gh release upload "${release_tag}" "$@" --clobber

required_assets=(
  "KineSync-Android.apk"
  "KineSync-Android.apk.sha256"
  "KineSync-iOS-unsigned.ipa"
  "KineSync-iOS-unsigned.sha256"
  "sidestore-source.json"
  "KineSync-Desktop-Windows-Setup.exe"
  "KineSync-Desktop-Windows-Setup.exe.sha256"
  "kinesync-docker-setup.zip"
  "kinesync-docker-setup.zip.sha256"
  "windows_media_session.node"
  "spotify-seek-helper.dll"
  "spotify-seek-helper.runtimeconfig.json"
  "Microsoft.Windows.SDK.NET.dll"
  "WinRT.Runtime.dll"
  "native-assets-v${version}.json"
)
ready=false
for attempt in 1 2 3; do
  mapfile -t published_assets < <(
    gh release view "${release_tag}" --json assets --jq '.assets[].name'
  )
  ready=true
  for asset in "${required_assets[@]}"; do
    if ! printf '%s\n' "${published_assets[@]}" | grep -Fxq "${asset}"; then
      ready=false
      break
    fi
  done
  if [[ "${ready}" == "true" ]]; then
    break
  fi
  if [[ "${attempt}" -lt 3 ]]; then
    sleep 2
  fi
done

if [[ "${ready}" == "true" ]]; then
  gh release edit "${release_tag}" \
    --draft=false \
    --prerelease=false \
    --latest
  echo "Published ${release_tag}."
else
  echo "Uploaded assets to ${release_tag}. Waiting for the other builds."
fi
