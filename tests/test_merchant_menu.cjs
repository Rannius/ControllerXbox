const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
test('merchant menu loads checkboxes and saves an empty explicit allowlist',async()=>{
 const state=[],effects=[],calls=[];let cursor=0,initial=true;
 const react={useState:value=>{const i=cursor++;if(!(i in state))state[i]=typeof value==='function'?value():value;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useEffect:fn=>{if(initial)effects.push(fn);},
  createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),Fragment:'fragment'};
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/AllKeyShop.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText,
  {exports,React:react,require:name=>name==='react'?react:name==='@decky/ui'?{ButtonItem:'button',PanelSectionRow:'row',TextField:'input',ToggleField:'toggle'}:name==='@decky/api'?{callable:method=>(...args)=>new Promise(resolve=>calls.push({method,args,resolve}))}:{},setTimeout,clearTimeout});
 const render=()=>{cursor=0;const result=exports.AllKeyShopMerchants({onBack(){}});initial=false;return result;};
 const flatten=node=>node&&typeof node==='object'?[node,...node.children.flatMap(flatten)]:[];
 const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 render();effects.forEach(fn=>fn());
 const prefs={success:true,enabled:true,allow_gifts:true,restrict_merchants:false,merchants:[]};
 calls.find(c=>c.method==='get_price_preferences').resolve(prefs);
 calls.find(c=>c.method==='get_price_merchants').resolve({success:true,merchants:['Eneba','GAMIVO']});await drain();
 let nodes=flatten(render());assert.equal(nodes.filter(n=>n.type==='toggle'&&n.props.checked).length,2);
 nodes.find(n=>n.children.includes('Kijelölések törlése')).props.onClick();
 nodes=flatten(render());assert.equal(nodes.filter(n=>n.type==='toggle'&&n.props.checked).length,0);
 const saving=nodes.find(n=>n.type==='button'&&n.children[0]==='Kijelölések mentése (').props.onClick();
 calls.at(-1).resolve(prefs);await drain();
 const saved=calls.at(-1);assert.equal(saved.method,'set_price_preferences');
 assert.equal(saved.args[3],true);assert.equal(saved.args[2].length,0);
 saved.resolve({...prefs,restrict_merchants:true});await saving;
});
