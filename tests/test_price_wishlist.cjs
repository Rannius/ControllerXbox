const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function moduleFixture(){
 const exports={},clock={now:100000};class ClockDate extends Date {static now(){return clock.now;}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/priceWishlist.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Date:ClockDate});
 return {api:exports,clock,drain:async()=>{for(let i=0;i<20;i++)await Promise.resolve();}};
}
test('wishlist uses the complete authenticated list, caches it, and excludes logged-out users',async()=>{
 const f=moduleFixture(),all=Array.from({length:906},(_,i)=>i+1);let calls=0;
 const context={location:{hostname:'store.steampowered.com'},document:{getElementById:()=>({getAttribute:()=>'{"logged_in":true}'})},window:{g_AccountID:39734273},AbortController,setTimeout,clearTimeout,
 fetch:async (url,options)=>{calls++;assert.equal(options.credentials,'same-origin');return {ok:true,json:async()=>({rgWishlist:all})};}};
 const result=await vm.runInNewContext(f.api.wishlistScript('',false),context);
 assert.equal(result.ids.length,906);assert.equal(result.owner,'76561198000000001');assert.equal(calls,1);
 const cached=await vm.runInNewContext(f.api.wishlistScript(result.owner,true),context);
 assert.equal(cached.ids,undefined);assert.equal(calls,1);
 context.document={getElementById:()=>({getAttribute:()=>'{"logged_in":false}'})};
 const loggedOut=await vm.runInNewContext(f.api.wishlistScript(result.owner,true),context);
 assert.equal(loggedOut.owner,'');assert.equal(loggedOut.ids.length,0);assert.equal(calls,1);
});
test('wishlist heartbeat refreshes membership every five minutes, stops and rejects late snapshots',async()=>{
 const f=moduleFixture(),synced=[],scripts=[];let response={owner:'76561198000000001',ids:['10','20']},enabled=true;
 const manager=new f.api.PriceWishlistSync({enabled:async()=>enabled,sync:async(...args)=>synced.push(args),error:()=>{}});
 const send=async script=>{scripts.push(script);return response;};
 manager.scan(send);await f.drain();assert.equal(synced.length,1);assert.equal(synced[0][1].length,2);
 manager.scan(send);await f.drain();assert.equal(synced.length,1);
 f.clock.now+=31000;response={owner:response.owner};manager.scan(send);await f.drain();assert.equal(synced.length,2);assert.equal(synced[1][1].length,2);
 assert.match(scripts.at(-1),/&& true/);
 f.clock.now+=301000;response={owner:'76561198000000002',ids:['30']};manager.scan(send);await f.drain();
 assert.match(scripts.at(-1),/&& false/);assert.equal(synced.at(-1)[1][0],'30');
 f.clock.now+=31000;let resolve;manager.scan(()=>new Promise(r=>{resolve=r;}));await f.drain();
 manager.stop();resolve({owner:'76561198000000002',ids:['40']});await f.drain();assert.equal(synced.at(-1)[0],'');
 enabled=false;manager.scan(send);await f.drain();assert.equal(synced.at(-1)[0],'');
});
