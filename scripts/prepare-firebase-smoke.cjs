#!/usr/bin/env node
// Test-only patch of generated Android files. Never called by normal builds.
const fs = require('node:fs');
const path = require('node:path');
if (process.env.KINESYNC_FIREBASE_SMOKE !== '1') throw new Error('Set KINESYNC_FIREBASE_SMOKE=1 explicitly');
const root = path.resolve(__dirname, '..');
const gradlePath = path.join(root, 'ExpoLyrics/android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (gradle.includes('firebaseRustSmoke')) throw new Error('Already patched, regenerate Android first');
if (!gradle.includes('react {') || !gradle.includes('release {')) throw new Error('Unexpected generated Gradle layout');
gradle = gradle.replace('react {', `def firebaseRustSmoke = findProperty("firebaseRustSmoke") == "true"
react {
    if (firebaseRustSmoke) {
        extraPackagerArgs = ["--dev", "true", "--minify", "false"]
    }
`);
gradle = gradle.replace('    entryFile = file(', '    entryFile = firebaseRustSmoke ? file("../../firebase-rust-smoke.tsx") : file(');
gradle = gradle.replace('        release {', '        release {\n            if (firebaseRustSmoke) signingConfig signingConfigs.debug');
fs.writeFileSync(gradlePath, gradle);
const applicationPath = path.join(root, 'ExpoLyrics/android/app/src/main/java/dev/kineticron/KineSync/MainApplication.kt');
let application = fs.readFileSync(applicationPath, 'utf8');
if (!application.includes('context = applicationContext,')) throw new Error('Unexpected Expo React host template');
application = application.replace('context = applicationContext,', 'context = applicationContext,\n        useDevSupport = false,');
fs.writeFileSync(applicationPath, application);
console.log('Patched generated files for bundled Firebase smoke APK. Assemble release with -PfirebaseRustSmoke=true only.');
