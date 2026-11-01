// Leave three minutes of the unchanged job timeout for summaries and artifact upload.
import { spawn } from 'node:child_process';
const deadline = Number(process.env.SIMULATOR_CI_DEADLINE_MS);
if (!Number.isFinite(deadline)) throw new Error('Missing SIMULATOR_CI_DEADLINE_MS');
const remaining = deadline - Date.now();
if (remaining <= 0) { console.error('CI execution budget exhausted; preserving upload reserve'); process.exit(1); }
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit', detached: true });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.error('CI execution budget exhausted or interrupted; terminating command group');
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } process.exit(1); }, 5000);
}
const timer = setTimeout(stop, remaining);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
child.on('error', err => { clearTimeout(timer); console.error(err.message); process.exit(1); });
child.on('exit', code => { if (!stopping) { clearTimeout(timer); process.exit(code ?? 1); } });
