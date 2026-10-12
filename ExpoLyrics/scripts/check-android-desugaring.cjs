/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual prebuild transform on fresh and previously generated projects.
const moduleObject = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/with-android-desugaring.js'), 'utf8'), {
  module: moduleObject,
  require: name => {
    assert.equal(name, '@expo/config-plugins');
    return { withAppBuildGradle: (config, action) => action({ modResults: config }).modResults };
  },
});
const transform = source => moduleObject.exports({ language: 'groovy', contents: source }).contents;
for (const dependency of ['', "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'",
  'coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:2.1.5"',
  "coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs_nio:2.1.5'"]) {
  const result = transform(`android {\n}\ndependencies {\n${dependency}\n}`);
  assert.match(result, /coreLibraryDesugaringEnabled true/);
  assert.match(result, /com\.android\.tools:desugar_jdk_libs_nio:2\.1\.5/);
  assert.equal((result.match(/coreLibraryDesugaring\s+["']/g) || []).length, 1, 'one NIO backport dependency');
  assert.equal(transform(result), result, 'prebuild must be idempotent');
  assert.doesNotMatch(result, /com\.android\.tools:desugar_jdk_libs:/, 'standard flavor omits java.nio.file.Path');
}
assert.throws(() => transform('dependencies {}'), /Android Gradle block not found/);
assert.equal(moduleObject.exports({ language: 'kotlin', contents: 'unchanged' }).contents, 'unchanged');
console.log('Android compatibility checks passed: NIO backports, existing-project migration and idempotent prebuild.');
