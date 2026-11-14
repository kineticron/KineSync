// Local verification only: no app build, push, CI dispatch or Metro operation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.resolve(process.argv[2] || '/tmp/phone-present-final');
fs.mkdirSync(artifacts, { recursive: true });
const cargoArgs = ['+1.97.0'];
const manifest = ['--manifest-path', 'native/lyrics-renderer/Cargo.toml'];
const commands = [
 ['fmt','cargo',[...cargoArgs,'fmt','--check',...manifest]],
 ['rust-tests','cargo',[...cargoArgs,'test','--locked',...manifest,'--','--include-ignored']],
 ['clippy-host','cargo',[...cargoArgs,'clippy','--locked',...manifest,'--all-targets','--','-D','warnings']],
 ['clippy-ios','cargo',[...cargoArgs,'clippy','--locked',...manifest,'--lib','--target','aarch64-apple-ios','--','-D','warnings']],
 ['typescript','npm',['--prefix','ExpoLyrics','run','typecheck']],
 ['eslint','./node_modules/.bin/eslint',['components/lyrics/rust/rust-lyrics-view.tsx'],path.join(root,'ExpoLyrics')],
 ['node-tests','node',['--test','scripts/test/ios-dev-ci.test.cjs']],
 ['actionlint','/tmp/rust-spike-actionlint/actionlint',['.github/workflows/ios-development-build.yml']],
 ['repository','node',['scripts/check-repository.cjs']],
 ['baseline','node',['native/lyrics-renderer/evidence/phone-present-baseline.cjs']],
 ['alpha1','cargo',[...cargoArgs,'run','--locked',...manifest,'--','alpha-proof',path.join(artifacts,'alpha1'),'1']],
 ['alpha3','cargo',[...cargoArgs,'run','--locked',...manifest,'--','alpha-proof',path.join(artifacts,'alpha3'),'3']],
 ['benchmark','cargo',[...cargoArgs,'run','--locked',...manifest,'--','bench',path.join(artifacts,'benchmark.json'),'30','6',path.join(artifacts,'bench-png')]],
 ['diff','git',['diff','--check']],
 ['lock','git',['diff','--exit-code','cbb467f','--','native/lyrics-renderer/Cargo.lock']],
 ['clipping-scroll','git',['diff','--exit-code','cbb467f','--','ExpoLyrics/app/(tabs)/index.tsx','native/lyrics-renderer/src/scene.rs','native/lyrics-renderer/src/motion.rs']],
];
const env = { ...process.env, BASH32: '/tmp/rust-bash32-src/bash-3.2.57/bash' };
const report = { artifacts, note: 'Linux llvmpipe proxy. Rust test/check compilation only; no app build or device performance acceptance.', checks: [] };
for (const [name, command, args, cwd=root] of commands) {
 const result = spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:10*1024*1024});
 const output = ((result.stdout||'')+(result.stderr||'')+(result.error ? String(result.error) : '')).trimEnd();
 fs.writeFileSync(path.join(__dirname,`phone-present-${name}.log`),output ? output+'\n' : '');
 report.checks.push({name,command,args,cwd,exit:result.status,signal:result.signal});
 fs.writeFileSync(path.join(__dirname,'phone-present-verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log(`${name}: ${result.status}`);
 if(result.status!==0) process.exit(1);
}
