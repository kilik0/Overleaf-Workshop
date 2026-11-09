const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SafeSyncEngine,digest} = require('../out/scm/safeSyncEngine');
const bytes = value => Buffer.from(value);
function fixture(options={}) {
 const local=new Map([['/main.tex',bytes(options.local ?? 'old')]]);
 const remote=new Map([['/main.tex',bytes(options.remote ?? 'old')]]);
 const blobs=new Map(), reports=[]; let writes=0, saved;
 const journal=options.journal || {version:1, project:'test', verified:{},pending:{}};
 const io={
  readLocal:async p=>local.get(p),readRemote:async p=>{if(options.offline)throw Error('offline');return remote.get(p);},
  writeRemote:async(p,data,expected)=>{writes++;assert.equal(remote.has(p)?digest(remote.get(p)):null,expected);if(options.silentFailure)return;if(options.editDuringUpload)local.set(p,bytes('newer'));remote.set(p,Buffer.from(data));if(options.ackLost)throw Error('ack timeout');},
  saveBlob:async(h,d)=>blobs.set(h,Buffer.from(d)),loadBlob:async h=>blobs.get(h),
  saveJournal:async j=>{saved=JSON.parse(JSON.stringify(j));},report:(...r)=>reports.push(r),
  ignored:p=>p.includes('/Tmp/')||p.endsWith('/Tmp')
 };
 const engine=new SafeSyncEngine(journal,io);
 return {engine,local,remote,blobs,reports,options,journal,io,get writes(){return writes;},get saved(){return saved;}};
}
test('first connection with stale cloud NEVER overwrites local or publishes silently',async()=>{
 const f=fixture({local:'my new progress',remote:'stale'});await f.engine.reconcile('/main.tex');
 assert.equal(f.local.get('/main.tex').toString(),'my new progress');assert.equal(f.writes,0);assert.equal(f.journal.pending['/main.tex'].phase,'conflict');
 assert(f.blobs.has(digest(bytes('my new progress'))));assert(f.blobs.has(digest(bytes('stale'))));
});
test('baseline advances only after authoritative remote verification',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.local.set('/main.tex',bytes('new'));await f.engine.reconcile('/main.tex');
 assert.equal(f.remote.get('/main.tex').toString(),'new');assert.equal(f.journal.verified['/main.tex'],digest(bytes('new')));assert.deepEqual(f.journal.pending,{});
});
test('successful ack but wrong server content stays error, never verified',async()=>{
 const f=fixture({silentFailure:true});await f.engine.reconcile('/main.tex');f.local.set('/main.tex',bytes('new'));await f.engine.reconcile('/main.tex');
 assert.equal(f.journal.pending['/main.tex'].phase,'error');assert.equal(f.journal.verified['/main.tex'],digest(bytes('old')));
 assert.equal(f.local.get('/main.tex').toString(),'new');
});
test('offline restart preserves unsent content and retries from durable journal',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.options.offline=true;f.local.set('/main.tex',bytes('offline edits'));await f.engine.reconcile('/main.tex');
 const j=JSON.parse(JSON.stringify(f.saved));assert.equal(j.pending['/main.tex'].phase,'error');
 f.options.offline=false;const restart=new SafeSyncEngine(j,f.io);await restart.reconcile('/main.tex');
 assert.equal(f.remote.get('/main.tex').toString(),'offline edits');assert.deepEqual(j.pending,{});
});
test('cloud changes never flow into clean or dirty local file',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.remote.set('/main.tex',bytes('cloud edit'));await f.engine.reconcile('/main.tex');
 assert.equal(f.local.get('/main.tex').toString(),'old');assert.equal(f.writes,0);assert.equal(f.journal.pending['/main.tex'].phase,'conflict');
});
test('explicit publish backs up both versions and verifies overwrite',async()=>{
 const f=fixture({local:'local progress',remote:'cloud'});await f.engine.reconcile('/main.tex');await f.engine.authorizeLocal('/main.tex');
 assert.equal(f.remote.get('/main.tex').toString(),'local progress');assert(f.blobs.has(digest(bytes('cloud'))));assert.deepEqual(f.journal.pending,{});
});
test('a newer save during upload remains queued, then uploads in order',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.options.editDuringUpload=true;f.local.set('/main.tex',bytes('first'));await f.engine.reconcile('/main.tex');
 assert.equal(f.journal.pending['/main.tex'].target,digest(bytes('newer')));f.options.editDuringUpload=false;await f.engine.reconcile('/main.tex');
 assert.equal(f.remote.get('/main.tex').toString(),'newer');
});
test('lost acknowledgement is reconciled without replaying successful write',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.local.set('/main.tex',bytes('new'));f.options.ackLost=true;await f.engine.reconcile('/main.tex');
 assert.equal(f.journal.pending['/main.tex'].phase,'error');await f.engine.reconcile('/main.tex');assert.equal(f.writes,1);assert.deepEqual(f.journal.pending,{});
});
test('missing local file never triggers remote deletion or resurrection',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.local.delete('/main.tex');await f.engine.reconcile('/main.tex');
 assert.equal(f.remote.get('/main.tex').toString(),'old');assert(!f.local.has('/main.tex'));assert.equal(f.journal.pending['/main.tex'].phase,'conflict');
});
test('Tmp excluded before any local/network access',async()=>{
 const f=fixture();f.io.readLocal=async()=>{throw Error('must not run');};await f.engine.reconcile('/Tmp/file');assert.equal(f.reports.length,0);
});
test('concurrent save requests serialize writes',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.local.set('/main.tex',bytes('new'));await Promise.all(Array.from({length:10},()=>f.engine.reconcile('/main.tex')));
 assert.equal(f.writes,1);assert.deepEqual(f.journal.pending,{});
});
test('remote changes during preflight reject overwrite',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.local.set('/main.tex',bytes('mine'));
 f.io.writeRemote=async()=>{f.remote.set('/main.tex',bytes('theirs'));throw Error('Remote changed before upload');};await f.engine.reconcile('/main.tex');
 assert.equal(f.local.get('/main.tex').toString(),'mine');assert.equal(f.journal.pending['/main.tex'].phase,'error');await f.engine.reconcile('/main.tex');assert.equal(f.journal.pending['/main.tex'].phase,'conflict');
});
test('new file is uploaded and verified',async()=>{
 const f=fixture();f.local.set('/new.tex',bytes('new file'));await f.engine.reconcile('/new.tex');assert.equal(f.remote.get('/new.tex').toString(),'new file');
});
test('corrupt revision store never allows upload',async()=>{
 const f=fixture();f.io.saveBlob=async()=>{throw Error('disk full');};await f.engine.reconcile('/main.tex');assert.equal(f.writes,0);assert(f.reports.some(r=>r[1]==='error'));
});
test('journal persistence failure cannot mark a revision as verified',async()=>{
 const f=fixture();await f.engine.reconcile('/main.tex');f.local.set('/main.tex',bytes('new'));
 const persist=f.io.saveJournal;f.io.saveJournal=async j=>{if(j.verified['/main.tex']===digest(bytes('new')))throw Error('disk full');return persist(j);};
 await f.engine.reconcile('/main.tex');assert.equal(f.journal.verified['/main.tex'],digest(bytes('old')));assert.equal(f.journal.pending['/main.tex'].phase,'error');
});
test('remote-only file is flagged without writing to local disk',async()=>{
 const f=fixture();f.remote.set('/remote.tex',bytes('cloud-only'));await f.engine.reconcile('/remote.tex');assert(!f.local.has('/remote.tex'));assert.equal(f.journal.pending['/remote.tex'].phase,'conflict');
});
test('explicit Accept Cloud backs up both versions before replacing local and advances baseline',async()=>{
 const f=fixture({local:'my work',remote:'cloud work'});await f.engine.reconcile('/main.tex');
 await f.engine.acceptRemote('/main.tex',async(data,expected)=>{
  assert.equal(expected,digest(bytes('my work')));assert(f.blobs.has(expected));assert(f.blobs.has(digest(data)));
  assert.equal(f.saved.pending['/main.tex'].error,'Accept Cloud requested; local/cloud backups saved.');
  f.local.set('/main.tex',Buffer.from(data));
 });
 assert.equal(f.local.get('/main.tex').toString(),'cloud work');assert.equal(f.writes,0);assert.deepEqual(f.journal.pending,{});
 await f.engine.reconcile('/main.tex');assert.equal(f.writes,0);
});
test('Accept Cloud refuses missing cloud and never deletes local',async()=>{
 const f=fixture();f.remote.clear();let called=false;
 await assert.rejects(()=>f.engine.acceptRemote('/main.tex',async()=>{called=true}),/Cloud file is absent/);
 assert.equal(called,false);assert.equal(f.local.get('/main.tex').toString(),'old');
});
test('Accept Cloud aborts when a newer local save arrives during snapshot',async()=>{
 const f=fixture({local:'my work',remote:'cloud'});const old=f.io.readRemote;
 f.io.readRemote=async p=>{f.local.set(p,bytes('newer'));return old(p)};
 await assert.rejects(()=>f.engine.acceptRemote('/main.tex',async()=>assert.fail('must not replace')),/Local file changed/);
 assert.equal(f.local.get('/main.tex').toString(),'newer');
});
test('Accept Cloud refuses changing cloud snapshots',async()=>{
 const f=fixture({remote:'cloud'});let n=0;f.io.readRemote=async()=>bytes('cloud '+(++n));
 await assert.rejects(()=>f.engine.acceptRemote('/main.tex',async()=>assert.fail('must not replace')),/Cloud changed/);
});
test('Accept Cloud supports remote-only file without automatic download',async()=>{
 const f=fixture();f.local.clear();await f.engine.reconcile('/main.tex');assert(!f.local.has('/main.tex'));
 await f.engine.acceptRemote('/main.tex',async(data,expected)=>{assert.equal(expected,null);f.local.set('/main.tex',data)});
 assert.equal(f.local.get('/main.tex').toString(),'old');assert.deepEqual(f.journal.pending,{});
});
test('lock contention is reported per file and a later retry can recover without resetting history',async()=>{
 const f=fixture();let busy=true;
 f.io.exclusive=async op=>{if(busy)throw Error('Sync lock busy: operation in progress');return op()};
 await f.engine.reconcile('/main.tex');assert.equal(f.reports.at(-1)[0],'/main.tex');assert.equal(f.reports.at(-1)[1],'error');assert.deepEqual(f.journal.pending,{});
 busy=false;await f.engine.reconcile('/main.tex');assert.equal(f.journal.verified['/main.tex'],digest(bytes('old')));assert.equal(f.writes,0);
});
