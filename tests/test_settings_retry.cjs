const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(getSettings) {
  const source=fs.readFileSync(path.join(__dirname,'../src/index.tsx'),'utf8');
  const body=source.slice(source.indexOf('async function loadBadgeVisibility('),source.indexOf('function getSteamLibraryApps('));
  const timers=new Map();let next=0,resets=0,failures=0;
  const applied=[];
  const context=vm.createContext({
    pluginActive:true,settingsLoading:false,settingsRetryTimer:undefined,settingsLoadFailures:0,
    getSettings,withBackendTimeout:request=>request,
    applyBadgeVisibility:value=>applied.push(value),applyNotificationPreferences:()=>{},
    resetVisibleSupport:()=>resets++,notifyCacheChanged:()=>{},
    hungarianCollection:{settingsUnavailable:()=>failures++},
    console:{warn:()=>{}},
    window:{setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id)},
  });
  vm.runInContext(ts.transpile(body,{target:ts.ScriptTarget.ES2020}),context);
  return {context,timers,applied,get resets(){return resets;},get failures(){return failures;}};
}

test('settings timeout is retried and recovery refreshes failed badges',async()=>{
  let calls=0;
  const f=fixture(async()=>{if(++calls===1)throw Error('backend timeout');return {success:true,show_gfn_badges:true,show_boosteroid_badges:true,show_hungarian_badges:false};});
  await f.context.loadBadgeVisibility();
  assert.equal(f.applied.length,0);assert.equal(f.failures,1);
  assert.equal([...f.timers.values()][0].delay,5000);
  await f.context.loadBadgeVisibility();
  assert.equal(f.timers.size,0);assert.equal(f.applied.length,1);
  assert.equal(f.applied[0].show_hungarian_badges,false);
  assert.equal(f.resets,1);assert.equal(f.context.settingsLoadFailures,0);
});

test('late backend response after unload does not apply settings or schedule retries',async()=>{
  let complete;
  const f=fixture(()=>new Promise(resolve=>complete=resolve));
  const work=f.context.loadBadgeVisibility();
  f.context.pluginActive=false;
  complete({success:true});await work;
  assert.equal(f.applied.length,0);assert.equal(f.timers.size,0);
});

test('settings requests never overlap and explicit errors also retry',async()=>{
  let complete,calls=0;
  const f=fixture(()=>{calls++;return new Promise(resolve=>complete=resolve);});
  const work=f.context.loadBadgeVisibility();
  await f.context.loadBadgeVisibility();assert.equal(calls,1);
  complete({success:false,error:'not ready'});await work;
  assert.equal(f.applied.length,0);assert.equal(f.timers.size,1);
});
