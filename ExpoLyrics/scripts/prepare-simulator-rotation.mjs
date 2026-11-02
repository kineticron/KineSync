// CI-only published artifact, independent of candidate/baseline npm dependencies.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
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
// Separate process bounds addon load/thread failures before any simulator work.
export function preflightNative(addon, timeout = 60000) {
  const probe = `
    const fs = require('node:fs');
    fs.writeSync(1, JSON.stringify({ node: process.version, arch: process.arch, platform: process.platform, napi: process.versions.napi }) + '\\n');
    try {
      const addon = require(process.argv[1]);
      if (typeof addon.SimHID !== 'function') throw Error('Pinned addon has no SimHID constructor');
      fs.writeSync(1, 'Pinned addon loaded; SimHID export verified (no simulator operation)\\n');
      process.exit(0);
    } catch (error) { fs.writeSync(2, error.stack + '\\n'); process.exit(1); }
  `;
  const result = spawnSync(process.execPath, ['-e', probe, path.resolve(addon)], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: Math.max(1, Math.min(60000, timeout)), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`Rotation addon load failed: ${result.stderr || result.error?.message || result.signal || result.status}`);
    Object.assign(error, { stdout: result.stdout, stderr: result.stderr, signal: result.signal });
    throw error;
  }
  return result.stdout + result.stderr; // Preserve both streams in preparation evidence.
}

function loadDiagnostics(addon, framework) {
  for (const file of [addon, framework]) {
    for (const [cmd, args] of [
      ['/usr/bin/file', [file]],
      ['/usr/bin/otool', ['-L', file]],
      ['/usr/bin/codesign', ['--verify', '--verbose=4', file]],
    ]) {
      console.error(`Rotation load diagnostic: ${cmd} ${args.join(' ')}`);
      try { console.error(execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024 })); }
      catch (error) { console.error(error.stdout?.toString(), error.stderr?.toString(), error.message); }
    }
  }
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
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging, 'package/dist/native/serve-sim-native.node', 'package/dist/bin/LiveKitWebRTC.framework'], { timeout: 60000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    const addon = path.join(staging, 'package/dist/native/serve-sim-native.node');
    verifyNative(addon);
    verifyFramework(path.join(staging, 'package/dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC'));
    fs.mkdirSync(destination);
    fs.cpSync(path.join(staging, 'package/dist'), path.join(destination, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify({ version: VERSION, integrity: INTEGRITY, nativeSHA256: NATIVE_SHA256, frameworkSHA256: FRAMEWORK_SHA256 }, null, 2));
    const installedAddon = path.join(destination, 'dist/native/serve-sim-native.node');
    try { process.stdout.write(preflightNative(installedAddon)); }
    catch (error) {
      console.error('Pinned rotation addon load preflight failed; no native build should proceed.');
      console.error(error.stdout?.toString(), error.stderr?.toString(), error.message);
      loadDiagnostics(installedAddon, path.join(destination, 'dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC'));
      throw error;
    }
    console.log(`Prepared @expo/serve-sim ${VERSION} native addon ${NATIVE_SHA256}`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
