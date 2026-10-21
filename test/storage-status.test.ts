import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {fileRouter} from '../src/storage.js';
const id='00000000-0000-4000-8000-000000000001';
function app(file:any,principal:any={id:'owner',role:'STUDENT'},config:any={PUBLIC_MEDIA_BASE:'https://media.example.invalid/'}){
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.principal=principal;next();});
 app.use(fileRouter({document:{findUnique:async()=>file}} as any,config));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||(error.name==='ZodError'?400:500)).json({code:error.code}));return app;
}
test('only approved public media exposes its permanent URL',async()=>{
 const file={id,ownerId:'owner',public:true,status:'SCANNING',fileKey:'quarantine/secret',mime:'image/png'};
 assert.equal((await request(app(file)).get('/'+id+'/status')).body.url,null);
 const approved={...file,status:'APPROVED',fileKey:'public/'+id+'/photo.png'};
 const result=await request(app(approved)).get('/'+id+'/status');assert.equal(result.status,200);assert.equal(result.body.url,'https://media.example.invalid/'+approved.fileKey);assert.equal(result.body.fileKey,undefined);
 assert.equal((await request(app({...approved,public:false})).get('/'+id+'/status')).body.url,null);
});
test('another student cannot inspect uploads; content editors can inspect public media',async()=>{
 const file={id,ownerId:'another',public:true,status:'APPROVED',fileKey:'public/photo.png'};
 assert.equal((await request(app(file)).get('/'+id+'/status')).status,404);
 assert.equal((await request(app(file,{id:'editor',role:'ADMIN',adminRole:'CONTENT_EDITOR',permissions:{read:['media'],write:[]}})).get('/'+id+'/status')).status,200);
 assert.equal((await request(app({...file,public:false},{id:'editor',role:'ADMIN',adminRole:'CONTENT_EDITOR',permissions:{read:['media'],write:[]}})).get('/'+id+'/status')).status,404);
});
test('unsupported videos are rejected, images keep 10 MB limit and setup failure is explicit',async()=>{
 const body={filename:'clip.mp4',mime:'video/mp4',size:1024,type:'OTHER',public:false};
 assert.equal((await request(app(null)).post('/upload-url').send(body)).status,400);
 assert.equal((await request(app(null)).post('/upload-url').send({...body,mime:'image/png',size:11*1024*1024})).status,422);
 assert.equal((await request(app(null)).post('/upload-url').send({...body,mime:'image/png'})).status,503);
 assert.equal((await request(app(null)).post('/upload-url').send({...body,size:51*1024*1024})).status,400);
});
