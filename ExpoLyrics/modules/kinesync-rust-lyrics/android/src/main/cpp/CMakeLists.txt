cmake_minimum_required(VERSION 3.22.1)
project(kinesync_rust_lyrics CXX)

# The Rust staticlib is produced by cargo-ndk into jniLibs/<abi>/liblyrics_renderer.a
# before Gradle runs. It exports the same C ABI as iOS (ABI11).
add_library(lyrics_renderer STATIC IMPORTED)
set(rust_archive "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/liblyrics_renderer.a")
set_target_properties(lyrics_renderer PROPERTIES
  IMPORTED_LOCATION "${rust_archive}")

add_library(kinesync_rust_lyrics SHARED kinesync_rust_lyrics.cpp)
target_include_directories(kinesync_rust_lyrics PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../native/lyrics-renderer/include)
target_link_libraries(kinesync_rust_lyrics lyrics_renderer android log m dl)
option(KINESYNC_ANDROID_FRAME_DIAGNOSTICS "Build the debug frame metrics JNI entry point" OFF)
if(KINESYNC_ANDROID_FRAME_DIAGNOSTICS)
  set(rust_build_kind development)
  target_compile_definitions(kinesync_rust_lyrics PRIVATE KINESYNC_ANDROID_FRAME_DIAGNOSTICS=1)
else()
  set(rust_build_kind release)
  target_compile_definitions(kinesync_rust_lyrics PRIVATE KINESYNC_ANDROID_FRAME_DIAGNOSTICS=0)
  # Hide unreferenced developer-only Rust ABI stubs so section GC can remove them.
  set(release_symbols "${CMAKE_CURRENT_SOURCE_DIR}/release-symbols.map")
  set_property(TARGET kinesync_rust_lyrics APPEND PROPERTY LINK_DEPENDS "${release_symbols}")
  target_link_options(kinesync_rust_lyrics PRIVATE "-Wl,--version-script,${release_symbols}" -Wl,--gc-sections)
endif()

# Validate the actual archive at each link, including when switching variants
# reuses the same archive path. Depend on the verifier so updating it relinks.
find_program(KINESYNC_NODE_EXECUTABLE NAMES node REQUIRED NO_CMAKE_FIND_ROOT_PATH)
set(rust_archive_verifier "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../scripts/check-release-diagnostics.cjs")
set_property(TARGET kinesync_rust_lyrics APPEND PROPERTY LINK_DEPENDS "${rust_archive_verifier}")
add_custom_command(TARGET kinesync_rust_lyrics PRE_LINK
  COMMAND "${KINESYNC_NODE_EXECUTABLE}" "${rust_archive_verifier}"
    rust-archive "${rust_archive}" "${rust_build_kind}"
  VERBATIM)

# 16 KB page alignment for Android 15+.
target_link_options(kinesync_rust_lyrics PRIVATE -Wl,-z,max-page-size=16384)
