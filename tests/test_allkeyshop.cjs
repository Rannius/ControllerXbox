const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture() {
 const requests=[],scripts=[],exports={};
 const clock={now:Date.now()};class ClockDate extends Date {static now(){return clock.now;}}
 const dock={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/storeBadgeDock.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:dock});
 const tiles={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/storePriceTiles.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:tiles,URL});
 const requireMock=name=>name==='./storePriceTiles'?tiles:name==='./storeBadgeDock'?dock:name==='@decky/api'?{callable:method=>id=>new Promise(resolve=>requests.push({method,id,resolve}))}:{};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/AllKeyShop.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText,
  {exports,require:requireMock,setTimeout,clearTimeout,URL,Date:ClockDate});
 const send=async s=>{scripts.push(s);};
 const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 return {api:exports,requests,scripts,send,drain,clock};
}
test('price lookup only on opened Steam games, single flight, cached, navigation-safe',async()=>{
 const f=fixture();f.api.updatePriceView('https://store.steampowered.com/',f.send);assert.equal(f.requests.length,0);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);assert.equal(f.requests.length,1);
 f.api.updatePriceView('https://store.steampowered.com/app/20/',f.send);
 const before=f.scripts.length;f.requests[0].resolve({success:true,offers:[]});await f.drain();assert.equal(f.scripts.length,before);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);assert.equal(f.requests.length,1);
 f.api.updatePriceView('https://store.steampowered.com/app/20/',f.send);assert.equal(f.requests.length,2);
 f.api.resetPriceView();const end=f.scripts.length;f.requests[1].resolve({success:true,offers:[]});await f.drain();assert.equal(f.scripts.length,end);
});
test('price renderer serializes untrusted text and guards page identity',()=>{
 const f=fixture(),script=f.api.buildPricePanelScript('10',{success:true,offers:[{merchant:'</script><img onerror=alert(1)>',price:2,kind:'Steam Gift',edition:'Standard',coupon:''}]});
 assert.doesNotMatch(script,/<img/);assert.match(script,/textContent/);assert.match(script,/pageId !== appId/);assert.doesNotMatch(script,/innerHTML/);
});

test('tile prices require explicit visible IDs, share cache and stop when disabled',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/';
 f.api.updatePriceView(url,f.send);assert.equal(f.requests.length,0);
 f.api.updatePriceView(url,f.send,['10','10','20']);assert.equal(f.requests.length,1);assert.equal(f.requests[0].id,'10');
 f.api.updatePriceView(url,f.send,['10','20']);assert.equal(f.requests.length,1);
 f.requests[0].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView(url,f.send,['10','20']);assert.equal(f.requests.length,2);assert.equal(f.requests[1].id,'20');
 f.api.updatePriceView(url,f.send);const before=f.scripts.length;
 f.requests[1].resolve({success:true,offers:[]});await f.drain();assert.equal(f.scripts.length,before);
 f.api.updatePriceView('https://store.steampowered.com/app/10/',f.send);assert.equal(f.requests.length,2);
 f.api.updatePriceView('https://example.com/',f.send,['30']);assert.equal(f.requests.length,2);
});

test('service failure reaches all waiting tiles, pauses requests and recovers after cooldown',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/',ids=['10','20','30'];
 f.api.updatePriceView(url,f.send,ids);
 f.requests[0].resolve({success:false,error:'Connection timed out',error_code:'connection',global_error:true,retry_after:15});await f.drain();
 for(let i=0;i<3;i++)f.api.updatePriceView(url,f.send,ids);
 assert.equal(f.requests.length,1);
 const last=f.scripts.findLast(s=>s.includes('const values ='));
 assert.match(last,/"10":\{"success":false/);assert.match(last,/"30":\{"success":false/);
 f.api.updatePriceView('https://store.steampowered.com/app/20/',f.send,ids);
 assert.match(f.scripts.at(-1),/"error_code":"connection"/);assert.equal(f.requests.length,1);
 f.clock.now+=16000;f.api.updatePriceView(url,f.send,ids);assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView(url,f.send,ids);assert.equal(f.requests.length,3);
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
 f.api.updatePriceView(url,f.send,['10']);f.requests[0].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
 f.clock.now+=1200000;f.api.updatePriceView(url,f.send,['10']);assert.equal(f.requests.length,1);
 f.clock.now+=601000;f.api.updatePriceView(url,f.send,['10','20']);assert.equal(f.requests[1].id,'20');
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView('https://store.steampowered.com/app/30/',f.send,['10','40']);assert.equal(f.requests[2].id,'30');
 f.requests[2].resolve({success:true,offers:[]});await f.drain();
});

test('successful prices refresh only on reappearance after 30 minutes',async()=>{
 const f=fixture(),url='https://store.steampowered.com/search/';
 f.api.updatePriceView(url,f.send,['10']);f.requests[0].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
 f.clock.now+=1801000;f.api.updatePriceView(url,f.send,['10']);assert.equal(f.requests.length,1);
 f.api.updatePriceView(url,f.send,[]);f.api.updatePriceView(url,f.send,['10']);assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,checked_at:f.clock.now/1000,offers:[]});await f.drain();
 f.api.updatePriceView(url,f.send,[]);f.api.updatePriceView(url,f.send,['10']);assert.equal(f.requests.length,2);
});

test('store homepage never queues tile prices, including navigation from search',async()=>{
 const f=fixture();
 for(const path of ['/', '/?l=hungarian', '/home/', '/index.php']) {
  f.api.updatePriceView('https://store.steampowered.com'+path,f.send,['10','20']);
  assert.equal(f.requests.length,0);
 }
 f.api.updatePriceView('https://store.steampowered.com/search/',f.send,['10','20']);
 assert.equal(f.requests.length,1);
 f.api.updatePriceView('https://store.steampowered.com/',f.send,['10','20']);
 f.requests[0].resolve({success:true,offers:[]});await f.drain();
 f.api.updatePriceView('https://store.steampowered.com/',f.send,['10','20']);
 assert.equal(f.requests.length,1);
 assert.match(f.scripts.findLast(s=>s.includes('const values =')),/const values = \{\}/);
 f.api.updatePriceView('https://store.steampowered.com/app/30/',f.send);
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].id,'30');
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
});

test('backend cooldown above one minute is respected without premature retries',async()=>{
 const f=fixture(), url='https://store.steampowered.com/app/10/';
 f.api.updatePriceView(url,f.send);
 f.requests[0].resolve({success:false,error_code:'connection',global_error:true,retry_after:240});await f.drain();
 f.clock.now+=61000;f.api.updatePriceView(url,f.send);
 assert.equal(f.requests.length,1);
 const script=f.scripts.at(-1);
 assert.ok(script.includes(String(f.clock.now+179000)));
 f.clock.now+=180000;f.api.updatePriceView(url,f.send);
 assert.equal(f.requests.length,2);
 f.requests[1].resolve({success:true,offers:[]});await f.drain();
});
