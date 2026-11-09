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
test('idle reconnects release their transaction locks and exceptions do not leak ownership',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-reconnect-'));const a=new SafeSyncStore(root,'p'),b=new SafeSyncStore(root,'p');
 try{
  await a.withLock(async()=>{});await assert.rejects(()=>fs.stat(path.join(root,'lock.json')),/ENOENT/);
  await b.withLock(async()=>{});await assert.rejects(()=>a.withLock(async()=>{throw Error('network disconnected')}),/network disconnected/);
  await b.withLock(async()=>{});assert.equal(await fs.readdir(root).then(x=>x.includes('lock.json')),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('a new connection waits for an in-flight transaction rather than rejecting it as another window',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-overlap-'));const a=new SafeSyncStore(root,'p'),b=new SafeSyncStore(root,'p');let active=0;const waits=[];
 try{
  await Promise.all([a,b].map(store=>store.withLock(async()=>{assert.equal(active++,0);await new Promise(r=>setTimeout(r,40));active--},d=>waits.push(d))));
  assert.equal(active,0);assert(waits.some(x=>x.includes('operation is still in progress')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('reconnected engines reload the newest journal under lock without losing other verified files',async()=>{
 const {SafeSyncEngine}=require('../out/scm/safeSyncEngine');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-shared-journal-'));const data=Buffer.from('shared source'),hash=digest(data);
 const make=()=>{const store=new SafeSyncStore(root,'p'),journal={version:1,project:'p',verified:{},pending:{}};
  return new SafeSyncEngine(journal,{exclusive:op=>store.withLock(async()=>{Object.assign(journal,await store.load());return op()}),
   readLocal:async()=>data,readRemote:async()=>{await new Promise(r=>setTimeout(r,20));return data},writeRemote:async()=>assert.fail('already equal'),
   saveBlob:(h,d)=>store.saveBlob(h,d),loadBlob:h=>store.loadBlob(h),saveJournal:j=>store.save(j),ignored:()=>false,report:()=>{}});
 };
 try{const a=make(),b=make();await Promise.all([a.reconcile('/a.tex'),b.reconcile('/b.tex')]);
  const state=await new SafeSyncStore(root,'p').load();assert.deepEqual(state.verified,{'/a.tex':hash,'/b.tex':hash});assert.deepEqual(state.pending,{});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('dead extension PID is recovered without manual lock deletion',async()=>{
 const {spawnSync}=require('child_process');const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});const dead=Number(child.stdout);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-dead-owner-'));const store=new SafeSyncStore(root,'p');
 try{await fs.writeFile(path.join(root,'lock.json'),JSON.stringify({pid:dead,token:'dead'}));await store.withLock(async()=>{});}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Linux boot/start identity distinguishes reused PIDs from the original owner', {skip:process.platform!=='linux'},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-pid-reuse-'));const store=new SafeSyncStore(root,'p');
 try{await fs.writeFile(path.join(root,'lock.json'),JSON.stringify({pid:process.pid,token:'old',identity:'previous-boot:previous-start'}));
  await store.withLock(async()=>{const d=JSON.parse(await fs.readFile(path.join(root,'lock.json'),'utf8'));assert.notEqual(d.identity,'previous-boot:previous-start');assert.equal(d.scope,'operation')});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('independent extension processes serialize disk transactions and preserve each other journal entries',async()=>{
 const {spawn}=require('child_process');const root=await fs.mkdtemp(path.join(os.tmpdir(),'safe-real-processes-'));
 const worker=`const {SafeSyncStore}=require(process.argv[1]);const fs=require('fs/promises');const path=require('path');(async()=>{const store=new SafeSyncStore(process.argv[2],'p');await store.withLock(async()=>{const marker=path.join(process.argv[2],'writer-active');const handle=await fs.open(marker,'wx');try{const j=await store.load();await new Promise(r=>setTimeout(r,60));j.verified[process.argv[3]]='a'.repeat(64);await store.save(j)}finally{await handle.close();await fs.unlink(marker)}});await new Promise(r=>setTimeout(r,100))})().catch(e=>{console.error(e);process.exitCode=1});`;
 const launch=name=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',worker,require.resolve('../out/scm/safeSyncStore'),root,name]);let error='';c.stderr.on('data',d=>error+=d);c.on('error',reject);c.on('close',code=>code===0?resolve():reject(Error(error)))});
 try{await Promise.all([launch('/a.tex'),launch('/b.tex')]);let j=await new SafeSyncStore(root,'p').load();assert.deepEqual(Object.keys(j.verified).sort(),['/a.tex','/b.tex']);
  const dead=Number(require('child_process').spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout);
  await fs.writeFile(path.join(root,'lock.json'),JSON.stringify({pid:dead,token:'stale-before-two-reconnects'}));
  await Promise.all([launch('/c.tex'),launch('/d.tex')]);j=await new SafeSyncStore(root,'p').load();assert.deepEqual(Object.keys(j.verified).sort(),['/a.tex','/b.tex','/c.tex','/d.tex']);await assert.rejects(()=>fs.stat(path.join(root,'lock.json')),/ENOENT/);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
