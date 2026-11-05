// Explicit opt-in integration test. Credentials are supplied on stdin, never logged or written.
const Module=require('module');const original=Module._load;
const {EventEmitter}=require('events');
class Disposable {constructor(fn){this.fn=fn;}dispose(){this.fn?.();}}
const stub={Disposable,ThemeIcon:class{constructor(id){this.id=id;}},l10n:{t:(s,args)=>s.replace(/\{(\w+)\}/g,(_,k)=>args?.[k]??k)},
 window:{showErrorMessage:async()=>undefined},workspace:{textDocuments:[],getConfiguration:()=>({get:(k,d)=>d})},FileChangeType:{Changed:1},FileSystemError:{FileNotFound:()=>Object.assign(Error('missing'),{code:'FileNotFound'})}};
Module._load=function(id,...args){if(id==='../collaboration/clientManager'||id==='../scm/scmCollectionProvider')return {};return id==='vscode'?stub:original.call(this,id,...args);};
const assert=require('assert/strict');const fs=require('fs');
const {BaseAPI}=require('../out/api/base');const {SocketIOAPI}=require('../out/api/socketio');
const {VirtualFileSystem}=require('../out/core/remoteFileSystemProvider');const {digest}=require('../out/scm/safeSyncEngine');
(async()=>{
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const api=new BaseAPI(input.url);const refreshed=await api.cookiesLogin(input.identity.cookies);if(refreshed.type!=='success')throw Error('Saved session is not usable for live test; '+refreshed.message);const identity=refreshed.identity;
 const name='Safe Sync Integration '+new Date().toISOString().replace(/[:.]/g,'-');
 const created=input.projectId?{type:'success',message:input.projectId}:await api.newProject(identity,name,'blank');
 if(created.type!=='success'||!created.message)throw Error('Scratch project creation failed: '+created.message);
 const projectId=created.message;console.log('SCRATCH_PROJECT',projectId,name);
 fs.writeFileSync('../live-test-project.json',JSON.stringify({projectId,name}));
 let socket,project;
 for(let attempt=0;attempt<3;attempt++){
  if(!socket)socket=new SocketIOAPI(input.url,api,identity,projectId);
  try{project=await socket.joinProject(projectId);break;}catch(e){console.log('JOIN_RETRY',String(e));socket.init();}
 }
 if(!project)throw Error('Cannot connect to scratch project');
 const bibText='@article{test,title={中文测试}}\n';
 const bib=await api.uploadFile(identity,projectId,project.rootFolder[0]._id,'safe-upload-'+Date.now()+'.bib',Buffer.from(bibText));
 assert.equal(bib.type,'success');assert.ok(bib.entity?._id);
 const bibRead=await socket.joinDoc(bib.entity._id);assert.equal(bibRead.docLines.join('\n'),bibText);console.log('VERIFIED_NEW_BIB_UPLOAD');
 const added=await api.addDoc(identity,projectId,project.rootFolder[0]._id,'safe-sync-'+Date.now()+'.tex');
 if(added.type!=='success'||!added.entity)throw Error('Could not create test document');
 const doc={...added.entity};fs.writeFileSync('../live-test-doc.json',JSON.stringify({projectId,docId:doc._id}));
 const vfs=Object.create(VirtualFileSystem.prototype);
 Object.assign(vfs,{socket,api,projectId,serverName:'www.overleaf.com',context:{},notify:()=>undefined});
 vfs._resolveUri=async()=>({fileType:'doc',fileEntity:doc});
 socket.socket.on('disconnect',()=>console.log('LIVE_SOCKET_DISCONNECTED'));const uri={};
 const initial=await vfs.readFileForSync(uri);assert.equal(initial.length,0);
 const contents=input.asciiOnly?['% first ASCII\n','% second ASCII version\n','% final ASCII\n']:['% local upload ASCII\n','% 中文公式 αβγ\n\\section{测试}\n','% 最终版本\n'];
 for(const content of contents){
  console.log('READ_BEFORE',content.length);const before=await vfs.readFileForSync(uri);console.log('WRITE',content.length,'base',before.length);await vfs.writeFileForSync(uri,Buffer.from(content),digest(before));console.log('READ_AFTER',content.length);
  const actual=await vfs.readFileForSync(uri);assert.equal(Buffer.from(actual).toString(),content);console.log('VERIFIED_UTF8',content.length);
 }
 // A deliberately wrong expected hash must prevent the write.
 await assert.rejects(()=>vfs.writeFileForSync(uri,Buffer.from('must not appear'),'0'.repeat(64)),/Remote changed/);
 assert.equal(Buffer.from(await vfs.readFileForSync(uri)).toString(),contents.at(-1));
 const finalHash=digest(Buffer.from(contents.at(-1)));
 await assert.rejects(()=>vfs.writeFileForSync(uri,Buffer.from('% 😀\n'),finalHash),/Unsupported non-BMP/);
 console.log('LIVE_PASS: server readback and stale-baseline rejection');socket.disconnect();process.exit(0);
})().catch(e=>{console.error('LIVE_FAIL',e?.stack||String(e));process.exit(1);});
