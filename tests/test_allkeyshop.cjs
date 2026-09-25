const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture() {
 const requests=[],scripts=[],exports={},cached=new Map(),remoteCached=new Map(),batchCalls=[],remoteBatchCalls=[];
 const clock={now:Date.now()};class ClockDate extends Date {static now(){return clock.now;}}
 const dock={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/storeBadgeDock.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:dock});
 const tiles={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/storePriceTiles.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:tiles,URL});
 const requireMock=name=>name==='./storePriceTiles'?tiles:name==='./storeBadgeDock'?dock:name==='@decky/api'?{callable:method=>id=>method==='get_cached_allkeyshop_prices'?(batchCalls.push(id),Promise.resolve({success:true,prices:Object.fromEntries(id.filter(key=>cached.has(key)).map(key=>[key,cached.get(key)]))})):method==='get_remote_price_previews'?(remoteBatchCalls.push(id),Promise.resolve({success:true,prices:Object.fromEntries(id.filter(key=>remoteCached.has(key)).map(key=>[key,remoteCached.get(key)]))})):new Promise(resolve=>requests.push({method,id,resolve}))}:{};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/AllKeyShop.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText,
  {exports,require:requireMock,setTimeout,clearTimeout,URL,Date:ClockDate});
 const send=async s=>{scripts.push(s);};
 const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 return {api:exports,requests,scripts,send,drain,clock,cached,remoteCached,batchCalls,remoteBatchCalls};
}
test('visible local and server cached prices hydrate in batches before individual lookups',async()=>{
 const f=fixture(),url='https://store.steampowered.com/';
 const entry=(price)=>({success:true,checked_at:f.clock.now/1000,offers:[{price,merchant:'Eneba'}]});
 f.cached.set('10',entry(4));f.cached.set('20',entry(5));f.remoteCached.set('30',entry(6));
 f.api.updatePriceView(url,f.send,['10','20','30']);await f.drain();
 assert.equal(f.batchCalls.length,1);assert.deepEqual(Array.from(f.batchCalls[0]),['10','20','30']);
 assert.equal(f.remoteBatchCalls.length,1);assert.deepEqual(Array.from(f.remoteBatchCalls[0]),['30']);
 assert.equal(f.requests.length,0);
 assert.equal(f.api.visiblePrice('10').offers[0].price,4);
 assert.equal(f.api.visiblePrice('30').offers[0].price,6);
});
test('price lookup only on opened Steam games, single flight, cached, navigation-safe',async()=>{
 const f=fixture();f.api.updatePriceView('https://store.steampowered.com/',f.send);await f.drain();assert.equal(f.requests.length,0);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);await f.drain();
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);await f.drain();assert.equal(f.requests.length,1);
 f.api.updatePriceView('https://store.steampowered.com/app/20/',f.send);await f.drain();
 const before=f.scripts.length;f.requests[0].resolve({success:true,offers:[]});await f.drain();assert.equal(f.scripts.length,before);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);await f.drain();assert.equal(f.requests.length,1);
 f.api.updatePriceView('https://store.steampowered.com/app/20/',f.send);await f.drain();assert.equal(f.requests.length,2);
 f.api.resetPriceView();const end=f.scripts.length;f.requests[1].resolve({success:true,offers:[]});await f.drain();assert.equal(f.scripts.length,end);
});
test('price renderer serializes untrusted text and guards page identity',()=>{
 const f=fixture(),script=f.api.buildPricePanelScript('10',{success:true,offers:[{merchant:'</script><img onerror=alert(1)>',price:2,kind:'Steam Gift',edition:'Standard',coupon:''}]});
 assert.doesNotMatch(script,/<img/);assert.match(script,/textContent/);assert.match(script,/pageId !== appId/);assert.doesNotMatch(script,/innerHTML/);
});

