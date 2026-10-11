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
changelog=$(node scripts/release-notes.cjs "${version}")
notes_file=$(mktemp)
license_dir=$(mktemp -d)
trap 'rm -f "${notes_file}"; rm -rf "${license_dir}"' EXIT
cp LICENSE "${license_dir}/KineSync-Desktop-LICENSE.txt"
cp ExpoLyrics/LICENSE "${license_dir}/KineSync-Mobile-LICENSE.txt"
{
  printf '# KineSync distribution notices\n\nSource and component notices: https://github.com/%s/tree/%s\n\n' "${GITHUB_REPOSITORY}" "${GITHUB_SHA}"
  cat THIRD_PARTY_NOTICES.md ExpoLyrics/THIRD_PARTY_NOTICES.md
} > "${license_dir}/KineSync-THIRD-PARTY-NOTICES.md"

cat > "${notes_file}" <<EOF
## Changelog

${changelog}

## Artifacts

- \`KineSync-Android.apk\`: Signed Android app.
- \`KineSync-iOS-unsigned.ipa\`: Unsigned iOS app.
- \`KineSync-Desktop-Windows-Setup.exe\`: Windows Desktop Bridge installer.
- \`kinesync-docker-setup.zip\`: Docker Desktop Bridge setup.
- Native runtime files: Windows source installation support.
- License texts and third-party notices: accompany the downloads; source is available at https://github.com/${GITHUB_REPOSITORY}/tree/${GITHUB_SHA}.
EOF

if gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${release_tag}" >/dev/null 2>&1; then
  tag_sha=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${release_tag}" --jq '.sha')
  if [[ "${tag_sha}" != "${GITHUB_SHA}" ]]; then
    echo "${release_tag} already belongs to ${tag_sha}; bump the version instead of replacing a published tag." >&2
    exit 1
  fi
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/git/refs" \
    -f ref="refs/tags/${release_tag}" -f sha="${GITHUB_SHA}" >/dev/null || {
      # Another platform publisher may create the tag concurrently. Verify its
      # commit rather than treating every create failure as a safe retry.
      tag_sha=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${release_tag}" --jq '.sha')
      if [[ "${tag_sha}" != "${GITHUB_SHA}" ]]; then
        echo "Concurrent release tag points to a different commit." >&2
        exit 1
      fi
    }
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

gh release upload "${release_tag}" "$@" "${license_dir}"/* --clobber

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
  "KineSync-Desktop-LICENSE.txt"
  "KineSync-Mobile-LICENSE.txt"
  "KineSync-THIRD-PARTY-NOTICES.md"
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
