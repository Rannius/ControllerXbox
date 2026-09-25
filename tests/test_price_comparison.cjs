const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/AllKeyShop.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText,
 {exports:api,require:name=>name==='@decky/api'?{callable:()=>()=>{}}:{},setTimeout,clearTimeout,URL});
test('Steam EUR comparison uses final displayed price, never historical AKS Steam price',()=>{
 for(const [text,price] of [['-25% 9,75€ 7,31€',7.31],['13,99€',13.99],['1.234,56 EUR',1234.56],['9.75€7.31€',7.31],['$7.31',null],['2990 Ft',null],['',null]])assert.equal(api.readSteamEuroPrice(text),price);
 class Element {constructor(){this.style={};this.dataset={};this.children=[];}appendChild(n){this.children.push(n);}addEventListener(){}remove(){}insertAdjacentElement(where,node){this.panel=node;}}
 const anchor=new Element(),parent=new Element();anchor.parentElement=parent;
 const widget={textContent:'9,75€7,31€',parentElement:anchor,getBoundingClientRect:()=>({height:30}),closest:()=>null};
 const document={documentElement:{classList:{contains:()=>true}},getElementById:()=>null,querySelectorAll:s=>s==='.StoreSalePriceWidgetContainer'?[widget]:[],createElement:()=>new Element()};
 const script=api.buildPricePanelScript('400',{success:true,source:'aks_history',offers:[{merchant:'Kinguin',price:9,kind:'Steam Gift EU',edition:'Standard',coupon:''}]});
 vm.runInNewContext(script,{document,location:{pathname:'/app/400/'},getComputedStyle:()=>({flexDirection:'column'}),window:{},setInterval,clearInterval});
 assert.equal(anchor.panel.children[0].textContent,'AKS: 9.00 € ∙ Kinguin');
 assert.ok(anchor.panel.children[1].children.some(x=>x.textContent==='Steam: 7.31 € · itt olcsóbb'));
});