test('wishlist price stays below the row regardless of Steam price placement',()=>{
 const f=fixture(),url='https://store.steampowered.com/wishlist/';
 const cover={left:10,top:20,right:150,bottom:120,width:140,height:100,getBoundingClientRect(){return this;}};
 const card={left:10,top:20,right:310,bottom:170,width:300,height:150};
 function render(steamPrice) {
  const values=new Map(),style={cssText:'',getPropertyValue:key=>values.get(key)||'',getPropertyPriority:()=>'',
   setProperty:(key,value)=>values.set(key,value),removeProperty:key=>values.delete(key)};
  const host={style,offsetWidth:300,closest:selector=>selector.startsWith('.wishlist_row,')?host:null,matches:()=>true,contains:()=>false,
   getAttribute:key=>key==='href'?'https://store.steampowered.com/app/10/':'',
   getBoundingClientRect:()=>card,querySelector:selector=>selector.startsWith('img')?cover:null,
   querySelectorAll:selector=>selector.startsWith('img')?[cover]:selector.startsWith('.discount_block')?[{getBoundingClientRect:()=>steamPrice}]:[],
   appendChild(row){this.row=row;}};
  const context={location:{href:url},URL,innerWidth:1280,innerHeight:800,window:{},Date,
   document:{body:{},querySelectorAll:selector=>selector.startsWith('a[href')?[host]:[],
    createElement:()=>({style:{cssText:''},dataset:{}})},
   getComputedStyle:()=>({position:'static',visibility:'visible',backgroundImage:'none'}),setInterval,clearInterval};
  vm.runInNewContext(f.api.buildTilePricesScript(url,{'10':{success:true,offers:[{price:3.97,merchant:'Kinguin'}]}}),context);
  assert.equal(style.getPropertyValue('padding-bottom'),'');
  assert.equal(style.getPropertyValue('margin-bottom'),'32px');
  assert.equal(style.getPropertyValue('overflow'),'');
  assert.equal(host.row.textContent,'AKS: 3.97 € ∙ Kinguin');
  assert.match(host.row.style.cssText,/top:calc\(100% \+ 3px\);left:0;width:100%/);
  return host.row.style.cssText;
 }
 assert.match(render({left:210,right:290,top:140,bottom:165,width:80,height:25}),/top:calc\(100% \+ 3px\)/);
 assert.match(render({left:10,right:100,top:92,bottom:120,width:90,height:28}),/top:calc\(100% \+ 3px\)/);
});

test('home capsule price attaches below the whole card instead of its image link',()=>{
 const f=fixture(),url='https://store.steampowered.com/';
 const values=new Map(),style={getPropertyValue:key=>values.get(key)||'',getPropertyPriority:()=>'',
  setProperty:(key,value)=>values.set(key,value),removeProperty:key=>values.delete(key)};
 const card={style,offsetWidth:240,getBoundingClientRect:()=>({left:40,right:280,top:100,bottom:260,width:240,height:160}),
  appendChild(row){this.row=row;}};
 const link={closest:selector=>selector.startsWith('.wishlist_row,')?card:
  selector==='.home_special_offers_group'?{}:null,
  matches:()=>true,contains:()=>false,getAttribute:key=>key==='href'?'https://store.steampowered.com/app/10/':'',
  getBoundingClientRect:()=>({left:40,right:280,top:100,bottom:225,width:240,height:125}),
  querySelector:selector=>selector.startsWith('img')?{}:null};
 const context={location:{href:url,pathname:'/'},URL,innerWidth:1280,innerHeight:800,window:{},Date,
  document:{body:{},querySelectorAll:selector=>selector.startsWith('a[href')?[link]:[],
   createElement:()=>({style:{cssText:''},dataset:{}})},
  getComputedStyle:()=>({position:'static',visibility:'visible',backgroundImage:'none',overflow:'hidden',marginBottom:'0px'}),
  setInterval,clearInterval};
 vm.runInNewContext(f.api.buildTilePricesScript(url,{'10':{success:true,offers:[{price:4.5,merchant:'Eneba'}]}}),context);
 assert.equal(card.row.textContent,'AKS: 4.50 € ∙ Eneba');
 assert.match(card.row.style.cssText,/top:calc\(100% \+ 3px\);left:0;width:100%/);
 assert.equal(style.getPropertyValue('margin-bottom'),'32px');
 assert.equal(style.getPropertyValue('overflow'),'visible');
});

