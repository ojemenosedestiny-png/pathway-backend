import {Router} from 'express';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {wrap,parse,rate,digest,idSchema,pageSchema,fail,audit} from './core.js';
import {moduleGuard} from './auth.js';
export const consultationRequestSchema=z.object({name:z.string().trim().min(2).max(150),email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),phone:z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/),topic:z.string().trim().min(5).max(2000),preferredTime:z.string().trim().max(200).default(''),consent:z.literal(true)}).strict();
export function publicConsultationsRouter(db:PrismaClient){const r=Router();
r.post('/consultation-requests',wrap(async(req,res)=>{
 const id=parse(idSchema,req.get('idempotency-key')),data=parse(consultationRequestSchema,req.body);
 await rate(db,'consultation-ip:'+req.ip,10,900);await rate(db,'consultation-email:'+data.email,5,3600);
 const requestHash=digest(JSON.stringify(data));const {consent,...fields}=data;
 let item;try{item=await db.consultationRequest.upsert({where:{id},create:{id,reference:'CON-'+id.toUpperCase(),requestHash,...fields,consentAt:new Date()},update:{}});}catch(error:any){if(error?.code!=='P2002')throw error;item=await db.consultationRequest.findUniqueOrThrow({where:{id}});}
 if(item.requestHash!==requestHash)fail(409,'CONFLICT','This request reference was already used. Reload to start another request.');
 res.status(201).json({reference:item.reference,status:item.status});
}));return r;}
export function adminConsultationsRouter(db:PrismaClient){const r=Router();
r.get('/consultation-requests',moduleGuard('consultations'),wrap(async(req,res)=>{const rows=await db.consultationRequest.findMany({orderBy:{createdAt:'desc'},...parse(pageSchema,req.query)});res.json(rows.map(({requestHash,...row})=>row));}));
r.patch('/consultation-requests/:id/status',moduleGuard('consultations',true),wrap(async(req,res)=>{
 const id=parse(idSchema,req.params.id),data=parse(z.object({status:z.enum(['NEW','CONTACTED','SCHEDULED','CLOSED']),reviewNotes:z.string().trim().max(2000)}).strict(),req.body);
 const item=await db.consultationRequest.update({where:{id},data});
 await audit(db,req.principal!.id,'CONSULTATION_REQUEST_REVIEWED','ConsultationRequest',id,req.ip||'',undefined,{status:data.status});res.json({status:item.status});
}));return r;}
