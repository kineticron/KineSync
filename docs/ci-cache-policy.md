# CI cache policy

Caches supply build inputs. The APK still runs Gradle and verifies the ZIP and APK signature. The unsigned IPA still runs Xcode and verifies Rust registration, symbols, and dynamic library loading. Windows still builds the native addons and installer. Upload and publisher checks continue to enforce the existing artifact contract.

## Cache inputs and limits

| Workflow | Cached paths | Maximum measured input per entry |
| --- | --- | ---: |
| Android APK | Renderer Cargo registry, Git dependencies, and the target directory for the requested ABI set | 2.5 GiB |
| Android APK | Versioned cargo-ndk executables in a dedicated Cargo home | 64 MiB |
| Android APK | Gradle dependency modules and wrapper distributions | 1 GiB |
| Unsigned IPA | Renderer Cargo registry, Git dependencies, and iOS Release target directory | 1.5 GiB |
| Unsigned IPA | CocoaPods release downloads, their specs, and cache version marker | 384 MiB |
| Unsigned IPA | Xcode module and SDK stat caches from Release DerivedData | 256 MiB |
| Windows native release | NuGet global packages, Electron downloads, and node-gyp headers and import libraries | 768 MiB |

These limits measure local files before upload. Rust measures before the Rust Cache action prunes the target, registry, and Git directories. Entries larger than their limit skip upload. The seven limits total 6.4375 GiB for one entry of each kind. GitHub accounts for the stored archives and retains multiple entries across keys and refs. This table does not allocate space or guarantee that the aggregate fits.

- Rust uses the pinned Swatinem action on iOS Release and Android. The action hashes the Rust compiler, relevant build environment, and Cargo manifests and lockfiles. The workflow also keys by the platform compiler and SDK or NDK identity, target and profile, and relevant build configuration. iOS keeps its original runner-temp Cargo target path and computes the action mapping relative to the renderer crate. Android's native namespace includes the requested ABI set, API level, and cargo-ndk version. Cargo still evaluates build fingerprints on every build.
- Android uses pinned `setup-gradle` with external cache ownership. Its built-in post step can run after failure, so the workflow owns cache publication. It removes Gradle download-cache locks and GC markers before save. Gradle build outputs, project and configuration caches, SDKs, and NDKs are outside the cache paths.
- Release iOS restores CocoaPods release downloads before Expo prebuild under a job-specific `CP_CACHE_DIR`. This keeps the runner’s shared CocoaPods downloads outside the archive. CocoaPods classifies released specs from public and private sources as release downloads. Disable this cache before adding private Pod dependencies. [CocoaPods cache configuration](https://github.com/CocoaPods/CocoaPods/blob/1.16.2/lib/cocoapods/config.rb#L97-L112) Release DerivedData is created in the job's temporary workspace. Its exact cache key covers the Xcode and SDK identity, source commit, and resolved Pod inputs. The archive contains compiler caches only. Xcode still runs with its dependency checks and produces fresh build products, including the app. The former combined cache could reuse an exact key after source changes and restored after Expo had already started resolving Pods.
- Windows caches downloaded package content only. The cache key includes host architecture, Node and .NET SDK versions, both npm lockfiles, the native rebuild script and the .NET project. npm still installs dependencies and the build still compiles native code. The cache paths exclude signing files and installer outputs.
- Gradle can reuse downloads across dependency changes within the same epoch, host, Java, NDK and wrapper. CocoaPods can reuse release downloads with the same CocoaPods version and host. Windows can reuse downloads with the same host, Node and .NET SDK. Each publishes using the full dependency key after successful artifact upload. Rust and DerivedData keep only confirmed exact restores. The Rust action uses the same compiler and profile when looking up a compatible entry, but exposes no separate transfer confirmation for a partial match. The workflows clear non-exact Rust restores before building.
- Existing setup-node npm caches and iOS development cache controls keep their established behavior. The Rust post action enforces job success. The production Rust size check enables its save input before the post step. Cache key generation, size checks, saves, and summaries are nonfatal. Explicit saves require a successful measurement and a populated key. Failed or unconfirmed restores clear the affected paths before use. If cleanup fails, the build stops before it can consume a partial restore.

## Android cold and warm runs

Use the same ref, commit, build variant, and architecture for both runs. Dispatch `cold` first with a fresh epoch of 1 to 40 letters, digits, underscores, or dashes starting with a letter or digit. Wait for the job, including post steps, to finish. Dispatch `warm` with the same epoch. Normal runs use the separate `routine` epoch.

Cold skips Gradle and cargo-ndk restores. Rust does a lookup without downloading any data and can seed a missing entry. Use a fresh epoch because GitHub caches are immutable. npm's setup-node cache is active only in normal mode, so both experiment jobs install npm packages without that cache. Hosted runner tools and upstream package services are outside the experiment.

Compare the Android cache evidence tables, the Rust post-step log, and cache transfer times. The table shows exact-hit status, the Gradle matched key, and skipped transfers. Rust's restore log can show a prefix match that cleanup then discards. Explicit save step status reports whether the step ran. Confirm publication in the action logs or the cache inventory. Warm runs still build when caches are missing, evicted, too large to save, or invalidated by toolchain changes.

## Repository storage audit

The implementation-time audit found 11,102,629,012 bytes across 25 entries, already above the 10 GiB budget. The existing `node-cache` family held 5,773,290,417 bytes across 10 entries. Existing iOS development caches held 5,267,939,957 bytes across 14 entries. CodeQL held the remaining 61,398,638 bytes. These are observed stored bytes for the existing repository caches. The limits above apply to future individual uploads.

Collect fresh occupancy and per-entry sizes with read-only commands:

```sh
gh api repos/kineticron/KineSync/actions/cache/usage
gh api --paginate 'repos/kineticron/KineSync/actions/caches?per_page=100' \
  --jq '.actions_caches[] | [.ref, .key, .size_in_bytes, .last_accessed_at] | @tsv'
```

Check both listed sizes and actual restore savings after the first cold and warm pair. GitHub can decline an upload or evict an entry even when the local size check passes. Before interpreting a miss, check the most recent inventory and publication log. Use one active experiment epoch and ABI set at a time, then compare the archive size and time saved for each family before expanding coverage. Android C++ ccache, SDK and NDK archives, Gradle task outputs, and the existing CI npm key strategy are deferred.
