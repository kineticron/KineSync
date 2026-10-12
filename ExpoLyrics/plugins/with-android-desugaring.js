const { withAppBuildGradle } = require('@expo/config-plugins');

// SDK 58's development launcher uses java.time.Duration during application
// startup, and Expo Modules v2's converter registry references java.nio.file.Path.
// The NIO flavor backports both API families for Android 7 devices (API 24/25).
module.exports = function withAndroidDesugaring(config) {
  return withAppBuildGradle(config, mod => {
    if (mod.modResults.language !== 'groovy') return mod;
    let source = mod.modResults.contents;
    if (!source.includes('coreLibraryDesugaringEnabled true')) {
      if (!/^android\s*\{/m.test(source)) throw new Error('Android Gradle block not found for Java API desugaring');
      source = source.replace(/^android\s*\{/m, 'android {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }');
    }
    source = source.replace(/com\.android\.tools:desugar_jdk_libs:/g, 'com.android.tools:desugar_jdk_libs_nio:');
    if (!/coreLibraryDesugaring\s+["']com\.android\.tools:desugar_jdk_libs_nio:/.test(source)) {
      if (!/^dependencies\s*\{/m.test(source)) throw new Error('Android dependencies block not found for Java API desugaring');
      source = source.replace(/^dependencies\s*\{/m, "dependencies {\n    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs_nio:2.1.5'");
    }
    mod.modResults.contents = source;
    return mod;
  });
};
