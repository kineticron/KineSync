// Short-lived native process: no HTTP listener, daemon, GUI, touch, or capture service.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { VERSION, verifyNative, verifyFramework } from './prepare-simulator-rotation.mjs';
const [udid, orientation] = process.argv.slice(2);
try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Native rotation requires arm64 macOS');
  if (!process.env.DEVELOPER_DIR || !/^[a-f0-9-]{36}$/i.test(udid) || !['portrait', 'landscape'].includes(orientation)) throw Error('Explicit Xcode, UDID and orientation required');
  if (!process.env.SIMULATOR_ROTATION_TOOL_DIR) throw Error('Pinned rotation tool directory required');
  const file = path.join(process.env.SIMULATOR_ROTATION_TOOL_DIR, 'dist/native/serve-sim-native.node');
  verifyNative(file);
  verifyFramework(path.join(process.env.SIMULATOR_ROTATION_TOOL_DIR, 'dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC'));
  const developer = fs.realpathSync(process.env.DEVELOPER_DIR);
  if (developer !== process.env.DEVELOPER_DIR) throw Error('Canonical selected Xcode required');
  // The pinned native loader calls xcode-select -p internally; verify its view too.
  const selected = execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }).trim();
  if (fs.realpathSync(selected) !== developer) throw Error('Native loader Xcode selection mismatch');
  const { SimHID } = createRequire(import.meta.url)(file);
  const hid = new SimHID(udid);
  // UIDeviceOrientation: portrait=1, landscapeRight=3, as in the pinned native source.
  const accepted = await hid.orientation(orientation === 'portrait' ? 1 : 3);
  if (accepted !== true) throw Error('Native orientation delivery rejected');
  fs.writeSync(1, '\nKINESYNC_ROTATION_RESULT ' + JSON.stringify({ version: VERSION, udid, orientation, accepted, developer }) + '\n');
  process.exit(0); // Native resources belong only to this process; no daemon to leave behind.
} catch (error) { fs.writeSync(2, `@expo/serve-sim ${VERSION}: ${error.stack}\n`); process.exit(1); }
