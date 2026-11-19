import json,hashlib,pathlib,subprocess
from PIL import Image
src=pathlib.Path('/tmp/rust-parity-compare-output'); out=pathlib.Path('/tmp/parity-low-reviewfix-bundle');(out/'captures').mkdir(parents=True,exist_ok=True);(out/'repeat').mkdir(parents=True,exist_ok=True)
c=json.loads((src/'captures/capture-manifest.json').read_text());a=json.loads((src/'rust-binary-attestation.json').read_text())
def digest(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
for entries in [c['sources'],c['fonts'],c['rustHostFonts']['files'],a['sourceClosure']]:
 for e in entries:e['sha256']=digest(e['path'])
a['sourceClosureDigest']=hashlib.sha256(json.dumps(a['sourceClosure'],separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
(out/'rust-binary-attestation.json').write_text(json.dumps(a))
results=[]
for mode in ['canonical','positive','transparent']:
 v=json.loads(json.dumps(c))
 for i,r in enumerate(v['records']):
  if mode=='positive':r['pngs']['skia']=r['pngs']['rust']
  if mode=='transparent':
   im=Image.open(r['pngs']['rust']);im=Image.new('RGBA',im.size,(22,28,40,1));p=out/f'{i}.png';im.save(p);r['pngs']['rust']=str(p)
  r['pngHashes']={k:digest(p) for k,p in r['pngs'].items()}
 (out/'captures/capture-manifest.json').write_text(json.dumps(v))
 (out/'repeat/capture-manifest.json').write_text(json.dumps(v))
 for diag in [False,True]:
  cmd=['node','scripts/parity-compare.cjs','--evaluate',str(out),'--output',f'/tmp/parity-low-eval-{mode}-{diag}','--json']+(['--diagnostic'] if diag else [])
  p=subprocess.run(cmd,text=True,capture_output=True);report=json.loads(p.stdout);assert p.returncode == (0 if diag else 1), (cmd,p.stdout,p.stderr)
  assert report['accepted_parity'] is False and report['determinism_verified'] is False
  assert len(report['records']) == 12
  for r in report['records']:
   assert r['physical_passed'] == (mode == 'positive')
   if mode == 'positive': assert r['physical_error'] == 0
   else: assert not r['gate_passed'] and 'PHYSICAL_ERROR_EXCEEDED' in r['failure_reasons']
  results.append({'mode':mode,'diagnostic':diag,'exit':p.returncode,'status':report['status'],'record':[{k:r.get(k) for k in ['physical_error','physical_passed','gate_passed','failure_reasons']} for r in report['records']],'reasons':report.get('failure_reasons')})
pathlib.Path('/tmp/parity-low-reviewfix-cli-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2)[:4500])