test('tab lists, featured cards and calendar wrappers keep the price below the card',()=>{
 const f=fixture(),url='https://store.steampowered.com/';
 for(const kind of ['tab','featured','calendar']) {
  const values=new Map(),style={getPropertyValue:key=>values.get(key)||'',getPropertyPriority:()=>'',
   setProperty:(key,value)=>values.set(key,value),removeProperty:key=>values.delete(key)};
  let link;
  const calendar={};
  const wrapper={style,offsetWidth:220,parentElement:kind==='calendar'?calendar:null,
   getBoundingClientRect:()=>({left:10,right:230,top:50,bottom:180,width:220,height:130}),
   querySelectorAll:()=>[link],querySelector:selector=>selector.startsWith('img')||
    (kind==='featured'&&selector.startsWith('.discount_block'))?{}:null,
   appendChild(row){this.row=row;}};
  link={style,offsetWidth:180,parentElement:wrapper,contains:()=>false,
   closest:selector=>kind==='tab'&&selector.includes('.tab_row_item')?link:
    kind==='calendar'&&selector==='.personal_calendar_ctn'?calendar:null,
   matches:()=>true,getAttribute:key=>key==='href'?'https://store.steampowered.com/app/10/':'',
   getBoundingClientRect:()=>({left:10,right:190,top:50,bottom:140,width:180,height:90}),
   querySelectorAll:()=>[],querySelector:selector=>selector.startsWith('img')?{}:null,
   appendChild(row){this.row=row;}};
  const context={location:{href:url,pathname:'/'},URL,innerWidth:1280,innerHeight:800,window:{},Date,
   document:{body:{},querySelectorAll:selector=>selector.startsWith('a[href')?[link]:[],
    createElement:()=>({style:{cssText:''},dataset:{}})},
   getComputedStyle:()=>({position:'static',visibility:'visible',backgroundImage:'none',overflow:'visible',marginBottom:'0px'}),
   setInterval,clearInterval};
  vm.runInNewContext(f.api.buildTilePricesScript(url,{'10':{success:true,offers:[{price:4.5,merchant:'Eneba'}]}}),context);
  const card=kind==='tab'?link:wrapper;
  assert.equal(card.row.textContent,'AKS: 4.50 € ∙ Eneba');
  assert.match(card.row.style.cssText,/top:calc\(100% \+ 3px\)/);
  assert.equal(style.getPropertyValue('margin-bottom'),'32px');
 }
});

test('homepage featured price sits below its full card',()=>{
 const f=fixture(),url='https://store.steampowered.com/';
 const values=new Map(),style={cssText:'',getPropertyValue:key=>values.get(key)||'',getPropertyPriority:()=>'',
  setProperty:(key,value)=>values.set(key,value),removeProperty:key=>values.delete(key)};
 const card={left:1200,top:330,right:1738,bottom:668,width:538,height:338};
 const steam={left:1460,top:600,right:1738,bottom:666,width:278,height:66};
 const host={style,offsetWidth:538,closest:selector=>selector.startsWith('.wishlist_row,')?host:
  selector==='.home_area_spotlight'?host:null,
  matches:()=>true,contains:()=>false,getAttribute:key=>key==='href'?'https://store.steampowered.com/app/10/':'',
  getBoundingClientRect:()=>card,querySelector:selector=>selector==='.discount_block[data-price-final]'?{getBoundingClientRect:()=>steam}:null,
  querySelectorAll:()=>[],appendChild(row){this.row=row;}};
 const context={location:{href:url,pathname:'/'},URL,innerWidth:1800,innerHeight:900,window:{},Date,
  document:{body:{},querySelectorAll:selector=>selector.startsWith('a[href')?[host]:[],
   createElement:()=>({style:{cssText:''},dataset:{}})},
  getComputedStyle:()=>({position:'static',visibility:'visible',backgroundImage:'none'}),setInterval,clearInterval};
 vm.runInNewContext(f.api.buildTilePricesScript(url,{'10':{success:true,offers:[{price:3.97,merchant:'Kinguin'}]}}),context);
 assert.equal(host.row.textContent,'AKS: 3.97 € ∙ Kinguin');
 assert.match(host.row.style.cssText,/top:calc\(100% \+ 3px\);left:0;width:100%/);
 assert.equal(style.getPropertyValue('padding-bottom'),'');
 assert.equal(style.getPropertyValue('margin-bottom'),'32px');
});

