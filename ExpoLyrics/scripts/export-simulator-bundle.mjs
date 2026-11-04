// Separate process records actual export time while the coordinator builds native code.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeJson } from './simulator-app-reuse.mjs';
const [project, entry, destination, timingFile] = process.argv.slice(2);
if (![project, entry, destination, timingFile].every(value => value && path.isAbsolute(value))) throw new Error('Expected absolute export paths');
const started = Date.now();
const child = spawn(process.execPath, [path.join(project, 'node_modules/expo/bin/cli'), 'export:embed',
  '--entry-file', entry, '--platform', 'ios', '--dev', 'false', '--minify', 'false',
  '--bundle-output', path.join(destination, 'main.jsbundle'), '--assets-dest', destination, '--max-workers', '2'],
{ cwd: project, env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 3000).unref();
});
try {
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Fresh export failed: ${code ?? signal}`)));
  });
} finally {
  writeJson(timingFile, { started, completed: Date.now(), seconds: (Date.now() - started) / 1000 });
}
