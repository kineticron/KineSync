// Protocol-only subprocess test. Fake adb supplies no hardware or performance measurements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-runner-test-'));
try {
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.ARRIVAL_TEST_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'commands'), JSON.stringify(args) + '\\n');
if (args.includes('logcat')) {
  let last = '';
  setInterval(() => {
    try {
      const raw = fs.readFileSync(path.join(dir, 'launch'), 'utf8');
      if (raw === last) return;
      last = raw;
      const params = new URL(raw.replace(/^'|'$/g, '')).searchParams;
      const payload = JSON.stringify({ run: params.get('run'), style: params.get('style'),
        orientation: params.get('orientation'), scenario: params.get('scenario'), evidence: 'unit-test-stub-no-timing' });
      const total = Math.ceil(payload.length / 80);
      for (let index = total - 1; index >= 0; index--) console.log('KINESYNC_ARRIVAL_CHUNK ' + JSON.stringify({
        run: params.get('run'), index, total, data: payload.slice(index * 80, (index + 1) * 80),
      }));
    } catch {}
  }, 5);
} else if (args.includes('getprop')) console.log(args.includes('ro.kernel.qemu') ? '0' : 'unit-test-stub');
else if (args.includes('get')) console.log('0');
else if (args.includes('start')) fs.writeFileSync(path.join(dir, 'launch'), args[args.indexOf('-d') + 1]);
`;
  fs.writeFileSync(path.join(dir, 'adb'), stub, { mode: 0o755 });
  const output = path.join(dir, 'result.json');
  execFileSync(process.execPath, [path.join(__dirname, 'profile-lyrics-arrival.cjs'), 'fake-unit-device', output], {
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, ARRIVAL_TEST_DIR: dir }, timeout: 30000,
  });
  const result = JSON.parse(fs.readFileSync(output));
  assert.equal(result.results.length, 12);
  assert.ok(result.results.every(row => row.evidence === 'unit-test-stub-no-timing'));
  const commands = fs.readFileSync(path.join(dir, 'commands'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(commands.filter(args => args.includes('force-stop')).length, 12);
  assert.ok(commands.at(-1).includes('accelerometer_rotation'));
  console.log('runner subprocess protocol passed: 12 cold launches, markers, output and rotation restoration; no hardware timing measured');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
