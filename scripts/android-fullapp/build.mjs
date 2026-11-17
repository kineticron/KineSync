#!/usr/bin/env node
// Offline runner build. Never installs or launches an app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--compile-only', '--sign'].includes(arg))) {
  throw new Error('Usage: node scripts/android-fullapp/build.mjs [--compile-only | --sign]');
}
if (args.includes('--compile-only') && args.includes('--sign')) throw new Error('Choose compile-only or sign');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const jdk = process.env.JAVA_HOME;
if (!sdk || !jdk) throw new Error('Set ANDROID_HOME (or ANDROID_SDK_ROOT) and JAVA_HOME');
const api = process.env.ANDROID_API || '37.0';
const version = process.env.ANDROID_BUILD_TOOLS || '37.0.0';
const androidJar = path.join(sdk, 'platforms', `android-${api}`, 'android.jar');
const bt = path.join(sdk, 'build-tools', version);
const exe = process.platform === 'win32' ? '.exe' : '';
const java = name => path.join(jdk, 'bin', name + exe);
const tool = name => path.join(bt, name + exe);
function run(command, argv, options = {}) {
  return execFileSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
}
if (!fs.existsSync(androidJar)) throw new Error(`Missing SDK platform android-${api}`);
if (args.includes('--sign') && (!process.env.FULLAPP_KEYSTORE || !process.env.FULLAPP_KS_PASS || !process.env.FULLAPP_KEY_ALIAS)) {
  throw new Error('Signing requires FULLAPP_KEYSTORE, FULLAPP_KEY_ALIAS and FULLAPP_KS_PASS');
}
// Fixed output directory inside this harness only. Remove stale classes and APKs.
const build = path.join(root, 'build');
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(path.join(build, 'classes'), { recursive: true });
fs.mkdirSync(path.join(build, 'dex'), { recursive: true });
run(java('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', androidJar,
  '-d', 'build/classes', 'src/dev/kineticron/fullapp/FullAppRunner.java']);
run(java('jar'), ['cf', 'build/classes.jar', '-C', 'build/classes', '.']);
if (args.includes('--compile-only')) {
  console.log('Runner Java compilation passed. No APK built or device accessed.');
} else {
  run(java('java'), ['-cp', path.join(bt, 'lib', 'd8.jar'), 'com.android.tools.r8.D8',
    '--lib', androidJar, '--min-api', '26', '--output', 'build/dex', 'build/classes.jar']);
  run(tool('aapt2'), ['link', '-I', androidJar, '--manifest', 'AndroidManifest.xml', '-o', 'build/unaligned.apk']);
  run(java('jar'), ['uf', 'build/unaligned.apk', '-C', 'build/dex', 'classes.dex']);
  run(tool('zipalign'), ['-f', '4', 'build/unaligned.apk', 'build/kinesync-fullapp-runner-unsigned.apk']);
  let apk = 'build/kinesync-fullapp-runner-unsigned.apk';
  const signer = path.join(bt, 'lib', 'apksigner.jar');
  if (args.includes('--sign')) {
    const signed = 'build/kinesync-fullapp-runner.apk';
    const options = ['--ks', process.env.FULLAPP_KEYSTORE, '--ks-key-alias', process.env.FULLAPP_KEY_ALIAS,
      '--ks-pass', 'env:FULLAPP_KS_PASS'];
    if (process.env.FULLAPP_KEY_PASS) options.push('--key-pass', 'env:FULLAPP_KEY_PASS');
    run(java('java'), ['-jar', signer, 'sign', ...options, '--out', signed, apk]);
    apk = signed;
    const signature = run(java('java'), ['-jar', signer, 'verify', '--verbose', '--print-certs', apk], { stdio: 'pipe' });
    fs.writeFileSync(path.join(build, 'signature.txt'), signature);
  }
  run(tool('zipalign'), ['-c', '4', apk]);
  for (const [file, argv] of [
    ['badging.txt', ['dump', 'badging', apk]],
    ['manifest.txt', ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']],
  ]) fs.writeFileSync(path.join(build, file), run(tool('aapt2'), argv, { stdio: 'pipe' }));
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, apk))).digest('hex');
  fs.writeFileSync(path.join(build, 'SHA256SUMS'), `${digest}  ${path.basename(apk)}\n`);
  console.log(`Built ${apk} (${digest}). No device accessed.`);
}
