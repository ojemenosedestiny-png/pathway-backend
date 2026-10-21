import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {fileRouter} from '../src/storage.js';
test('missing upload configuration gives staff setting names and students safe guidance',async()=>{
 for(const role of ['ADMIN','STUDENT']){const app=express();app.use(express.json(),(req,_res,next)=>{req.principal={id:'fixture',role,adminRole:'SUPER_ADMIN',permissions:{read:[],write:[]}} as any;next();});app.use(fileRouter({} as any,{} as any));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({message:error.message}));const res=await request(app).post('/upload-url').send({filename:'test.jpg',mime:'image/jpeg',size:100,type:role==='ADMIN'?'MEDIA':'OTHER',public:role==='ADMIN'});assert.equal(res.status,503);if(role==='ADMIN'){assert.match(res.body.message,/S3_ACCESS_KEY/);assert.match(res.body.message,/SCANNER_URL/);assert.match(res.body.message,/PUBLIC_MEDIA_BASE/);}else{assert.match(res.body.message,/contact the school/);assert.doesNotMatch(res.body.message,/S3_|SCANNER_/);}}
});
