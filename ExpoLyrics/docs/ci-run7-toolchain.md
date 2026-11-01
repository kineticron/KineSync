Run7 simulator scope

Use macos-26 arm64, explicit /Applications/Xcode_26.6.app/Contents/Developer (17F113), iphonesimulator SDK 26.5 and available iOS 26.5 runtime. Official runner inventory image 20261026.0455.2: https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-26-arm64-Readme.md . The label moves; workflow and harness validate selected versions and retain toolchain.json. xcode-select is aligned before native loading; worker independently checks agreement.

The job allows 90 minutes, with 75 minutes for work, including a six minute scenario reservation, and separate cache save/upload margin. Existing subprocess limits remain unchanged. Runs4–6 simctl timeouts establish symptoms only; this toolchain switch is a controlled experiment, not a proven root-cause fix.

Pinned native rotation 0.13.0, screenshot and native layout gates, baseline adapters and seven-pair comparison remain mandatory. No GUI prerequisite is inferred. Run6 proved addon loading on its former image only; orientation, native startup and comparison on this image remain unverified until a separately reviewed, user-controlled run. Implementation does not authorize dispatch.
