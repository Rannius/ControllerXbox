const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  const timers = new Map();
  let timerId = 0;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/hungarianCollection.ts'), 'utf8'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2020},
  }).outputText, {exports, setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;}, clearTimeout:id=>timers.delete(id)});
  const saved = [];
  let creations = 0;
  const store = {
    userCollections: [],
    NewUnsavedCollection(name) {
      creations++;
      const members = new Set();
      const c = {
        displayName:name, apps:members,
        AsDragDropCollection:()=>({AddApps:apps=>apps.forEach(a=>members.add(a.appid)), RemoveApps:apps=>apps.forEach(a=>members.delete(a.appid))}),
        async Save(){saved.push([...members]);if(!store.userCollections.includes(c))store.userCollections.push(c);},
      };
      return c;
    },
  };
  const apps = [1,2,3,4,5].map(appid=>({appid,app_type:1}));
  const cache = {};
  const requests = [];
  const deps = {
    getStore:()=>store, getApps:()=>apps,
    cached:async()=>({success:true,hungarian:{...cache}}),
    lookup:async ids=>{requests.push([...ids]);const result={};ids.forEach(id=>result[id]=cache[id]=Number(id)%2===1);return {success:true,hungarian:result};},
    onLanguages:()=>{},
  };
  const manager = new exports.HungarianCollection(deps);
  manager.setEnabled(true);
  // Execute each scheduled callback and drain its async work without real sleeps.
  async function step() {
    const [id,timer] = timers.entries().next().value;
    timers.delete(id);timer.fn();
    for(let i=0;i<40 && manager.running;i++) await Promise.resolve();
    assert.equal(manager.running,false);
  }
  return {manager,deps,cache,requests,store,apps,saved,timers,step,get creations(){return creations;}};
}

test('fills one native collection in small batches and reuses cache without repeated saves', async()=>{
  const f=fixture();
  await f.step();
  assert.deepEqual(f.requests,[['1','2']]);
  assert.equal([...f.timers.values()][0].ms,5000);
  await f.step();await f.step();await f.step();
  assert.equal(f.creations,1);
  assert.deepEqual([...f.store.userCollections[0].apps],[1,3,5]);
  assert.equal(f.saved.length,3);
  assert.equal(f.requests.length,3);
  assert.match(f.manager.status,/5\/5/);
});

test('unknown data preserves members, explicit negative removes them, unrelated collections are untouched',async()=>{
  const f=fixture();await f.step();
  const unrelated=f.store.NewUnsavedCollection('Saját gyűjtemény');unrelated.apps.add(42);await unrelated.Save();
  Object.assign(f.cache,{'1':null,'2':false,'3':true,'4':false,'5':null});
  await f.step();
  assert.deepEqual([...f.store.userCollections[0].apps],[1,3]);
  f.cache['1']=false;await f.step();
  assert.deepEqual([...f.store.userCollections[0].apps],[3]);
  assert.deepEqual([...unrelated.apps],[42]);
});

test('disabling during lookup prevents late creation and cancels timers; enabling resumes',async()=>{
  const f=fixture();let resolve;
  f.deps.lookup=()=>new Promise(r=>resolve=r);
  const work=f.manager.tick();
  for(let i=0;i<10&&!resolve;i++) await Promise.resolve();
  f.manager.setEnabled(false);
  resolve({success:true,hungarian:{'1':true,'2':false}});await work;
  assert.equal(f.creations,0);assert.equal(f.timers.size,0);
  f.deps.lookup=async()=>({success:true,hungarian:{'1':true,'2':false}});
  f.manager.setEnabled(true);await f.step();
  assert.equal(f.creations,1);
  f.manager.stop();assert.equal(f.timers.size,0);
});

test('failed requests back off while remaining games continue, and shortcuts are excluded',async()=>{
  const f=fixture();
  f.apps.push({appid:2147483649,app_type:1},{appid:6,app_type:2},{appid:7,BIsModOrShortcut:()=>true});
  f.deps.lookup=async ids=>{f.requests.push([...ids]);return {success:true,unavailable:ids,hungarian:{}};};
  await f.step();await f.step();
  assert.deepEqual(f.requests,[['1','2'],['3','4']]);
  assert.equal(f.creations,0);
});

test('failed Save is retried on the same collection without making duplicates',async()=>{
  const f=fixture();
  const create=f.store.NewUnsavedCollection.bind(f.store);let attempts=0;
  f.store.NewUnsavedCollection=name=>{const c=create(name),save=c.Save;c.Save=async()=>{if(++attempts===1)throw Error('offline');await save();};return c;};
  await f.step();assert.equal(f.store.userCollections.length,0);
  await f.step();assert.equal(f.creations,1);assert.equal(f.store.userCollections.length,1);
});

test('missing Steam API shows status and retries without sending language requests',async()=>{
  const f=fixture();f.deps.getStore=()=>undefined;
  await f.step();assert.equal(f.requests.length,0);
  assert.match(f.manager.status,/Steam/);assert.equal([...f.timers.values()][0].ms,60000);
});
