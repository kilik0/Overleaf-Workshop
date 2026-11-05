const {test}=require('node:test');const assert=require('node:assert/strict');const Module=require('module');const load=Module._load;
let captured;
Module._load=function(id,...args){if(id==='undici')return {fetch:async(url,options)=>{captured={url,...options};return {status:200,text:async()=>JSON.stringify({success:true,entity_id:'new-doc',entity_type:'doc'})}}};return load.call(this,id,...args)};
const {BaseAPI}=require('../out/api/base');Module._load=load;
test('file upload sends multipart bytes and matching boundary to undici',async()=>{
 const api=new BaseAPI('https://example.test/');const content=Buffer.from('@article{中文,title={测试}}\n');
 const result=await api.uploadFile({cookies:'test',csrfToken:'test'},'project','folder','references.bib',content);
 assert.equal(result.entity._id,'new-doc');assert.ok(Buffer.isBuffer(captured.body));
 const type=captured.headers['content-type'];assert.match(type,/multipart\/form-data; boundary=/);
 const boundary=type.split('boundary=')[1];assert.ok(captured.body.includes(Buffer.from('--'+boundary)));
 assert.ok(captured.body.includes(content));assert.ok(captured.body.includes(Buffer.from('filename="references.bib"')));
});
