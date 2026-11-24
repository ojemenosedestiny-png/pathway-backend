import express,{Router} from 'express';
import {randomInt} from 'node:crypto';
import {Prisma,PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {wrap,parse,fail,audit,transaction,rate} from './core.js';
import {moduleGuard,studentGuard} from './auth.js';
import {lock} from './database.js';
import type {Config} from './core.js';
import {aiRespond} from './ai.js';
const text=z.string().trim().min(1).max(3000),id=z.string().uuid();
const httpsUrl=z.string().url().max(1500).refine(v=>new URL(v).protocol==='https:','Use an HTTPS resource link.');
const question=z.object({prompt:text,options:z.array(text).min(2).max(6),answer:z.number().int().min(0).max(5),explanation:z.string().max(1500).default('')}).strict().refine(q=>q.answer<q.options.length,'Answer must match an option.');
const mock=z.object({title:text,subject:text,durationMinutes:z.number().int().min(1).max(180),opensAt:z.string().datetime(),closesAt:z.string().datetime(),published:z.boolean(),releaseResults:z.boolean(),questionsPerAttempt:z.number().int().min(1).max(100).nullable().default(null),questions:z.array(question).min(1).max(100)}).strict().refine(m=>m.opensAt<m.closesAt,'Closing time must follow opening time.').refine(m=>!m.questionsPerAttempt||m.questionsPerAttempt<=m.questions.length,'Questions per student cannot exceed the questions in the paper.');
const material=z.object({title:text,subject:text,description:text,url:httpsUrl,published:z.boolean()}).strict();
const motivation=z.object({text,author:z.string().trim().min(1).max(150),published:z.boolean()}).strict();
/** A registration draft may be incomplete; every supplied value is still checked. Completeness is enforced only on submission. */
const draftText=(max=3000)=>z.string().trim().max(max).default('');
const registration=z.object({address:draftText(),currentSchool:draftText(),currentLevel:draftText(),programme:draftText(),guardianName:draftText(),guardianPhone:draftText(30).refine(v=>!v||/^\+?[\d\s()-]{7,30}$/.test(v),'Enter a valid phone number, for example 08031234567.'),subjects:draftText(1500),notes:draftText(2000),submitted:z.boolean().default(false)}).strict();
export const registrationRequired={address:'Home address',currentSchool:'Current or most recent school',currentLevel:'Current class or qualification',programme:'Preparation programme',guardianName:'Parent or guardian name',guardianPhone:'Parent or guardian phone'} as const;
export function missingRegistrationFields(data:Record<string,unknown>){return Object.entries(registrationRequired).filter(([key])=>!String(data[key]??'').trim()).map(([,label])=>label);}
const resultSchema=z.object({studentId:id,title:text,subject:text,score:z.number().min(0),maximum:z.number().positive(),comment:z.string().max(2000),published:z.boolean()}).strict().refine(r=>r.score<=r.maximum,'Score exceeds maximum.');
const bankSchema=z.object({bankName:z.string().trim().min(2).max(100),accountName:z.string().trim().min(2).max(160),accountNumber:z.string().regex(/^\d{10}$/,'Enter a 10-digit Nigerian account number.'),instructions:z.string().max(1500),active:z.boolean()}).strict();
/** Documents each student uploads, listed in the portal before uploading. Staff can change the list. */
export const defaultDocumentRequirements=[
 {key:'passport-photo',label:'Passport photograph',description:'Recent, clear photo on a white background, face fully visible.',type:'PASSPORT',required:true},
 {key:'birth-certificate',label:'Birth certificate or declaration of age',description:'Shows your full name and date of birth.',type:'IDENTITY',required:true},
 {key:'nin-slip',label:'NIN slip',description:'Your National Identification Number slip or card.',type:'IDENTITY',required:true},
 {key:'state-of-origin',label:'Local government identification letter',description:'Letter confirming your state of origin and LGA.',type:'IDENTITY',required:true},
 {key:'school-result',label:'Latest school report card or result',description:'Your most recent term or session result.',type:'RESULT',required:true},
 {key:'other',label:'Other supporting document',description:'Anything else the school asked you for.',type:'OTHER',required:false},
];
const requirementSchema=z.array(z.object({key:z.string().regex(/^[a-z0-9-]{2,40}$/),label:z.string().trim().min(2).max(100),description:z.string().trim().max(300).default(''),type:z.enum(['PASSPORT','RESULT','IDENTITY','OTHER']),required:z.boolean()}).strict()).min(1).max(15).refine(list=>new Set(list.map(r=>r.key)).size===list.length,'Each document needs its own key.');
async function documentRequirements(db:PrismaClient){const row=await db.portalRecord.findUnique({where:{key:'DOC_REQUIREMENTS'}});return ((row?.data as any)?.requirements as typeof defaultDocumentRequirements)||defaultDocumentRequirements;}
export const defaultMaterials=[
 {id:'waec',title:'WAEC e-Learning toolkit',subject:'All O Level subjects',description:'Official subject guidance, examiner observations and worked examination examples. Select your subject on the WAEC website.',url:'https://www.waeconline.org.ng/e-Learning/index.htm',published:true},
 {id:'cambridge',title:'Cambridge learning and revision',subject:'Cambridge O Level / IGCSE',description:'Official learner guides, revision planning and assessment guidance. Some school resources require school access.',url:'https://www.cambridgeinternational.org/support-and-training-for-schools/support-for-teachers/learning-revision/',published:true},
 {id:'science',title:'Khan Academy science',subject:'Biology, Chemistry and Physics',description:'Supplementary explanations and practice. Match topics to your examination syllabus with your teacher.',url:'https://www.khanacademy.org/science',published:true}
];
export const defaultMotivation=[{id:'practice',text:'Small, consistent study sessions build lasting understanding.',author:'NewworldPathway study team',published:true},{id:'questions',text:'Ask questions early. Seeking guidance is part of becoming a confident learner.',author:'NewworldPathway admissions team',published:true}];
export async function ensureLearningCollection(db:PrismaClient){
 if(await db.databaseLock.findUnique({where:{key:'schema:portal-learning:v1'}}))return;
 try{await db.$runCommandRaw({create:'PortalRecord'});}catch(e:any){if(String(e?.meta?.code)!=='48'&&!String(e?.message).includes('already exists'))throw e;}
 await db.$runCommandRaw({createIndexes:'PortalRecord',indexes:[{key:{key:1},name:'PortalRecord_key_key',unique:true},{key:{kind:1,studentId:1},name:'PortalRecord_kind_studentId_idx'}]});
 await db.databaseLock.upsert({where:{key:'schema:portal-learning:v1'},create:{key:'schema:portal-learning:v1',version:0},update:{}});
}
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const list=(db:PrismaClient,kind:string,studentId?:string)=>db.portalRecord.findMany({where:{kind,...(studentId?{studentId}:{})},orderBy:{createdAt:'desc'},take:200});
export function markAnswers(questions:any[],answers:number[]){return questions.reduce((score,q,i)=>score+(answers[i]===q.answer?1:0),0);}
/** Each attempt gets its own paper: a random subset/order of questions and a random option order per question. */
export interface Paper {order:number[];optionOrders:number[][]}
type Pick=(max:number)=>number;
function shuffled(length:number,pick:Pick){const items=Array.from({length},(_,i)=>i);for(let i=length-1;i>0;i--){const j=pick(i+1);[items[i],items[j]]=[items[j],items[i]];}return items;}
export interface PaperSettings {perAttempt?:number|null;shuffleQuestions?:boolean;shuffleOptions?:boolean}
/** Draws one student's paper. With shuffling off, questions keep the staff order (a subset, if any, is still random). */
export function drawPaper(questions:{options:string[]}[],settings:number|null|undefined|PaperSettings={},pick:Pick=randomInt):Paper{
 const options:PaperSettings=typeof settings==='object'&&settings!==null?settings:{perAttempt:settings};
 const count=Math.min(options.perAttempt||questions.length,questions.length);
 const picked=shuffled(questions.length,pick).slice(0,count);
 const order=options.shuffleQuestions===false?picked.sort((a,b)=>a-b):picked;
 return {order,optionOrders:order.map(q=>options.shuffleOptions===false?questions[q].options.map((_,i)=>i):shuffled(questions[q].options.length,pick))};
}
/** Attempts started before shuffling existed keep the original order. */
export function paperOf(attempt:any,questions:{options:string[]}[]):Paper{
 if(Array.isArray(attempt.order)&&Array.isArray(attempt.optionOrders))return {order:attempt.order,optionOrders:attempt.optionOrders};
 return {order:questions.map((_,i)=>i),optionOrders:questions.map(q=>q.options.map((_,i)=>i))};
}
/** The paper as the student sees it: never includes the answer key. */
export function paperQuestions(questions:{prompt:string;options:string[];passage?:string;image?:string;marks?:number}[],paper:Paper){return paper.order.map((q,i)=>({prompt:questions[q].prompt,options:paper.optionOrders[i].map(o=>questions[q].options[o]),passage:questions[q].passage||'',image:questions[q].image||'',marks:Number(questions[q].marks??1)}));}
/** answers[i] is the option position the student saw for paper question i (-1 = unanswered). */
export function gradePaper(questions:{answer:number;marks?:number}[],paper:Paper,answers:number[]){return markPaper(questions,paper,answers).score;}
/** Score and maximum, using each question's marks (1 when not set). */
export function markPaper(questions:{answer:number;marks?:number}[],paper:Paper,answers:number[]){let score=0,maximum=0;paper.order.forEach((q,i)=>{const marks=Number(questions[q].marks??1);maximum+=marks;const chosen=answers[i];const original=Number.isInteger(chosen)&&chosen>=0?paper.optionOrders[i][chosen]:undefined;if(original!==undefined&&original===questions[q].answer)score+=marks;});return {score,maximum};}
export function normalisedAnswers(paper:Paper,answers:unknown):number[]{const list=Array.isArray(answers)?answers:[];return paper.order.map((_,i)=>{const value=Number(list[i]);return Number.isInteger(value)&&value>=0&&value<paper.optionOrders[i].length?value:-1;});}
/** Separate school accounts: GENERAL (school fees, the original 'bank' record), APPLICATION and HOSTEL. */
export const bankPurposes=['GENERAL','APPLICATION','HOSTEL'] as const;export type BankPurpose=typeof bankPurposes[number];
export const bankKey=(purpose:BankPurpose)=>purpose==='GENERAL'?'bank':'bank:'+purpose;
/** The active account for a purpose, falling back to the school fees account when that purpose has none. */
export async function bankFor(db:PrismaClient,purpose:BankPurpose){for(const candidate of purpose==='GENERAL'?['GENERAL' as const]:[purpose,'GENERAL' as const]){const data=(await db.portalRecord.findUnique({where:{key:bankKey(candidate)}}))?.data as any;if(data?.active)return {...data,purpose:candidate};}return null;}
const answersSchema=z.object({answers:z.array(z.number().int().min(-1).max(5)).max(100)}).strict();
export function learningRouter(db:PrismaClient,staff=false,config?:Config){
 const r=Router();if(!staff)r.use(studentGuard);
 const sid=(req:any)=>req.principal.studentId as string;
 const write=async(req:any,key:string,kind:string,data:any,studentId?:string)=>transaction(db,async tx=>{const before=await tx.portalRecord.findUnique({where:{key}});const row=await tx.portalRecord.upsert({where:{key},create:{key,kind,studentId,data:json(data)},update:{data:json(data)}});await audit(tx,req.principal.id,'PORTAL_'+kind,'PortalRecord',row.id,req.ip||'',before?.data,data);return row;});
 if(staff){
  r.get('/bank',moduleGuard('payments'),wrap(async(_req,res)=>res.json((await db.portalRecord.findUnique({where:{key:'bank'}}))?.data||null)));
  r.get('/banks',moduleGuard('payments'),wrap(async(_req,res)=>{const rows=await db.portalRecord.findMany({where:{key:{in:bankPurposes.map(bankKey)}}});res.json(Object.fromEntries(bankPurposes.map(p=>[p,rows.find(row=>row.key===bankKey(p))?.data||null])));}));
  const saveBank=(purpose:BankPurpose)=>wrap(async(req,res)=>{if(!req.principal!.mfaAt||Date.now()-req.principal!.mfaAt.getTime()>900000)fail(403,'RECENT_MFA_REQUIRED','For security, bank details can only be changed within 15 minutes of signing in. Sign out, sign in again with your authenticator, then save.');res.json(await write(req,bankKey(purpose),'BANK',parse(bankSchema,req.body)));});
  r.put('/bank',moduleGuard('payments',true),saveBank('GENERAL'));
  r.put('/bank/:purpose',moduleGuard('payments',true),(req,res,next)=>saveBank(parse(z.enum(bankPurposes),req.params.purpose))(req,res,next));
  for(const [resource,kind,schema,permission] of [['materials','MATERIAL',material,'content'],['motivation','MOTIVATION',motivation,'content']] as const){
   r.get('/'+resource,moduleGuard(permission),wrap(async(_req,res)=>res.json(await list(db,kind))));
   r.put('/'+resource+'/:id',moduleGuard(permission,true),wrap(async(req,res)=>{const recordId=parse(id,req.params.id);const key=kind+':'+recordId;res.json(await write(req,key,kind,parse(schema as any,req.body)));}));
  }
  r.get('/document-requirements',moduleGuard('documents'),wrap(async(_req,res)=>res.json(await documentRequirements(db))));
  r.put('/document-requirements',moduleGuard('documents',true),wrap(async(req,res)=>{const requirements=parse(requirementSchema,req.body?.requirements);await write(req,'DOC_REQUIREMENTS','SETTING',{requirements});res.json(requirements);}));
  r.get('/ssce-form/:userId',moduleGuard('applications'),wrap(async(req,res)=>res.json((await db.portalRecord.findUnique({where:{key:'SSCE_FORM:'+parse(id,req.params.userId)}}))?.data||null)));
  r.get('/registrations',moduleGuard('applications'),wrap(async(_req,res)=>res.json(await list(db,'REGISTRATION'))));
  r.put('/fee-schedules/:id',moduleGuard('fees',true),wrap(async(req,res)=>{const feeId=parse(id,req.params.id);if(!await db.fee.findUnique({where:{id:feeId}}))fail(404,'NOT_FOUND','Fee not found.');const data=parse(z.object({programme:z.string().max(150),term:z.string().max(100),session:z.string().max(100),effectiveFrom:z.string().max(30),active:z.boolean()}).strict(),req.body);res.json(await write(req,'FEE_SCHEDULE:'+feeId,'FEE_SCHEDULE',{feeId,...data}));}));
  r.get('/results',moduleGuard('exams'),wrap(async(_req,res)=>res.json([...(await list(db,'RESULT')),...(await list(db,'ATTEMPT'))])));
  r.put('/results/:id',moduleGuard('exams',true),wrap(async(req,res)=>{const data=parse(resultSchema,req.body);if(!await db.student.findUnique({where:{id:data.studentId}}))fail(404,'NOT_FOUND','Student not found.');res.json(await write(req,'RESULT:'+parse(id,req.params.id),'RESULT',data,data.studentId));}));
  r.get('/proofs',moduleGuard('payments'),wrap(async(_req,res)=>{const rows=await list(db,'PROOF');res.json(await Promise.all(rows.map(async row=>({...row,payment:await db.payment.findUnique({where:{reference:(row.data as any).reference},select:{reference:true,status:true,amountMinor:true,currency:true,payerName:true,studentId:true}})}))));}));
 }else{
  r.get('/bank',wrap(async(req,res)=>res.json(await bankFor(db,parse(z.enum(bankPurposes).default('GENERAL'),req.query.purpose)))));
  r.get('/ssce-form',wrap(async(req,res)=>res.json((await db.portalRecord.findUnique({where:{key:'SSCE_FORM:'+req.principal!.id}}))?.data||null)));
  // Each required document has its own slot pointing at the student's uploaded file.
  r.get('/document-requirements',wrap(async(req,res)=>{const requirements=await documentRequirements(db);const slots=((await db.portalRecord.findUnique({where:{key:'DOCSLOT:'+sid(req)}}))?.data||{}) as Record<string,string>;const files=await db.document.findMany({where:{id:{in:Object.values(slots)},ownerId:req.principal!.id},select:{id:true,filename:true,status:true,rejectionReason:true,createdAt:true}});res.json({requirements,slots:Object.fromEntries(Object.entries(slots).map(([key,docId])=>[key,files.find(f=>f.id===docId)||null]).filter(([,file])=>file))});}));
  r.put('/document-slots/:key',wrap(async(req,res)=>{const key=parse(z.string().regex(/^[a-z0-9-]{2,40}$/),req.params.key);const {documentId}=parse(z.object({documentId:id}).strict(),req.body);if(!(await documentRequirements(db)).some(r=>r.key===key))fail(404,'NOT_FOUND','This document is not on the school list.');const file=await db.document.findUnique({where:{id:documentId}});if(!file||file.ownerId!==req.principal!.id||file.public||file.type==='BANK_PROOF')fail(422,'DOCUMENT_INVALID','Upload your own private document first.');const slotKey='DOCSLOT:'+sid(req);const slots=((await db.portalRecord.findUnique({where:{key:slotKey}}))?.data||{}) as Record<string,string>;await write(req,slotKey,'DOCSLOT',{...slots,[key]:documentId},sid(req));res.json({key,documentId});}));
  r.get('/registration',wrap(async(req,res)=>res.json((await db.portalRecord.findUnique({where:{key:'REGISTRATION:'+sid(req)}}))?.data||null)));
  r.put('/registration',wrap(async(req,res)=>{const key='REGISTRATION:'+sid(req);const data:any=parse(registration,req.body);const before=(await db.portalRecord.findUnique({where:{key}}))?.data as any;
   // Once submitted to admissions, a registration stays submitted; later saves update it but cannot turn it back into a draft.
   if(before?.submitted){data.submitted=true;data.submittedAt=before.submittedAt||null;}
   if(data.submitted){const missing=missingRegistrationFields(data);if(missing.length)fail(400,'REGISTRATION_INCOMPLETE','Complete these fields before submitting: '+missing.join(', ')+'. You can save without submitting.');data.submittedAt??=new Date().toISOString();}
   data.savedAt=new Date().toISOString();res.json((await write(req,key,'REGISTRATION',data,sid(req))).data);}));
  for(const [resource,kind,defaults] of [['materials','MATERIAL',defaultMaterials],['motivation','MOTIVATION',defaultMotivation]] as const)r.get('/'+resource,wrap(async(_req,res)=>{const rows=await list(db,kind);res.json(rows.length?rows.filter(row=>(row.data as any).published).map(row=>({id:row.id,...row.data as any})):defaults);}));
  r.get('/proofs',wrap(async(req,res)=>res.json(await list(db,'PROOF',sid(req)))));
  r.post('/proofs',wrap(async(req,res)=>{const data=parse(z.object({reference:z.string().min(5).max(120),documentId:id,paidAt:z.string().date(),note:z.string().max(500)}).strict(),req.body);const payment=await db.payment.findUnique({where:{reference:data.reference}});if(!payment||payment.studentId!==sid(req)||payment.provider!=='BANK'||payment.status!=='PENDING')fail(404,'PAYMENT_UNAVAILABLE','Pending bank payment unavailable.');const file=await db.document.findUnique({where:{id:data.documentId}});if(!file||file.ownerId!==req.principal!.id||file.public||!['PENDING','APPROVED'].includes(file.status)||!file.mime.startsWith('image/'))fail(422,'PROOF_INVALID','Upload your own validated private receipt image first.');await db.document.update({where:{id:file.id},data:{type:'BANK_PROOF'}});res.json(await write(req,'PROOF:'+payment.reference,'PROOF',{...data,status:'AWAITING_REVIEW'},sid(req)));}));
 }
 return r;
}