test('home DLC tile price stays below the entire card while Steam price loads and page scrolls',()=>{
 const f=fixture(),url='https://store.steampowered.com/';
 let layoutWrites=0,appends=0;
 const values=new Map(),style={cssText:'',getPropertyValue:key=>values.get(key)||'',getPropertyPriority:()=>'',
  setProperty:(key,value)=>{layoutWrites++;values.set(key,value);},removeProperty:key=>{layoutWrites++;values.delete(key);}};
 const card={left:100,top:480,right:520,bottom:720,width:420,height:240};
 const image={left:100,top:480,right:520,bottom:655,width:420,height:175,getBoundingClientRect(){return this;}};
 let steam=null;
 let scroll=0;
 const section={getBoundingClientRect:()=>({top:350-scroll,bottom:755-scroll}),
  querySelector:()=>({getBoundingClientRect:()=>({bottom:475-scroll})})};
 const host={style,offsetWidth:420,closest:selector=>selector.startsWith('.wishlist_row,')?host:
  selector==='#dlc_tier,.home_discounts_block.dlc_block'?section:
  selector==='.home_discounts_block.dlc_block'?section:null,matches:()=>true,contains:()=>false,
  getAttribute:key=>key==='href'?'https://store.steampowered.com/app/2780810/':'',
  getBoundingClientRect:()=>card,querySelector:selector=>selector==='.discount_block[data-price-final]'&&steam?
   {getBoundingClientRect:()=>steam}:selector.startsWith('img')?image:null,
  querySelectorAll:selector=>selector.startsWith('img')?[image]:[],appendChild(row){appends++;this.row=row;}};
 const context={location:{href:url,pathname:'/'},URL,innerWidth:1800,innerHeight:900,window:{},Date,
  document:{body:{},querySelectorAll:selector=>selector.startsWith('a[href')?[host]:[],
   createElement:()=>({style:{cssText:''},dataset:{}})},
  getComputedStyle:()=>({position:'static',visibility:'visible',backgroundImage:'none',overflow:'hidden'}),
  setInterval,clearInterval};
 vm.runInNewContext(f.api.buildTilePricesScript(url,{'2780810':{success:true,
  offers:[{price:16.1,merchant:'Kinguin'}]}}),context);
 assert.equal(host.row.textContent,'AKS: 16.10 € ∙ Kinguin');
 assert.match(host.row.style.cssText,/top:calc\(100% \+ 3px\);left:0;width:100%/);
 assert.equal(style.getPropertyValue('overflow'),'visible');
 assert.equal(style.getPropertyValue('margin-bottom'),'32px');
 assert.equal(style.getPropertyValue('padding-bottom'),'');
 const firstRow=host.row,firstLayoutWrites=layoutWrites;
 steam={left:250,top:665,right:520,bottom:720,width:270,height:55};
 scroll=100;card.top-=scroll;card.bottom-=scroll;image.top-=scroll;image.bottom-=scroll;
 vm.runInNewContext(f.api.buildTilePricesScript(url,{'2780810':{success:true,
  offers:[{price:16.1,merchant:'Kinguin'}]}}),context);
 assert.match(host.row.style.cssText,/top:calc\(100% \+ 3px\);left:0;width:100%/);
 assert.equal(host.row,firstRow);
 assert.equal(appends,1);
 assert.equal(layoutWrites,firstLayoutWrites);
});

test('tile prices require explicit visible IDs, share cache and stop when disabled',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/';
 f.api.updatePriceView(url,f.send);await f.drain();assert.equal(f.requests.length,0);
 f.api.updatePriceView(url,f.send,['10','10','20']);await f.drain();assert.equal(f.requests.length,1);assert.equal(f.requests[0].id,'10');
 f.api.updatePriceView(url,f.send,['10','20']);await f.drain();assert.equal(f.requests.length,1);
 f.requests[0].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView(url,f.send,['10','20']);await f.drain();assert.equal(f.requests.length,2);assert.equal(f.requests[1].id,'20');
 f.api.updatePriceView(url,f.send);await f.drain();const before=f.scripts.length;
 f.requests[1].resolve({success:true,offers:[]});await f.drain();assert.equal(f.scripts.length,before);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);await f.drain();assert.equal(f.requests.length,2);
 f.api.updatePriceView('https://example.com/',f.send,['30']);await f.drain();assert.equal(f.requests.length,2);
});

