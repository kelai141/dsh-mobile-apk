import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionedFixture } from './lib/fixture.mjs';
import { planClientRegistryScan } from '../data/registry-scan-c4.mjs';
test('client scan preserves graph/bundle/runtime/error behavior and removes repeated IO', async () => {
const scratch=mkdtempSync(join(tmpdir(),'c4-behavior-'));
const pristine = fs.readFileSync(versionedFixture('dsh-client-modules','lib','index.js'),'utf8');
// 0.2.1-rc.2 起引擎在构造器里用 createRequire(import.meta.url)('../package.json') 读自身发布身份，
// 变体必须落在「lib/index.js + package.json」的真实包根下；单独写一个 .mjs 会 MODULE_NOT_FOUND。
const fixturePackage = fs.readFileSync(versionedFixture('dsh-client-modules','package.json'),'utf8');
assert.equal(planClientRegistryScan(planClientRegistryScan(pristine)),planClientRegistryScan(pristine));
assert.throws(() => planClientRegistryScan(pristine.replace('processOne(entryName, onError) {','broken(){')),/anchor mismatch/);
try {
 const deps=join(scratch,'node_modules','@deepseek-ai','cordis');mkdirSync(deps,{recursive:true});
 writeFileSync(join(deps,'package.json'),JSON.stringify({name:'@deepseek-ai/cordis',type:'module',exports:'./index.js'}));
 writeFileSync(join(deps,'index.js'),'export class Service {constructor(ctx){this.ctx=ctx}}');
 const variants=[['baseline',pristine],['candidate',planClientRegistryScan(pristine)]];
 const outputs=[];
 for(const [name,file] of variants){
  // 变体放在独立包根 modules/<name>/ 下（不落在 root 前缀内，避免污染下方 package.json 读取计数）。
  const moduleRoot=join(scratch,'modules',name);mkdirSync(join(moduleRoot,'lib'),{recursive:true});
  writeFileSync(join(moduleRoot,'package.json'),fixturePackage);
  const target=join(moduleRoot,'lib','index.js');writeFileSync(target,file);
  const {ClientModuleRegistry}=await import(pathToFileURL(target));
  const root=join(scratch,name);mkdirSync(root);const baseUrl=pathToFileURL(join(root,'entry.mjs')).href;
  const rows=[];const hooks=new Map();let scans=0, reads=0;
  for(let n=0;n<24;n++){
   const pkg=join(root,'plugin-'+n);mkdirSync(pkg);
   writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'plugin-'+n,type:'module',exports:{'./client':'./client.js'},dsh:{client:{platform:'web'}}}));
   writeFileSync(join(pkg,'host.js'),'');writeFileSync(join(pkg,'client.js'),'export const n='+n+';');
   rows.push({options:{name:'plugin-'+n},fiber:{},disabled:false,parent:{tree:{ctx:{baseUrl}}}});
  }
  const ctx={loader:{entries(){scans++;return rows;},internal:{version:'v2',resolveSync(base,{specifier}){return {url:pathToFileURL(join(root,specifier,'host.js')).href};}}},logger:{warn(){},error(){}},on(event,hook){hooks.set(event,hook)},inject(){}};
  const originalRead=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file).startsWith(root)&&String(file).endsWith('package.json'))reads++;return originalRead.call(this,file,...args)};syncBuiltinESMExports();
  let registry;
  try{registry=new ClientModuleRegistry(ctx);}finally{fs.readFileSync=originalRead;syncBuiltinESMExports()}
  assert.equal(registry.graph().entries.length,24);
  // Normalize artifact filesystem revision; wire graph order/id and served bundle bytes must stay equal.
  const ids=registry.graph().entries.map(e=>e.id);
  const resources=[];for(const entry of registry.graph().entries){const response=await registry.fetchBundle({method:'GET',url:'http://local/'+entry.url});assert.equal(response.status,200);resources.push([entry.id,response.status,(await response.text()).replaceAll(entry.rev,'REV')]);}
  outputs.push({ids,resources});
  if(name==='candidate'){assert.equal(scans,2);assert.equal(reads,24);}else{assert.equal(scans,25);assert.equal(reads,48)}
  console.log(JSON.stringify({name,entries:24,scans,manifestReads:reads}));
  rows[0].disabled=true;hooks.get('internal/plugin')({entry:rows[0]});await new Promise(r=>setTimeout(r,0));assert.equal(registry.graph().entries.length,23);
  rows[0].disabled=false;hooks.get('internal/plugin')({entry:rows[0]});await new Promise(r=>setTimeout(r,0));assert.equal(registry.graph().entries.length,24);
  // A synchronous error callback may remove another dirty Loader row. The flush
  // must rebuild its temporary index so that removed row never enters the graph.
  for (const [extra, target] of [['bad-extra','absent.js'],['good-extra','client.js']]) {
    const pkg=join(root,extra);mkdirSync(pkg);writeFileSync(join(pkg,'host.js'),'');
    writeFileSync(join(pkg,'package.json'),JSON.stringify({name:extra,exports:{'./client':'./'+target},dsh:{client:{platform:'web'}}}));
    writeFileSync(join(pkg,'client.js'),'export const extra=1;');
    rows.push({options:{name:extra},fiber:{},disabled:false,parent:{tree:{ctx:{baseUrl}}}});
    registry.dirty.add(extra);
  }
  const removed=rows.find(row=>row.options.name==='good-extra');let reported=0;
  registry.flush(() => { reported++;rows.splice(rows.indexOf(removed),1); });
  assert.equal(reported,1);assert.ok(!registry.graph().entries.some(entry=>entry.id==='good-extra'));
  rows.splice(rows.findIndex(row=>row.options.name==='bad-extra'),1);
  // Existing malformed declarations and missing client bundles still throw in the constructor.
  for(const fault of ['declaration','missing']){
   const pkg=join(root,'plugin-0');
   if(fault==='declaration')writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'plugin-0',dsh:{client:{platform:'web',immediately:'wrong'}},exports:{'./client':'./client.js'}}));
   else{writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'plugin-0',dsh:{client:{platform:'web'}},exports:{'./client':'./absent.js'}}));}
   assert.throws(()=>new ClientModuleRegistry(ctx));
  }
 }
 assert.deepEqual(outputs[0],outputs[1]);console.log('baseline/candidate graph and bundle equivalence PASS; runtime add/remove and constructor failures PASS');
}finally{rmSync(scratch,{recursive:true,force:true})}

});
