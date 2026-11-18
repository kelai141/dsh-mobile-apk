#!/usr/bin/env node
// Build exact product ownership identities from the final, injected snapshot archive.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? '' : args[i + 1] ?? '' }
const snapshot = resolve(value('--snapshot'))
const output = resolve(value('--out'))
if (!value('--snapshot') || !value('--out')) { console.error('usage: build-hard-manifest.mjs --snapshot <final.tar.xz> --out <manifest.json>'); process.exit(2) }
const py = String.raw`import json,sys,tarfile,hashlib,posixpath,lzma,shutil,tempfile
from contextlib import ExitStack
archive,out=sys.argv[1:3]
names=[]
# Bundle manifests can reference entries in any archive order. Spool the tar once
# so metadata lookups seek the temporary file instead of replaying decompression.
with ExitStack() as stack:
  raw = stack.enter_context(tempfile.TemporaryFile())
  with lzma.open(archive, 'rb') as compressed:
    shutil.copyfileobj(compressed, raw, length=1024*1024)
  raw.seek(0)
  tf = stack.enter_context(tarfile.open(fileobj=raw, mode='r:'))
  all_members={m.name.lstrip('./'):m for m in tf.getmembers()}
  members={path:m for path,m in all_members.items() if m.isfile()}
  yaml_targets=[
    'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
    'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
    'home/.dsh/profiles/web/cordis.patch.yml',
  ]
  targets=yaml_targets+['home/.dsh/profiles/web/package.json']
  missing=[path for path in targets if path not in members]
  if missing: raise SystemExit('final snapshot lacks complete Cordis composition inputs: '+', '.join(missing))
  for path in sorted(set(yaml_targets)):
    text=tf.extractfile(members[path]).read().decode('utf-8')
    lines=text.splitlines()
    i=0
    while i<len(lines):
      if lines[i].strip()!='- insert:': i+=1; continue
      end=i+1
      while end<len(lines) and not (lines[end].startswith('- ') or lines[end]=='-'): end+=1
      rows=[]
      for j in range(i+1,end):
        import re
        m=re.match(r'^(\s*)-\s+(id|name):\s*(.*)$',lines[j])
        if m: rows.append((j,len(m.group(1))))
      if rows:
        indent=min(w for _,w in rows)
        starts=[j for j,w in rows if w==indent]
        for k,start in enumerate(starts):
          stop=starts[k+1] if k+1<len(starts) else end
          import re
          head=re.match(r'^\s*-\s+(id|name):\s*(.*)$',lines[start])
          ident=head.group(2).strip().strip("'").strip('"') if head.group(1)=='id' else None
          module=head.group(2).strip().strip("'").strip('"') if head.group(1)=='name' else None
          for row in lines[start+1:stop]:
            m=re.match(r'^\s{'+str(indent+2)+r'}name:\s*(.*)$',row)
            if m and not module: module=m.group(1).strip().strip("'").strip('"')
          if module:
            if not ident: raise SystemExit('product insert identity has a name but no exact id: '+path+':'+str(start+1))
            names.append({'id':ident,'name':module,'source':path})
      i=end
  profile=json.loads(tf.extractfile(members['home/.dsh/profiles/web/package.json']).read().decode('utf-8'))
  selected=profile.get('dsh',{}).get('profile',{}).get('bundles')
  if not isinstance(selected,list) or any(not isinstance(name,str) or not name for name in selected):
    raise SystemExit('final web profile has missing or invalid dsh.profile.bundles')
  if len(set(selected)) != len(selected): raise SystemExit('final web profile repeats a factory bundle name')
  bundles=[]
  install='usr/lib/node_modules/@deepseek-ai/dsh/node_modules'
  profile_modules='home/.dsh/profiles/web/node_modules'
  for name in selected:
    if name.startswith('/') or '\\' in name or '\x00' in name or '..' in name.split('/'):
      raise SystemExit('unsafe factory bundle package name: '+repr(name))
    package_path=None
    for root in (install,profile_modules):
      candidate=posixpath.join(root,name)
      manifest_path=posixpath.join(candidate,'package.json')
      if manifest_path in members:
        package_path=manifest_path
        break
      # app-boot resolves install first, then profile. If that winning location is
      # represented through an archive symlink, do not silently hash a profile copy.
      ancestors=[]
      current=candidate
      while current and current != '.':
        ancestors.append(current)
        current=posixpath.dirname(current)
      if any(path in all_members and (all_members[path].issym() or all_members[path].islnk()) for path in ancestors):
        raise SystemExit('factory bundle resolution crosses archive symlink; refusing incomplete identity source: '+name)
    if package_path is None: raise SystemExit('factory bundle package manifest missing: '+name)
    package=json.loads(tf.extractfile(members[package_path]).read().decode('utf-8'))
    if package.get('name') != name or not isinstance(package.get('version'),str) or not package['version']:
      raise SystemExit('factory bundle package identity mismatch: '+name)
    declared=package.get('dsh',{}).get('bundle',{}).get('patch')
    patch_files=[declared] if isinstance(declared,str) else declared
    if not isinstance(patch_files,list) or not patch_files or any(not isinstance(path,str) or not path for path in patch_files):
      raise SystemExit('factory bundle has missing or invalid dsh.bundle.patch: '+name)
    patch_digest=hashlib.sha256()
    patch_digest.update(b'DSHBNDL1')
    for rel in patch_files:
      if rel.startswith('/') or '\\' in rel or '\x00' in rel or '..' in rel.split('/'):
        raise SystemExit('unsafe factory bundle patch path: '+name+':'+repr(rel))
      patch_path=posixpath.normpath(posixpath.join(posixpath.dirname(package_path),rel))
      package_root=posixpath.dirname(package_path)
      if not patch_path.startswith(package_root+'/') or patch_path not in members:
        raise SystemExit('factory bundle patch file missing or escapes package: '+name+':'+rel)
      path_bytes=rel.encode('utf-8')
      patch_bytes=tf.extractfile(members[patch_path]).read()
      # Frame path and content lengths so multiple patch files have an unambiguous ordered digest.
      patch_digest.update(len(path_bytes).to_bytes(4,'big')); patch_digest.update(path_bytes)
      patch_digest.update(len(patch_bytes).to_bytes(8,'big')); patch_digest.update(patch_bytes)
    bundles.append({'name':name,'version':package['version'],'patchSha256':patch_digest.hexdigest()})
entries={ (row['id'],row['name']):row for row in names }
if not entries: raise SystemExit('no plugin insert identities found in final snapshot')
hard=[{'id':row['id'],'name':row['name']} for row in entries.values()]
profile=[{'id':row['id'],'name':row['name']} for row in entries.values() if row['source']=='home/.dsh/profiles/web/cordis.patch.yml']
print(json.dumps({'entries':sorted(hard,key=lambda x:(x['name'],x['id'] or '')),'profileEntries':sorted(profile,key=lambda x:(x['name'],x['id'] or '')),'factoryBundles':sorted(bundles,key=lambda x:x['name'])},separators=(',',':')))`
const python = process.platform === 'win32' ? 'python' : 'python3'
const extracted = spawnSync(python, ['-c', py, snapshot, output], { encoding: 'utf8' })
if (extracted.status !== 0) {
  process.stderr.write(extracted.stderr || extracted.stdout || 'manifest extraction failed\n')
  process.exit(extracted.status ?? 1)
}
const result = JSON.parse(extracted.stdout)
const fingerprint = createHash('sha256').update(readFileSync(snapshot)).digest('hex')
const manifest = { schema: 2, complete: true, fingerprint, entries: result.entries, profileEntries: result.profileEntries,
  factoryBundles: result.factoryBundles,
  names: [...new Set(result.entries.map((entry) => entry.name))].sort() }
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(manifest) + '\n', 'utf8')
console.log(`hard manifest: ${manifest.entries.length} exact identities; snapshot=${fingerprint}`)
