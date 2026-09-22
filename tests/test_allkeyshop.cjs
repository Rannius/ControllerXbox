const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture() {
 const requests=[],scripts=[],exports={};
 const requireMock=name=>name==='@decky/api'?{callable:method=>id=>new Promise(resolve=>requests.push({method,id,resolve}))}:{};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/AllKeyShop.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText,
  {exports,require:requireMock,setTimeout,clearTimeout,URL});
 const send=async s=>{scripts.push(s);};
 const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 return {api:exports,requests,scripts,send,drain};
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
