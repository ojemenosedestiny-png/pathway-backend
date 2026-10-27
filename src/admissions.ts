import {Router} from 'express';
import {PrismaClient,Prisma} from '@prisma/client';
import {z} from 'zod';
import {wrap,parse,rate,digest,transaction,audit,fail,pageSchema,idSchema,queue,type Config} from './core.js';
import {moduleGuard,createPasswordLink} from './auth.js';
import {allocateStudentId} from './payments.js';
import {lock} from './database.js';

export async function provisionAdmissionStudent(tx:Prisma.TransactionClient,config:Config,application:{id:string;email:string;phone:string;firstName:string;lastName:string;reference:string}){
 await lock(tx,'AdmissionStudentEmail:'+application.email);
 let user=await tx.user.findUnique({where:{email:application.email},include:{student:true}});
 if(user&&(user.role==='ADMIN'||user.status!=='ACTIVE'))fail(409,'ACCOUNT_CONFLICT','This email belongs to a staff or inactive account. Confirm the applicant’s details before approving.');
 if(user?.role==='APPLICANT'&&!user.emailVerifiedAt)fail(409,'EMAIL_UNVERIFIED','Ask the applicant to verify their existing account email before approving this application.');
 if(!user?.student){
  const studentId=await allocateStudentId(tx,config);
  const student={studentId,firstName:application.firstName,lastName:application.lastName,journeyStage:'Registration in progress',milestones:[{stage:'Application accepted',at:new Date().toISOString()}]};
  user=user?await tx.user.update({where:{id:user.id},data:{role:'STUDENT',student:{create:student}},include:{student:true}}):await tx.user.create({data:{role:'STUDENT',email:application.email,phone:application.phone,student:{create:student}},include:{student:true}});
 }
 const key='admission-portal:'+application.id;
 if(!await tx.outbox.findUnique({where:{key}})){
  if(!user.passwordHash)await createPasswordLink(tx,config,user,'SET',key);
  else await queue(tx,config,key,'EMAIL',{to:user.email,template:'status',title:'Your NewworldPathway student portal is ready',body:`Your application ${application.reference} has been accepted. Your Student ID is ${user.student!.studentId}. Continue registration at ${new URL('/student/login',config.FRONTEND_ORIGIN).href} using your existing password. Approval does not confirm payment or official exam registration.`});
 }
 return {studentId:user.student!.studentId};
}

export const admissionProgrammes=['Cambridge Curriculum','Nigerian Curriculum','Cambridge International Examination - Year 8','Checkpoint (Cambridge)','IGCSE - JSS 3','BECE - ERC / NECO - JSS 3','SSCE - WAEC','SSCE - NECO','SAT','HMB (Pre-Degree)','Cambridge International AS & A Level','IJMB (A Level equivalent)'] as const;
export const admissionSchema=z.object({
 firstName:z.string().trim().min(2).max(80),lastName:z.string().trim().min(2).max(80),
 email:z.string().trim().email().max(254).transform(value=>value.toLowerCase()),
 phone:z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/),programme:z.enum(admissionProgrammes),
 currentSchool:z.string().trim().max(180).default(''),currentLevel:z.string().trim().max(80).default(''),
 guardianName:z.string().trim().max(150).default(''),guardianPhone:z.string().trim().max(25).default(''),
 notes:z.string().trim().max(2000).default(''),consent:z.literal(true),
}).strict();
const receipt=(item:any)=>({reference:item.reference,status:item.status,submittedAt:item.createdAt});
export async function submitAdmission(db:PrismaClient,id:string,data:z.infer<typeof admissionSchema>,ip:string){
 const requestHash=digest(JSON.stringify(data));
 return transaction(db,async tx=>{
  const existing=await tx.admissionApplication.findUnique({where:{id}});
  if(existing){if(existing.requestHash!==requestHash)fail(409,'APPLICATION_CONFLICT','This submission reference was already used. Reload the page to start a new application.');return {item:receipt(existing),created:false};}
  const {consent,...fields}=data;
  const item=await tx.admissionApplication.create({data:{id,reference:'APP-'+new Date().getUTCFullYear()+'-'+id.replaceAll('-','').toUpperCase(),requestHash,...fields,consentAt:new Date()}});
  await audit(tx,'PUBLIC_APPLICANT','ADMISSION_SUBMITTED','AdmissionApplication',item.id,ip,undefined,{status:item.status,programme:item.programme});
  return {item:receipt(item),created:true};
 });
}
export async function ensureAdmissionCollection(db:PrismaClient){
 try{await db.$runCommandRaw({create:'AdmissionApplication'});}catch(error:any){const code=error?.meta?.code;const message=String(error?.meta?.message||error?.message||'');if(String(code)!=='48'&&!/NamespaceExists|already exists/i.test(message))throw error;}
}
export function publicAdmissionsRouter(db:PrismaClient){const r=Router();
 r.get('/admission-programmes',(_req,res)=>res.json(admissionProgrammes));
 r.post('/applications',wrap(async(req,res)=>{
  const id=parse(idSchema,req.get('idempotency-key'));const data=parse(admissionSchema,req.body);
  await rate(db,'admissions-ip:'+req.ip,10,900);await rate(db,'admissions-email:'+data.email,5,3600);
  let result;try{result=await submitAdmission(db,id,data,req.ip||'');}catch(error:any){if(error?.code!=='P2002')throw error;result=await submitAdmission(db,id,data,req.ip||'');}
  res.status(result.created?201:200).json(result.item);
 }));return r;
}
export function adminAdmissionsRouter(db:PrismaClient,config:Config){const r=Router();
 r.get('/applicants',moduleGuard('applications'),wrap(async(req,res)=>{res.json(await db.admissionApplication.findMany({select:{id:true,reference:true,firstName:true,lastName:true,email:true,phone:true,programme:true,currentSchool:true,currentLevel:true,guardianName:true,guardianPhone:true,notes:true,status:true,reviewNotes:true,consentAt:true,createdAt:true,updatedAt:true},orderBy:{createdAt:'desc'},...parse(pageSchema,req.query)}));}));
 r.patch('/applicants/:id/status',moduleGuard('applications',true),wrap(async(req,res)=>{
  const id=parse(idSchema,req.params.id);const data=parse(z.object({status:z.enum(['UNDER_REVIEW','NEEDS_INFORMATION','ACCEPTED','REJECTED']),comment:z.string().trim().min(1).max(2000)}).strict(),req.body);
  const item=await transaction(db,async tx=>{const before=await tx.admissionApplication.findUniqueOrThrow({where:{id}});const after=await tx.admissionApplication.update({where:{id},data:{status:data.status,reviewNotes:data.comment,reviewedBy:req.principal!.id}});
   const portal=after.status==='ACCEPTED'?await provisionAdmissionStudent(tx,config,after):{};
   await audit(tx,req.principal!.id,'ADMISSION_REVIEWED','AdmissionApplication',id,req.ip||'',{status:before.status},{status:after.status,comment:data.comment,...portal});return {...receipt(after),...portal};});res.json(item);
 }));return r;
}
