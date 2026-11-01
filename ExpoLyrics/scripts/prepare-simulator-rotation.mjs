// CI-only published artifact, independent of candidate/baseline npm dependencies.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export const VERSION = '0.13.0';
export const INTEGRITY = 'sha512-6t0KagStEXf24ngJ2r88rJHgjlbLTIQOAVWfvFzwq+9TG+33fM/vponXiXtdNE+63cowlCC/tzg4r3GEH0/RUA==';
export const NATIVE_SHA256 = '1ef2f6a7476b5d8aed53f1510f1a6a24f90dcedabcd6f43cda8f78812d281ae1';
export const FRAMEWORK_SHA256 = '5a63c064a8c60a01a2a5b0c8385962d224eb61b5fb0bb0f088937c2415979090';
export function verifyArchive(bytes) {
  if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== INTEGRITY) throw Error('Rotation archive integrity mismatch');
}
export function verifyNative(file) {
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== NATIVE_SHA256) throw Error('Pinned rotation addon hash mismatch');
}
export function verifyFramework(file) {
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== FRAMEWORK_SHA256) throw Error('Pinned rotation framework hash mismatch');
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) < 20) throw Error('Rotation tool requires arm64 macOS and Node >=20');
  const destination = process.argv[2];
  if (!destination || fs.existsSync(destination)) throw Error('Fresh isolated rotation tool destination required');
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), 'rotation-download-'));
  try {
    const response = await fetch('https://registry.npmjs.org/@expo/serve-sim/-/serve-sim-0.13.0.tgz', { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Rotation download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes);
    const archive = path.join(staging, 'package.tgz');
    fs.writeFileSync(archive, bytes);
    // Preserve the addon's loader-relative prebuilt WebRTC framework dependency.
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging, 'package/dist/native/serve-sim-native.node', 'package/dist/bin/LiveKitWebRTC.framework'], { timeout: 15000 });
    const addon = path.join(staging, 'package/dist/native/serve-sim-native.node');
    verifyNative(addon);
    verifyFramework(path.join(staging, 'package/dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC'));
    fs.mkdirSync(destination);
    fs.cpSync(path.join(staging, 'package/dist'), path.join(destination, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify({ version: VERSION, integrity: INTEGRITY, nativeSHA256: NATIVE_SHA256, frameworkSHA256: FRAMEWORK_SHA256 }, null, 2));
    console.log(`Prepared @expo/serve-sim ${VERSION} native addon ${NATIVE_SHA256}`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
