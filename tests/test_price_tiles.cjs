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

test('featured game uses its outer card so the sibling Steam price is reachable',()=>{
 const outer={getBoundingClientRect:()=>({width:520,height:340,top:20,bottom:360,left:0,right:520}),
  querySelector:()=>({}),matches:()=>true,contains:()=>false};
 const link={closest:selector=>selector==='.home_area_spotlight'?outer:null,matches:()=>true,
  getAttribute:key=>key==='href'?'https://store.steampowered.com/app/10/':'',
  querySelector:()=>null,getBoundingClientRect:()=>({width:520,height:300,top:20,bottom:320,left:0,right:520}),
  contains:()=>false};
 const context=vm.createContext({location:{href:'https://store.steampowered.com/'},URL,
  innerWidth:1280,innerHeight:800,document:{querySelectorAll:()=>[link]},
  getComputedStyle:()=>({visibility:'visible',backgroundImage:'none'})});
 vm.runInContext(tiles.storePriceTilesScript,context);
 const found=Array.from(context.collectPriceTiles());
 assert.equal(found.length,1);assert.equal(found[0].host,outer);assert.equal(found[0].id,'10');
});

test('DLC card uses its own wrapper when the Steam price is next to the image link',()=>{
 const tier={};
 const rect={width:420,height:240,top:480,bottom:720,left:100,right:520};
 const card={parentElement:tier,closest:selector=>selector==='#dlc_tier,.home_discounts_block.dlc_block'?tier:null,
  querySelector:selector=>selector==='.discount_block[data-price-final]'||selector.startsWith('img')?{}:null,
  matches:()=>true,getBoundingClientRect:()=>rect,contains:()=>false};
 const link={parentElement:card,closest:selector=>selector==='#dlc_tier,.home_discounts_block.dlc_block'?tier:null,
  querySelector:selector=>selector.startsWith('img')?{}:null,matches:()=>true,
  getAttribute:key=>key==='href'?'https://store.steampowered.com/app/2780810/':'',
  getBoundingClientRect:()=>({...rect,height:175,bottom:655}),contains:()=>false};
 const context=vm.createContext({location:{href:'https://store.steampowered.com/'},URL,
  innerWidth:1800,innerHeight:900,document:{querySelectorAll:()=>[link]},
  getComputedStyle:()=>({visibility:'visible',backgroundImage:'none'})});
 vm.runInContext(tiles.storePriceTilesScript,context);
 const found=Array.from(context.collectPriceTiles());
 assert.equal(found.length,1);assert.equal(found[0].host,card);assert.equal(found[0].id,'2780810');
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
