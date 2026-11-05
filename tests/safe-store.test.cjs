const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs/promises'),os=require('os'),path=require('path');
const {SafeSyncStore}=require('../out/scm/safeSyncStore');const {digest}=require('../out/scm/safeSyncEngine');
test('journal and revision survive restart, another live window cannot acquire lock',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-store-'));const a=new SafeSyncStore(root,'p'),b=new SafeSyncStore(root,'p');
 try{
  await a.lock();await assert.rejects(()=>b.lock(),/Another VS Code/);
  const data=Buffer.from('中文进度');const h=digest(data);await a.saveBlob(h,data);
  await a.save({version:1,project:'p',verified:{'/main.tex':h},pending:{}});await a.unlock();await b.lock();
  assert.equal((await b.load()).verified['/main.tex'],h);assert.equal(Buffer.from(await b.loadBlob(h)).toString(),'中文进度');await b.unlock();
 }finally{await a.unlock();await fs.rm(root,{recursive:true,force:true});}
});
test('corrupt journal fails closed instead of resetting baseline',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-store-'));const a=new SafeSyncStore(root,'p');
 try{await fs.writeFile(path.join(root,'journal.json'),'broken');await assert.rejects(()=>a.load());}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('foreign project journal and traversal are rejected',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-store-'));const a=new SafeSyncStore(root,'p');
 try{await a.save({version:1,project:'other',verified:{},pending:{}});await assert.rejects(()=>a.load(),/foreign/);assert.throws(()=>a.validatePath('/../secret'));}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
