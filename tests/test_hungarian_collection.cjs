const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture(count=5) {
 const timers=new Map();let tid=0;const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/hungarianCollection.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
  {exports,setTimeout:(fn,ms)=>{timers.set(++tid,{fn,ms});return tid;},clearTimeout:id=>timers.delete(id)});
 let creations=0;const saved=[],requests=[],cache={};
 const store={collectionsFromStorage:new Map(),m_cloudStorageMap:{StoreObject(){}},
  get userCollections(){throw Error('dangerous computed getter');},
  NewUnsavedCollection(displayName){creations++;const apps=new Set();const c={displayName,apps,
   AsDragDropCollection:()=>({AddApps:values=>values.forEach(a=>apps.add(a.appid)),RemoveApps:values=>values.forEach(a=>apps.delete(a.appid))}),
   async Save(){saved.push([...apps]);store.collectionsFromStorage.set(displayName,c);}};return c;}};
 const apps=Array.from({length:count},(_,i)=>({appid:i+1,app_type:1,installed:false}));
 const deps={getStore:()=>store,getApps:()=>apps,cached:async()=>({success:true,hungarian:{...cache},curator_status:'cached'}),
  lookup:async ids=>{requests.push([...ids]);const result={};for(const id of ids)result[id]=cache[id]=Number(id)%2===1;return {success:true,hungarian:result};},onLanguages:()=>{}};
 const manager=new exports.HungarianCollection(deps);manager.setEnabled(true);
 const drain=async(n=30)=>{for(let i=0;i<n;i++)await Promise.resolve();};
 const step=async()=>{const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();for(let i=0;i<6000&&manager.running;i++)await Promise.resolve();assert.equal(manager.running,false);};
 return {manager,store,apps,deps,cache,requests,saved,timers,drain,step,get creations(){return creations;},get collection(){return [...store.collectionsFromStorage.values()][0];}};
}

test('906 games with 496 cached results finish in one continuous pass without visible tiles',async()=>{
 const f=fixture(906);for(let id=1;id<=496;id++)f.cache[id]=false;
 await f.step();assert.equal(f.requests.length,410);assert.ok(f.requests.every(ids=>ids.length===1));
 assert.equal(new Set(f.requests.flat()).size,410);assert.equal(f.manager.progress.checked,906);
 assert.equal(f.creations,1);assert.equal(f.manager.progress.phase,'done');
 assert.equal([...f.timers.values()][0].ms,900000);
 assert.doesNotMatch(f.manager.status,/keresés a háttérben folytatódik/);
 await f.step();assert.equal(f.requests.length,410);assert.equal(f.saved.length,1);
});

test('restart restores deferred games while new games are checked immediately',async()=>{
 const f=fixture(5),now=Date.now()/1000;
 f.deps.cached=async()=>({success:true,hungarian:{'1':true},curator_status:'cached',scan_epoch:1,
  scan_attempts:{'2':now-10,'3':now-10},scan_retry_after:{'2':now+800,'3':now+800}});
 await f.step();assert.deepEqual(f.requests.flat(),['4','5']);
 assert.equal(f.manager.progress.processed,5);assert.equal(f.manager.progress.checked,3);
 assert.ok([...f.timers.values()][0].ms>790000);
 assert.match(f.manager.status,/hiányzó adatokat később/);
});

test('four workers refill individual free slots without waiting for the slowest request',async()=>{
 const f=fixture(8),resolvers=new Map();let active=0,maximum=0;
 f.apps[0].display_name='Satisfactory';
 f.deps.lookup=ids=>{f.requests.push([...ids]);active++;maximum=Math.max(maximum,active);return new Promise(resolve=>resolvers.set(ids[0],()=>{active--;f.cache[ids[0]]=true;resolve({success:true,hungarian:{[ids[0]]:true}});}));};
 const work=f.manager.tick();await f.drain();assert.equal(f.requests.length,4);assert.match(f.manager.progress.current,/Satisfactory/);
 resolvers.get('2')();await f.drain();assert.equal(f.requests.length,5);assert.equal(f.manager.progress.checked,1);
 assert.equal(f.manager.progress.processed,1);assert.match(f.manager.progress.current,/Satisfactory/);
 for(const id of ['3','4','5','6','7','8','1']){resolvers.get(id)();await f.drain();}
 await work;assert.equal(maximum,4);assert.equal(f.manager.progress.checked,8);assert.equal(f.collection.apps.size,8);
});

