'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const rect={x:0,y:0,width:100,height:100};
const node=(selector,children=[])=>({selector,name:selector||'Anonymous pane',type:'Pane',isEnabled:true,...rect,children});
function fixture(elements) {
  const backend=new WinappBackend({supervisor:null,run:async()=>{throw Error('No OS calls');}});
  backend.command=async()=>({windows:[{hwnd:123,coordinateSpace:'physical-screen-pixels',elements}]});
  return backend.inspect({id:'123'});
}
test('hierarchy preserves selectorless parents, duplicate labels and original flat element order',async()=>{
  const first=node('first'),second=node('second'); first.name=second.name='Same label';
  const result=await fixture([node('root',[node(null,[first]),second])]);
  assert.deepEqual(result.elements.map(e=>e.id),['root','first','second']);
  assert.deepEqual(result.elements.map(e=>e.treeNodeId),['n0','n2','n3']);
  assert.deepEqual(result.hierarchy.map(n=>[n.nodeId,n.parentNodeId,n.elementId]),
    [['n0',null,'root'],['n1','n0',null],['n2','n1','first'],['n3','n0','second']]);
  assert.equal(result.hierarchy[2].nestingDepth,2); assert.equal(result.truncated,false);
});
test('truncation and forest roots are explicit and bounded names cannot swell hierarchy payload',async()=>{
  const branch=node(null); branch.hasMoreChildren=true; branch.name='x'.repeat(1000);
  const result=await fixture([node('root',[branch]),node('other')]);
  assert.equal(result.truncated,true); assert.equal(result.hierarchy[1].hasMoreChildren,true);
  assert.equal(result.hierarchy[1].name.length,512); assert.equal(result.hierarchy[2].parentNodeId,null);
});
test('cycles, malformed children and selectorless node/depth overflow fail boundedly',async()=>{
  const cycle=node('root');cycle.children=[cycle]; await assert.rejects(fixture([cycle]),{code:'invalid_native_response'});
  const bad=node('root');bad.children={};await assert.rejects(fixture([bad]),{code:'invalid_native_response'});
  await assert.rejects(fixture([node('root',Array.from({length:10000},()=>node(null)))]),{code:'native_output_limit'});
  let deep=node('leaf');for(let i=0;i<34;i++)deep=node(i===33?'root':null,[deep]);
  await assert.rejects(fixture([deep]),{code:'native_output_limit'});
});
