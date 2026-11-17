cmake_minimum_required(VERSION 3.22.1)
project(kinesync_rust_lyrics CXX)

# The Rust staticlib is produced by cargo-ndk into jniLibs/<abi>/liblyrics_renderer.a
# before Gradle runs. It exports the same C ABI as iOS (ABI10).
add_library(lyrics_renderer STATIC IMPORTED)
set_target_properties(lyrics_renderer PROPERTIES
  IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/liblyrics_renderer.a)

add_library(kinesync_rust_lyrics SHARED kinesync_rust_lyrics.cpp)
target_include_directories(kinesync_rust_lyrics PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../native/lyrics-renderer/include)
target_link_libraries(kinesync_rust_lyrics lyrics_renderer android log m dl)
# 16 KB page alignment for Android 15+.
target_link_options(kinesync_rust_lyrics PRIVATE -Wl,-z,max-page-size=16384)
