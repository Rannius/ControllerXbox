const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

test('native Store home and web Store use Store size; navigating back restores Library size',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/index.tsx'),'utf8');
  let navigate;let signals=0;let connections=0;
  const history={location:{pathname:'/library'},listen:fn=>{navigate=fn;return ()=>{};}};
  const context=vm.createContext({
    nativeTilesInStore:false,storeMounted:false,supportListeners:new Set([()=>signals++]),
    findModuleExport:()=>({m_history:history}),window:{location:{pathname:'/library'}},
    renderStoreBadges:()=>{},connectToStoreDebugger:()=>connections++,disconnectStoreDebugger:()=>{},
    console,
    React:{createElement:(type,props,...children)=>({type,props,children})},
    useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useEffect:()=>{},
    badgeVisibility:{library_badge_percent:80,store_badge_percent:175},
    hungarianStates:new Map(),hungarianSources:new Map(),supportStates:new Map(),gfnStates:new Map(),boosteroidStates:new Map(),
    ControllerBadge:()=>null,GfnBadge:()=>null,BoosteroidBadge:()=>null,
  });
  const code=source.slice(source.indexOf('function XboxTileBadge('),source.indexOf('function LibraryDetailBadges('))
    +source.slice(source.indexOf('function patchSteamStore('),source.indexOf('function appendBadgeToTile('));
  vm.runInContext(ts.transpile(code,{target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}),context);
  const stop=context.patchSteamStore();
  const scale=()=>Number(context.XboxTileBadge({appId:1}).props.style.transform.match(/scale\((.*)\)/)[1]);
  assert.ok(Math.abs(scale()-.88*.8)<1e-9);
  navigate({location:{pathname:'/store'}});
  assert.equal(context.nativeTilesInStore,true);assert.equal(signals,1);
  assert.ok(Math.abs(scale()-.88*1.75)<1e-9);
  assert.equal(connections,0,'native home does not open the web Store debugger');
  navigate({pathname:'/steamweb'});
  assert.ok(Math.abs(scale()-.88*1.75)<1e-9);assert.equal(connections,1);
  navigate({pathname:'/library/home'});
  assert.ok(Math.abs(scale()-.88*.8)<1e-9);assert.equal(signals,2);
  navigate({pathname:'/storefront-unrelated'});
  assert.equal(context.nativeTilesInStore,false);
  stop();
});
