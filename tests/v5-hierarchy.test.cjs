'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const rect={x:0,y:0,width:100,height:100};
const node=(selector,children=[])=>({selector,name:selector||'Anonymous pane',type:'Pane',isEnabled:true,...rect,children});
function fixture(elements,options) {
  const backend=new WinappBackend({supervisor:null,run:async()=>{throw Error('No OS calls');}});
  backend.command=async()=>({windows:[{hwnd:123,coordinateSpace:'physical-screen-pixels',elements}]});
  return backend.inspect({id:'123'},undefined,8,options);
}
test('hierarchy preserves selectorless parents, duplicate labels and original flat element order',async()=>{
  const first=node('first'),second=node('second'); first.name=second.name='Same label';
  const result=await fixture([node('root',[node(null,[first]),second])]);
  assert.deepEqual(result.elements.map(e=>e.id),['root','first','second']);
  assert.deepEqual(result.elements.map(e=>[e.treeNodeId,e.parentNodeId]),[['n0',null],['n2','n1'],['n3','n0']]);
  // Selector-backed nodes are serialized once, as elements; hierarchy keeps only structure.
  assert.deepEqual(result.hierarchy,[{nodeId:'n1',parentNodeId:'n0',name:'Anonymous pane',controlType:'Pane'}]);
  assert.equal(result.truncated,false);
});
test('truncation and forest roots are explicit and bounded names cannot swell hierarchy payload',async()=>{
  const branch=node(null); branch.hasMoreChildren=true; branch.name='x'.repeat(1000);
  const result=await fixture([node('root',[branch]),node('other')]);
  assert.equal(result.truncated,true); assert.equal(result.hierarchy[0].hasMoreChildren,true);
  assert.equal(result.hierarchy[0].name.length,512); assert.equal(result.elements[1].parentNodeId,null);
});
test('cycles, malformed children and selectorless node/depth overflow fail boundedly',async()=>{
  const cycle=node('root');cycle.children=[cycle]; await assert.rejects(fixture([cycle]),{code:'invalid_native_response'});
  const bad=node('root');bad.children={};await assert.rejects(fixture([bad]),{code:'invalid_native_response'});
  await assert.rejects(fixture([node('root',Array.from({length:10000},()=>node(null)))]),{code:'native_output_limit'});
  let deep=node('leaf');for(let i=0;i<34;i++)deep=node(i===33?'root':null,[deep]);
  await assert.rejects(fixture([deep]),{code:'native_output_limit'});
});

const off=(n)=>Object.assign(n,{isOffscreen:true});
test('offscreen nodes are omitted by default, counted, and kept descendants attach to the nearest kept ancestor',async()=>{
  const tree=()=>[node('root',[off(node('tabs',[off(node('tab1')),node('visible')])),node('ok')])];
  const result=await fixture(tree());
  assert.deepEqual(result.elements.map(e=>[e.id,e.treeNodeId,e.parentNodeId]),[['root','n0',null],['visible','n1','n0'],['ok','n2','n0']]);
  assert.equal(result.offscreenOmitted,2); assert.equal(result.includeOffscreen,false);
  const all=await fixture(tree(),{includeOffscreen:true});
  assert.deepEqual(all.elements.map(e=>e.id),['root','tabs','tab1','visible','ok']);
  assert.equal(all.offscreenOmitted,0); assert.equal(all.elements[1].offscreen,true);
  const offRoot=await fixture([off(node('root',[node('a')]))]);
  assert.deepEqual(offRoot.elements.map(e=>e.id),['root','a']);
});
test('P0-1/P0-2 size bar: one serialization and no offscreen payload',async()=>{
  // 60 offscreen tab items, as in the incident's Notepad session-restore tree.
  const tabs=Array.from({length:60},(_,i)=>off(node('tab'+i)));
  const visible=Array.from({length:40},(_,i)=>node('ctl'+i));
  const result=await fixture([node('root',[node(null,tabs),...visible])]);
  assert.equal(result.elements.filter(e=>e.id.startsWith('tab')).length,0);
  const json=JSON.stringify({elements:result.elements,hierarchy:result.hierarchy});
  const legacy=JSON.stringify(result.elements.map(e=>({...e,parentNodeId:undefined})))
    +JSON.stringify(result.elements.map(e=>({nodeId:e.treeNodeId,parentNodeId:e.parentNodeId,elementId:e.id,name:e.name,controlType:e.controlType,nestingDepth:1,hasMoreChildren:false})));
  assert.ok(json.length<=legacy.length*0.7,`${json.length} vs ${legacy.length}`);
});