test('service failure reaches all waiting tiles, pauses requests and recovers after cooldown',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/',ids=['10','20','30'];
 f.api.updatePriceView(url,f.send,ids);await f.drain();
 f.requests[0].resolve({success:false,error:'Connection timed out',error_code:'connection',global_error:true,retry_after:15});await f.drain();
 for(let i=0;i<3;i++)f.api.updatePriceView(url,f.send,ids);await f.drain();
 assert.equal(f.requests.length,1);
 const last=f.scripts.findLast(s=>s.includes('const values ='));
 assert.match(last,/"10":\{"success":false/);assert.match(last,/"30":\{"success":false/);
 f.api.updatePriceView('https://store.steampowered.com/app/20/',f.send,ids);await f.drain();
 assert.match(f.scripts.at(-1),/"error_code":"connection"/);assert.equal(f.requests.length,1);
 f.clock.now+=16000;f.api.updatePriceView(url,f.send,ids);await f.drain();assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView(url,f.send,ids);await f.drain();assert.equal(f.requests.length,3);
 f.requests[2].resolve({success:true,offers:[]});await f.drain();
});

test('countdown uses a fixed deadline, one timer, and stops after removal',()=>{
 const f=fixture();let now=1000,tick,started=0,cleared=0;
 const node={dataset:{dpbRetryAt:'16000',dpbLabel:'AKS: kapcsolati hiba'}};let nodes=[node];
 const context=vm.createContext({document:{querySelectorAll:()=>nodes},window:{},Date:{now:()=>now},setInterval:cb=>{tick=cb;started++;return 1},clearInterval:()=>cleared++});
 vm.runInContext(f.api.priceCountdownScript,context);assert.match(node.textContent,/15 mp/);
 now+=2000;tick();assert.match(node.textContent,/13 mp/);
 vm.runInContext(f.api.priceCountdownScript,context);assert.equal(started,1);assert.match(node.textContent,/13 mp/);
 now=16000;tick();assert.match(node.textContent,/újrapróbálkozás/);
 nodes=[];tick();assert.equal(cleared,1);assert.equal(context.window.__dpbPriceCountdown,undefined);
});

test('new tiles precede expired cached tiles and open game has priority',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/';
 f.api.updatePriceView(url,f.send,['10']);await f.drain();f.requests[0].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
 f.clock.now+=1200000;f.api.updatePriceView(url,f.send,['10']);await f.drain();assert.equal(f.requests.length,1);
 f.clock.now+=601000;f.api.updatePriceView(url,f.send,['10','20']);await f.drain();assert.equal(f.requests[1].id,'20');
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView('https://store.steampowered.com/app/30/',f.send,['10','40']);await f.drain();assert.equal(f.requests[2].id,'30');
 f.requests[2].resolve({success:true,offers:[]});await f.drain();
});

test('successful prices remain fresh for 24 hours and refresh only on reappearance',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/';
 f.api.updatePriceView(url,f.send,['10']);await f.drain();f.requests[0].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
 f.clock.now+=23*3600000;f.api.updatePriceView(url,f.send,[]);await f.drain();f.api.updatePriceView(url,f.send,['10']);await f.drain();assert.equal(f.requests.length,1);
 f.clock.now+=3601000;f.api.updatePriceView(url,f.send,['10']);await f.drain();assert.equal(f.requests.length,1);
 f.api.updatePriceView(url,f.send,[]);await f.drain();f.api.updatePriceView(url,f.send,['10']);await f.drain();assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
 f.api.updatePriceView(url,f.send,[]);await f.drain();f.api.updatePriceView(url,f.send,['10']);await f.drain();assert.equal(f.requests.length,2);
});

