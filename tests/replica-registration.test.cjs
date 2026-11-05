const {test}=require('node:test');const assert=require('node:assert/strict');
const {restoreReplicaRegistration:restore}=require('../out/scm/replicaRegistration');
const local={server:'overleaf',project:'project1',baseUri:'file:///home/user/paper'};
test('re-login that loses project SCM state restores current .overleaf association',()=>{
 const records={};assert.equal(restore(records,local,{server:'overleaf',project:'project1'},'Local Replica'),true);
 assert.equal(records[local.baseUri].enabled,true);assert.equal(records[local.baseUri].label,'Local Replica');
});
test('repeated startup is idempotent and preserves existing ignore patterns',()=>{
 const record={enabled:true,label:'Local Replica',baseUri:local.baseUri,settings:{'ignore-patterns':['**/Tmp/**']}};const records={[local.baseUri]:record};
 assert.equal(restore(records,local,{server:'overleaf',project:'project1'},'Local Replica'),false);assert.equal(records[local.baseUri],record);
});
test('disabled replica is not silently re-enabled',()=>{
 const records={[local.baseUri]:{enabled:false,label:'Local Replica',baseUri:local.baseUri,settings:{}}};restore(records,local,{server:'overleaf',project:'project1'},'Local Replica');assert.equal(records[local.baseUri].enabled,false);
});
test('a different project or server cannot claim the local replica',()=>{
 for(const active of [{server:'other',project:'project1'},{server:'overleaf',project:'other'}]){const records={};assert.equal(restore(records,local,active,'Local Replica'),false);assert.deepEqual(records,{});}
});
