const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function wakeFixture(failures=0) {
  let now=100000, id=0, resume, calls=0, removed=0;
  const timers=new Map(),intervals=new Map(),exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/cloudResumeRefresh.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,{exports,Date:{now:()=>now},setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:fn=>{intervals.set(++id,fn);return id;},clearInterval:id=>intervals.delete(id)});
  const worker=new exports.CloudResumeRefresh({register:fn=>{resume=fn;return ()=>removed++;},
    refresh:async()=>{if(++calls<=failures)throw Error('Wi-Fi reconnecting');},onError:()=>{}});
  worker.start();
  return {worker,timers,intervals,wake:()=>resume(),get calls(){return calls;},get removed(){return removed;},
    gap:()=>{now+=120000;for(const fn of intervals.values())fn();},
    async step(){const [key,timer]=timers.entries().next().value;timers.delete(key);now+=timer.ms;timer.fn();for(let i=0;i<10;i++)await Promise.resolve();}};
}

test('wake waits for network, coalesces native and timer-gap signals, and cleans up',async()=>{
  const f=wakeFixture();f.wake();f.gap();f.wake();
  assert.equal(f.calls,0);assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,8000);
  await f.step();assert.equal(f.calls,1);
  f.worker.stop();f.wake();assert.equal(f.timers.size,0);assert.equal(f.intervals.size,0);assert.equal(f.removed,1);
});

test('offline wake retries twice with backoff and stops; unload cancels a queued retry',async()=>{
  const f=wakeFixture(10);f.gap();await f.step();
  assert.equal([...f.timers.values()][0].ms,30000);await f.step();
  assert.equal([...f.timers.values()][0].ms,120000);await f.step();
  assert.equal(f.calls,3);assert.equal(f.timers.size,0);
  f.gap();await f.step();f.worker.stop();assert.equal(f.timers.size,0);
});

test('catalog refresh replaces cached negative badges on both surfaces and refreshes watchlist',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/index.tsx'),'utf8');
  const code=source.slice(source.indexOf('async function refreshCloudViews('),source.indexOf('let cloudRefresh:'));
  const gfnStates=new Map([['4126040','not_available']]),boosteroidStates=new Map(gfnStates);
  let published=0,watchRefresh=0;
  const context=vm.createContext({cloudViewRevision:0,gfnStates,boosteroidStates,visibleAppIds:new Map([['4126040',1]]),storeCurrentAppIds:new Set(['4126040']),
    watchedGames:new Map([['4126040',{}]]),pluginActive:true,CATALOG_BACKEND_TIMEOUT_MS:60000,withBackendTimeout:promise=>promise,
    getGfnAvailability:async()=>({success:true,availability:{'4126040':true}}),
    getBoosteroidAvailability:async()=>({success:true,availability:{'4126040':true},maintenance:{'4126040':false}}),
    publishSupportState:()=>published++,notifyCacheChanged:()=>{},loadWatchlistState:async()=>watchRefresh++});
  vm.runInContext(ts.transpile(code,{target:ts.ScriptTarget.ES2020}),context);
  await context.refreshCloudViews();
  assert.equal(gfnStates.get('4126040'),'available');assert.equal(boosteroidStates.get('4126040'),'available');
  assert.equal(published,1);assert.equal(watchRefresh,1);
  context.getBoosteroidAvailability=async()=>({success:true,availability:{'4126040':null}});
  await context.refreshCloudViews();assert.equal(boosteroidStates.get('4126040'),'unavailable');
});
