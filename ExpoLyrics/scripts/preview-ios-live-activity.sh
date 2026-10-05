#!/bin/bash
# Run on macOS after Expo prebuild. Produces a simulator screenshot and logs;
# this is a visual diagnostic, not a claim of physical-device rendering success.
set -euo pipefail
cd "$(dirname "$0")/.."
output="$PWD/.expo/live-activity-preview"
mkdir -p "$output"
project=$(find "$PWD/ios" -maxdepth 1 -name '*.xcodeproj' -print -quit)
arch=$(uname -m)
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)

xcodebuild -project "$project" -target KineSyncLyricsWidget \
  -configuration Release -sdk iphonesimulator \
  ARCHS="$arch" ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
  SYMROOT="$output/products" OBJROOT="$output/objects" \
  > "$output/build.log" 2>&1

app="$output/KineSyncPreview.app"
mkdir -p "$app/PlugIns"
ditto "$output/products/Release-iphonesimulator/KineSyncLyricsWidget.appex" \
  "$app/PlugIns/KineSyncLyricsWidget.appex"
xcrun --sdk iphonesimulator swiftc -parse-as-library -O \
  -target "$arch-apple-ios16.4-simulator" -sdk "$sdk" \
  -module-name KineSyncLiveActivity \
  modules/kinesync-live-activity/ios/LyricsActivityAttributes.swift \
  scripts/live-activity-preview/PreviewApp.swift -o "$app/KineSyncPreview"

python3 - "$app" <<'PY'
import plistlib, sys
from pathlib import Path
app = Path(sys.argv[1])
widget = plistlib.loads((app / 'PlugIns/KineSyncLyricsWidget.appex/Info.plist').read_bytes())
host = {
    'CFBundleExecutable': 'KineSyncPreview', 'CFBundleName': 'KineSync Preview',
    'CFBundleIdentifier': widget['CFBundleIdentifier'].rsplit('.', 1)[0],
    'CFBundlePackageType': 'APPL', 'CFBundleVersion': widget['CFBundleVersion'],
    'CFBundleShortVersionString': widget['CFBundleShortVersionString'],
    'CFBundleSupportedPlatforms': ['iPhoneSimulator'], 'MinimumOSVersion': '16.4',
    'NSSupportsLiveActivities': True, 'UIDeviceFamily': [1], 'UILaunchScreen': {},
}
(app / 'Info.plist').write_bytes(plistlib.dumps(host))
PY
codesign --force --sign - "$app/PlugIns/KineSyncLyricsWidget.appex"
codesign --force --sign - "$app"
bundle=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
xcrun simctl list devices available -j > "$output/devices.json"
device=$(python3 - "$output/devices.json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))['devices']
for runtime in sorted(devices, reverse=True):
    for device in devices[runtime]:
        if 'iOS' in runtime and 'iPhone' in device['name'] and 'Pro' in device['name'] and device['isAvailable']:
            print(device['udid'])
            sys.exit(0)
raise SystemExit('No Dynamic Island iPhone simulator available')
PY
)
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app"
xcrun simctl spawn "$device" log stream --level info --style compact \
  --predicate 'subsystem == "dev.kineticron.KineSync.live-activity"' > "$output/runtime.log" 2>&1 &
log_pid=$!
trap 'kill "$log_pid" 2>/dev/null || true' EXIT
xcrun simctl launch "$device" "$bundle"
sleep 5
# Another app exposes the compact Island, as it would appear during playback.
xcrun simctl launch "$device" com.apple.Preferences
sleep 5
xcrun simctl io "$device" screenshot "$output/compact-island.png"
printf 'Preview device: %s\nHost module: KineSyncLiveActivity\n' "$device" > "$output/preview.txt"
