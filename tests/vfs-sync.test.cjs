const {test}=require('node:test');const assert=require('node:assert/strict');const Module=require('module');
const load=Module._load;
const stub={Disposable:class{},ThemeIcon:class{},l10n:{t:s=>s},workspace:{getConfiguration:()=>({get:(k,d)=>d}),textDocuments:[]},FileChangeType:{Changed:1}};
Module._load=function(id,...a){if(id==='vscode')return stub;if(id==='../collaboration/clientManager'||id==='../scm/scmCollectionProvider')return {};return load.call(this,id,...a);};
const {VirtualFileSystem}=require('../out/core/remoteFileSystemProvider');const {digest}=require('../out/scm/safeSyncEngine');Module._load=load;
function fixture(){
 const server={text:'旧云端 😀',version:0,reads:0,writes:0};const doc={_id:'doc',name:'main.tex',version:0,remoteCache:'FAKE CACHE',localCache:'FAKE CACHE'};
 const vfs=Object.create(VirtualFileSystem.prototype);
 Object.assign(vfs,{notify:()=>{},socket:{isUsingAlternativeConnectionScheme:false,joinDoc:async()=>{server.reads++;return {docLines:server.text.split('\n'),version:server.version};},applyOtUpdate:async(id,u)=>{
  assert.equal(u.v,server.version);for(const op of u.op){if(op.d!==undefined){assert.equal(server.text.slice(op.p,op.p+op.d.length),op.d);server.text=server.text.slice(0,op.p)+server.text.slice(op.p+op.d.length);}if(op.i!==undefined)server.text=server.text.slice(0,op.p)+op.i+server.text.slice(op.p);}
  server.version++;server.writes++;
 }},_resolveUri:async()=>({fileType:'doc',fileEntity:doc})});return {vfs,server,doc};
}
test('VFS sync read bypasses optimistic caches and always asks server',async()=>{
 const {vfs,server}=fixture();assert.equal(Buffer.from(await vfs.readFileForSync({})).toString(),server.text);assert.equal(server.reads,1);
 server.text='server changed';assert.equal(Buffer.from(await vfs.readFileForSync({})).toString(),'server changed');assert.equal(server.reads,2);
});
test('exact OT adapter round-trips Chinese, emoji, math and newlines',async()=>{
 const {vfs,server}=fixture();for(const text of ['% 中文公式 αβγ 😀\n\\section{测试}\n','% 新进度\n','']){
  await vfs.writeFileForSync({},Buffer.from(text),digest(Buffer.from(server.text)));assert.equal(server.text,text);assert.equal(Buffer.from(await vfs.readFileForSync({})).toString(),text);
 }
});
test('VFS adapter refuses a changed remote baseline',async()=>{
 const {vfs,server}=fixture();await assert.rejects(()=>vfs.writeFileForSync({},Buffer.from('new'),'0'.repeat(64)),/Remote changed/);assert.equal(server.writes,0);
});
test('remote cache mutation between preflight and OT is rejected',async()=>{
 const {vfs,doc,server}=fixture();let count=0;vfs._resolveUri=async()=>{if(++count===2){doc.remoteCache='concurrent edit';doc.version++;}return {fileType:'doc',fileEntity:doc};};
 await assert.rejects(()=>vfs.writeFileForSync({},Buffer.from('mine'),digest(Buffer.from(server.text))),/Remote changed/);assert.equal(server.writes,0);
});
test('Invisible Mode cannot falsely confirm a buffered upload',async()=>{
 const {vfs}=fixture();vfs.socket.isUsingAlternativeConnectionScheme=true;await assert.rejects(()=>vfs.readFileForSync({}),/Invisible/);
});
