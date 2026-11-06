const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('module');const load=Module._load;
let rows=[];const listeners=new Set();
class TreeItem{constructor(label,state){this.label=label;this.state=state}}
const stub={EventEmitter:class{event=()=>{};fire(){}dispose(){}},TreeItem,ThemeIcon:class{constructor(id){this.id=id}},TreeItemCollapsibleState:{Expanded:2,None:0}};
Module._load=function(id,...args){if(id==='vscode')return stub;if(id==='./localReplicaSCM')return {LocalReplicaSCMProvider:{changeListeners:listeners,listSyncFiles:()=>rows}};return load.call(this,id,...args)};
const {SafeSyncView}=require('../out/scm/safeSyncView');Module._load=load;
test('sync tree groups nested pending files and exposes full error and path',()=>{
 rows=[{root:'/replica',path:'/PQ/main.tex',phase:'conflict',detail:'cloud changed'},{root:'/replica',path:'/references.bib',phase:'error',detail:'HTTP 400'},{root:'/replica',path:'[runtime]',phase:'error',detail:'lock failed'}];
 const view=new SafeSyncView();const roots=view.getChildren();assert.equal(roots.length,1);
 const children=view.getChildren(roots[0]);const folder=children.find(n=>n.path==='/PQ');assert(folder.folder);
 const file=view.getChildren(folder)[0],item=view.getTreeItem(file);assert.match(item.tooltip,/\/PQ\/main.tex/);assert.match(item.tooltip,/cloud changed/);assert.equal(item.contextValue,'safeSyncFile');assert.equal(item.command.arguments[0].root,'/replica');
 const runtime=children.find(n=>n.path==='[runtime]');assert.equal(view.getTreeItem(runtime).contextValue,'safeSyncRuntime');
 rows=[];assert.deepEqual(view.getChildren(),[]);view.dispose();assert.equal(listeners.size,0);
});