test('cached curator matches are saved before requests and unknown values preserve members',async()=>{
 const f=fixture();Object.assign(f.cache,{'1':true,'2':false,'3':null,'4':false,'5':null});
 await f.step();assert.equal(f.requests.length,0);assert.ok(f.collection.apps.has(1));
 f.cache['1']=null;f.cache['3']=true;await f.step();assert.deepEqual([...f.collection.apps],[1,3]);
 f.cache['1']=false;await f.step();assert.deepEqual([...f.collection.apps],[3]);
});

test('unavailable games do not block the queue and count separately from known language data',async()=>{
 const f=fixture(906);for(let id=1;id<=496;id++)f.cache[id]=false;
 f.deps.lookup=async ids=>{f.requests.push([...ids]);return {success:true,unavailable:ids,hungarian:{[ids[0]]:null}};};
 await f.step();assert.equal(f.requests.length,410);assert.equal(f.manager.progress.processed,906);
 assert.equal(f.manager.progress.checked,496);assert.equal(f.manager.progress.unknown,410);
 await f.step();assert.equal(f.requests.length,410);
});

for(const failure of ['timeout','rate_limit'])test(failure+' stops new work, drains in-flight requests and backs off',async()=>{
 const f=fixture(12);
 f.deps.lookup=async ids=>{f.requests.push([...ids]);if(failure==='timeout')throw Error('timeout');return {success:true,unavailable:ids,retry_after:120};};
 await f.step();assert.equal(f.requests.length,4);assert.equal(f.manager.progress.processed,4);
 const delay=[...f.timers.values()][0].ms;assert.ok(delay>=(failure==='timeout'?59000:119000));
 f.deps.lookup=async ids=>{f.requests.push([...ids]);return {success:true,hungarian:{[ids[0]]:true}};};
 await f.step();assert.equal(f.requests[4][0],'5');assert.equal(f.manager.progress.checked,8);
});

test('disable or account switch during lookup discards late results and prevents further requests',async()=>{
 for(const change of ['disable','account']){
  const f=fixture(20),finish=[];f.deps.lookup=ids=>{f.requests.push([...ids]);return new Promise(resolve=>finish.push(()=>resolve({success:true,hungarian:{[ids[0]]:true}})));};
  const work=f.manager.tick();await f.drain();
  if(change==='disable')f.manager.setEnabled(false);else f.store.collectionsFromStorage=new Map();
  finish.forEach(fn=>fn());await work;assert.equal(f.requests.length,4);assert.equal(f.creations,0);
  if(change==='disable')assert.equal(f.timers.size,0);
 }
});

test('startup avoids userCollections and waits for initialized storage without requests',async()=>{
 const f=fixture(),storage=f.store.collectionsFromStorage;f.store.collectionsFromStorage=undefined;
 await f.step();assert.equal(f.requests.length,0);f.store.collectionsFromStorage=storage;
 await f.step();assert.equal(f.manager.progress.checked,5);
});

test('failed Save retries the existing unsaved collection without duplicates',async()=>{
 const f=fixture(),create=f.store.NewUnsavedCollection.bind(f.store);let attempts=0;
 f.store.NewUnsavedCollection=name=>{const c=create(name),save=c.Save;c.Save=async()=>{if(++attempts===1)throw Error('offline');await save();};return c;};
 await f.step();assert.equal(f.manager.progress.phase,'error');await f.step();assert.equal(f.creations,1);assert.equal(f.collection.apps.size,3);
});

test('shortcuts and non-game apps are excluded, curator loading is not final completion',async()=>{
 const f=fixture();f.apps.push({appid:2147483649},{appid:6,app_type:2},{appid:7,BIsModOrShortcut:()=>true});
 f.deps.cached=async()=>({success:true,hungarian:Object.fromEntries([1,2,3,4,5].map(id=>[id,null])),curator_status:'loading'});
 await f.step();assert.equal(f.requests.length,0);assert.equal(f.manager.progress.total,5);
 assert.equal(f.manager.progress.checked,0);assert.equal(f.manager.progress.processed,5);
 assert.equal(f.manager.progress.phase,'between');assert.equal([...f.timers.values()][0].ms,5000);
});
