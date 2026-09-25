const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const tiles={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/storePriceTiles.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:tiles,URL});

test('web scanner collects visible home/wishlist games and excludes bundles and offscreen cards',()=>{
 const card=(id,{top=0,bundle=false,wish=false}={})=>({
  closest:()=>bundle?{}:null,matches:s=>wish?!s.startsWith('a['):true,querySelector:s=>s.startsWith('a[')?null:{},
  getAttribute:key=>key==='href'&&!wish?'https://store.steampowered.com/app/'+id+'/':key==='data-app-id'&&wish?id:'',
  getBoundingClientRect:()=>({width:200,height:120,top,bottom:top+120,left:0,right:200}),contains:()=>false
 });
 const nodes=[card('10'),card('20',{wish:true}),card('30',{top:900}),card('40',{bundle:true})];
 const context=vm.createContext({location:{href:'https://store.steampowered.com/wishlist/'},URL,innerWidth:1280,innerHeight:800,
  document:{querySelectorAll:()=>nodes},getComputedStyle:()=>({visibility:'visible',backgroundImage:'none'})});
 vm.runInContext(tiles.storePriceTilesScript,context);
 assert.deepEqual(Array.from(context.collectPriceTiles(),x=>x.id),['10','20']);
 const source=fs.readFileSync('src/index.tsx','utf8');
 assert.match(source,/updatePriceView\(result\?\.url.*result\.tileIds/);
 assert.match(source,/tileIds, watchActions/);
});

test('native Store cards share one visible-only timer, hide skipped prices and clean up',()=>{
 const exports={},effects=[],refs=[],calls=[],observers=[];let tick,started=0,stopped=0,cleared=0;
 class Observer {constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.done=true;}}
 const results=new Map([['10',{success:true,offers:[{price:4.37,merchant:'Eneba'}]}],['20',{success:true,skipped:'unreleased'}]]);
 const context={exports,setInterval:fn=>{tick=fn;started++;return 1;},clearInterval:()=>stopped++,
  require:name=>name==='react'?{useRef:()=>{const r={current:null};refs.push(r);return r;},useEffect:fn=>effects.push(fn)}:
   {clearNativePriceView:()=>cleared++,nativePriceUrl:'native',updatePriceView:(url,send,ids)=>calls.push(ids),visiblePrice:id=>results.get(id)},
  React:{createElement:()=>({})}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/NativeTilePrice.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText,context);
 const nodes=[];
 for(const id of ['10','20']) {
  exports.NativeTilePrice({appId:id,enabled:true});
  const node={isConnected:true,style:{},ownerDocument:{defaultView:{innerHeight:800,innerWidth:1280,IntersectionObserver:Observer}},
   getBoundingClientRect:()=>({width:200,height:25,top:50,bottom:75,left:0,right:200})};
  refs.at(-1).current=node;nodes.push(node);
 }
 const cleanup=effects.map(fn=>fn());assert.equal(started,1);
 observers[0].fn([{isIntersecting:true}]);tick();
 assert.deepEqual(Array.from(calls.at(-1)),['10']);assert.equal(nodes[0].textContent,'AKS: 4.37 € ∙ Eneba');
 observers[1].fn([{isIntersecting:true}]);tick();assert.equal(nodes[1].style.visibility,'hidden');
 observers[0].fn([{isIntersecting:false}]);tick();assert.deepEqual(Array.from(calls.at(-1)),['20']);
 cleanup.forEach(fn=>fn());assert.equal(stopped,1);assert.equal(cleared,1);assert.ok(observers.every(o=>o.done));
});
