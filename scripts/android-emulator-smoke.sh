#!/usr/bin/env bash
# Runs inside the emulator. Installs the development client, loads the dev-only
# smoke route from Metro and captures a screenshot plus logs into smoke-out/.
set -uxo pipefail
out="${PWD}/smoke-out"
mkdir -p "${out}"
adb wait-for-device
adb shell getprop ro.product.cpu.abi | tee "${out}/abi.txt"
adb shell 'dumpsys SurfaceFlinger | grep -i "GLES\|vulkan"' > "${out}/gpu.txt" || true
adb shell getprop ro.hardware.vulkan >> "${out}/gpu.txt" || true
adb install -r ExpoLyrics/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb logcat -c
(adb logcat -v time > "${out}/logcat.txt" &) 
adb shell am start -a android.intent.action.VIEW \
  -d 'expolyrics://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
# First bundle compile on a cold Metro cache is slow.
for i in $(seq 1 60); do
  if grep -q 'Running "main"\|ReactNativeJS' "${out}/logcat.txt"; then break; fi
  sleep 5
done
sleep 20
adb shell screencap -p /sdcard/launch.png && adb pull /sdcard/launch.png "${out}/launch.png"
adb shell am start -a android.intent.action.VIEW -d 'expolyrics://rust-android-smoke'
sleep 25
adb shell screencap -p /sdcard/smoke.png && adb pull /sdcard/smoke.png "${out}/smoke.png"
sleep 5
adb shell screencap -p /sdcard/smoke2.png && adb pull /sdcard/smoke2.png "${out}/smoke2.png"
adb shell dumpsys SurfaceFlinger --latency-clear >/dev/null 2>&1 || true
ls -l "${out}"