test('home and wishlist use the shared visible queue without starving cards after the fourth',async()=>{
 for(const path of ['/', '/?l=hungarian', '/home/', '/index.php', '/wishlist/id/example/', '/wishlist/profiles/76561198000000000/']) {
  const f=fixture(), url='https://store.steampowered.com'+path, ids=['10','20','30','40','50','60','70'];
  for(let i=0;i<ids.length;i++) {
   f.api.updatePriceView(url,f.send,ids);await f.drain();
   assert.equal(f.requests.length,i+1);assert.equal(f.requests[i].id,ids[i]);
   f.api.updatePriceView(url,f.send,ids);await f.drain();assert.equal(f.requests.length,i+1);
   f.requests[i].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
  }
  f.api.updatePriceView('https://store.steampowered.com/wishlist/',f.send,ids);await f.drain();
  assert.equal(f.requests.length,ids.length,'fresh cache reused between Store pages');
 }
 const f=fixture();f.api.updatePriceView('https://store.steampowered.com/',f.send,['10','20']);await f.drain();
 f.api.updatePriceView('https://example.com/',f.send,['20']);await f.drain();
 f.requests[0].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView('https://example.com/',f.send,['20']);await f.drain();assert.equal(f.requests.length,1);
});

test('backend cooldown above one minute is respected without premature retries',async()=>{
 const f=fixture(), url='https://store.steampowered.com/app/10/';
 f.api.updatePriceView(url,f.send);await f.drain();
 f.requests[0].resolve({success:false,error_code:'connection',global_error:true,retry_after:240});await f.drain();
 f.clock.now+=61000;f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,1);
 const script=f.scripts.at(-1);
 assert.ok(script.includes(String(f.clock.now+179000)));
 f.clock.now+=180000;f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
});

test('persistent cached price renders before a slow refresh and fresh cache avoids requests',async()=>{
 const f=fixture(),url='https://store.steampowered.com/app/10/';
 f.cached.set('10',{success:true,stale:true,checked_at:(f.clock.now-86401000)/1000,offers:[{price:4,merchant:'Saved',kind:'Steam key',edition:'Standard',coupon:''}]});
 f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,1);
 assert.ok(f.scripts.some(s=>s.includes('"merchant":"Saved"')));
 f.requests[0].resolve({success:false,global_error:true,retry_after:30,error:'offline'});await f.drain();
 assert.ok(f.scripts.at(-1).includes('"merchant":"Saved"'));
 f.api.resetPriceView();
 f.cached.set('10',{success:true,stale:false,checked_at:f.clock.now/1000,offers:[]});
 f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,1);
});

test('server-requested cooldown is not shortened to the client five-minute limit',async()=>{
 const f=fixture(),url='https://store.steampowered.com/app/10/';
 f.api.updatePriceView(url,f.send);await f.drain();
 f.requests[0].resolve({success:false,error_code:'rate_limit',global_error:true,retry_after:600});await f.drain();
 f.clock.now+=301000;f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,1);
 f.clock.now+=300000;f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
});


test('remote pending stale price is displayed and polled only after its retry delay',async()=>{
 const f=fixture(),url='https://store.steampowered.com/app/10/';
 const old={success:true,stale:true,checked_at:f.clock.now/1000-86401,offers:[{merchant:'Eneba',price:3,kind:'Steam',edition:'Standard',coupon:''}]};
 f.cached.set('10',old);
 f.api.updatePriceView(url,f.send);await f.drain();
 assert.equal(f.requests.length,1);
 f.requests[0].resolve({...old,pending:true,retry_after:4});await f.drain();
 f.clock.now+=3000;f.api.updatePriceView(url,f.send);await f.drain();assert.equal(f.requests.length,1);
 f.clock.now+=1001;f.api.updatePriceView(url,f.send);await f.drain();assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,checked_at:f.clock.now/1000,offers:[{merchant:'Eneba',price:2,kind:'Steam',edition:'Standard',coupon:''}]});await f.drain();
 f.clock.now+=5000;f.api.updatePriceView(url,f.send);await f.drain();assert.equal(f.requests.length,2);
 assert.match(f.scripts.at(-1),/"price":2/);
});

test('remote pending result stops polling when the game page is closed',async()=>{
 const f=fixture(),url='https://store.steampowered.com/app/10/';
 f.api.updatePriceView(url,f.send);await f.drain();
 f.requests[0].resolve({success:false,pending:true,error_code:'pending',retry_after:3});await f.drain();
 f.clock.now+=4000;f.api.updatePriceView('https://store.steampowered.com/',f.send);await f.drain();
 assert.equal(f.requests.length,1);
});
