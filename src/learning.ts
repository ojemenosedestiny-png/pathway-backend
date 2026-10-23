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
const registration=z.object({address:text,currentSchool:text,currentLevel:text,programme:text,guardianName:text,guardianPhone:z.string().min(7).max(30),subjects:z.string().max(1500),notes:z.string().max(2000),submitted:z.boolean()}).strict();
const resultSchema=z.object({studentId:id,title:text,subject:text,score:z.number().min(0),maximum:z.number().positive(),comment:z.string().max(2000),published:z.boolean()}).strict().refine(r=>r.score<=r.maximum,'Score exceeds maximum.');
const bankSchema=z.object({bankName:z.string().trim().min(2).max(100),accountName:z.string().trim().min(2).max(160),accountNumber:z.string().regex(/^\d{10}$/,'Enter a 10-digit Nigerian account number.'),instructions:z.string().max(1500),active:z.boolean()}).strict();
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
export function drawPaper(questions:{options:string[]}[],perAttempt?:number|null,pick:Pick=randomInt):Paper{
 const order=shuffled(questions.length,pick).slice(0,Math.min(perAttempt||questions.length,questions.length));
 return {order,optionOrders:order.map(q=>shuffled(questions[q].options.length,pick))};
}
/** Attempts started before shuffling existed keep the original order. */
export function paperOf(attempt:any,questions:{options:string[]}[]):Paper{
 if(Array.isArray(attempt.order)&&Array.isArray(attempt.optionOrders))return {order:attempt.order,optionOrders:attempt.optionOrders};
 return {order:questions.map((_,i)=>i),optionOrders:questions.map(q=>q.options.map((_,i)=>i))};
}
export function paperQuestions(questions:{prompt:string;options:string[]}[],paper:Paper){return paper.order.map((q,i)=>({prompt:questions[q].prompt,options:paper.optionOrders[i].map(o=>questions[q].options[o])}));}
/** answers[i] is the option position the student saw for paper question i (-1 = unanswered). */
export function gradePaper(questions:{answer:number}[],paper:Paper,answers:number[]){return paper.order.reduce((score,q,i)=>{const chosen=answers[i];const original=Number.isInteger(chosen)&&chosen>=0?paper.optionOrders[i][chosen]:undefined;return score+(original!==undefined&&original===questions[q].answer?1:0);},0);}
function normalisedAnswers(paper:Paper,answers:unknown):number[]{const list=Array.isArray(answers)?answers:[];return paper.order.map((_,i)=>{const value=Number(list[i]);return Number.isInteger(value)&&value>=0&&value<paper.optionOrders[i].length?value:-1;});}
/** Separate school accounts: GENERAL (school fees, the original 'bank' record), APPLICATION and HOSTEL. */
export const bankPurposes=['GENERAL','APPLICATION','HOSTEL'] as const;export type BankPurpose=typeof bankPurposes[number];
export const bankKey=(purpose:BankPurpose)=>purpose==='GENERAL'?'bank':'bank:'+purpose;
/** The active account for a purpose, falling back to the school fees account when that purpose has none. */
export async function bankFor(db:PrismaClient,purpose:BankPurpose){for(const candidate of purpose==='GENERAL'?['GENERAL' as const]:[purpose,'GENERAL' as const]){const data=(await db.portalRecord.findUnique({where:{key:bankKey(candidate)}}))?.data as any;if(data?.active)return {...data,purpose:candidate};}return null;}
const answersSchema=z.object({answers:z.array(z.number().int().min(-1).max(5)).max(100)}).strict();
/** Schema handed to the AI so a mock paper PDF comes back as reviewable draft questions. */
const importSchema={type:'object',additionalProperties:false,required:['questions','warnings'],properties:{questions:{type:'array',items:{type:'object',additionalProperties:false,required:['prompt','options','answer','explanation'],properties:{prompt:{type:'string'},options:{type:'array',items:{type:'string'}},answer:{type:['integer','null']},explanation:{type:'string'}}}},warnings:{type:'array',items:{type:'string'}}}};
const importInstructions=`You convert a school examination paper (PDF) into structured objective questions for a timed mock examination.
Rules:
- Extract every multiple-choice question in the order it appears. Copy the question text faithfully; do not rewrite, simplify or add content.
- options: the answer choices in their original order, WITHOUT the leading letter or number (for "A. 12" return "12"). Most papers have A-D.
- answer: the zero-based index of the correct option (A=0, B=1, C=2, D=3) taken ONLY from an answer key, marking scheme or marked answer in the document. If the document does not state the answer, return null. Never guess.
- explanation: an explanation printed in the document, otherwise an empty string.
- Write mathematical and scientific notation as readable plain text (x^2, H2O, sqrt(3)).
- Skip instructions, cover pages and theory/essay questions.
- warnings: short notes for the teacher about anything uncertain: unreadable text, questions that depend on a diagram or table you could not reproduce, missing answers, or anything you skipped.`;
export async function importMockPdf(config:Config,pdf:Buffer,send?:typeof fetch){
 if(pdf.length<5||pdf.subarray(0,5).toString('latin1')!=='%PDF-')fail(415,'NOT_PDF','Upload a PDF question paper.');
 const reply=await aiRespond(config,{instructions:importInstructions,content:[{type:'input_text',text:'Extract the objective questions and answers from this examination paper.'},{type:'input_file',filename:'mock-paper.pdf',file_data:'data:application/pdf;base64,'+pdf.toString('base64')}],schema:{name:'mock_paper',schema:importSchema},maxOutputTokens:32000,timeoutMs:110000},send);
 let parsed:any;try{parsed=JSON.parse(reply);}catch{fail(502,'AI_FORMAT','The AI service returned an unreadable result. Try again.');}
 const warnings:string[]=(Array.isArray(parsed?.warnings)?parsed.warnings:[]).map((w:unknown)=>String(w).slice(0,300)).slice(0,30);
 const questions:any[]=[];
 for(const [index,q] of (Array.isArray(parsed?.questions)?parsed.questions:[]).entries()){
  const prompt=String(q?.prompt||'').trim().slice(0,3000);const options=(Array.isArray(q?.options)?q.options:[]).map((o:unknown)=>String(o).trim().slice(0,3000)).filter(Boolean);
  if(!prompt||options.length<2){warnings.push(`Question ${index+1} was skipped because it has fewer than two options.`);continue;}
  if(options.length>6){warnings.push(`Question ${index+1} has more than six options; only the first six were kept.`);options.length=6;}
  const answer=Number.isInteger(q?.answer)&&q.answer>=0&&q.answer<options.length?q.answer:null;
  questions.push({prompt,options,answer,explanation:String(q?.explanation||'').trim().slice(0,1500)});
 }
 if(questions.length>100){warnings.push(`The paper has ${questions.length} questions; only the first 100 were imported. Split it into two mocks.`);questions.length=100;}
 const missing=questions.filter(q=>q.answer===null).length;if(missing)warnings.push(`${missing} question${missing===1?' has':'s have'} no answer in the PDF. Set the correct option before publishing.`);
 if(!questions.length)fail(422,'NO_QUESTIONS','No multiple-choice questions were found in this PDF. Check that it is a readable objective paper.');
 return {questions,warnings};
}
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
  for(const [resource,kind,schema,permission] of [['mocks','MOCK',mock,'exams'],['materials','MATERIAL',material,'content'],['motivation','MOTIVATION',motivation,'content']] as const){
   r.get('/'+resource,moduleGuard(permission),wrap(async(_req,res)=>res.json(await list(db,kind))));
   r.put('/'+resource+'/:id',moduleGuard(permission,true),wrap(async(req,res)=>{const recordId=parse(id,req.params.id);const key=kind+':'+recordId;if(kind==='MOCK'&&await db.portalRecord.count({where:{kind:'ATTEMPT',key:{startsWith:'ATTEMPT:'+recordId+':'}}})){const old=await db.portalRecord.findUnique({where:{key}});const previous=old?.data as any;if(JSON.stringify(previous?.questions)!==JSON.stringify(req.body.questions)||previous?.durationMinutes!==req.body.durationMinutes||(previous?.questionsPerAttempt??null)!==(req.body.questionsPerAttempt??null))fail(409,'MOCK_LOCKED','Questions, duration and questions per student are locked after the first attempt. Create a new mock to change them.');}res.json(await write(req,key,kind,parse(schema as any,req.body)));}));
  }
  r.post('/mocks/import',moduleGuard('exams',true),express.raw({type:'application/pdf',limit:'15mb'}),wrap(async(req,res)=>{if(!config)fail(503,'AI_NOT_CONFIGURED','PDF import is not available.');if(!Buffer.isBuffer(req.body))fail(415,'NOT_PDF','Upload a PDF question paper.');await rate(db,'mock-import:'+req.principal!.id,20,3600);const result=await importMockPdf(config,req.body);await transaction(db,tx=>audit(tx,req.principal!.id,'MOCK_PDF_IMPORTED','PortalRecord','mock-import',req.ip||'',undefined,{questions:result.questions.length,bytes:req.body.length}));res.json(result);}));
  r.get('/registrations',moduleGuard('applications'),wrap(async(_req,res)=>res.json(await list(db,'REGISTRATION'))));
  r.put('/fee-schedules/:id',moduleGuard('fees',true),wrap(async(req,res)=>{const feeId=parse(id,req.params.id);if(!await db.fee.findUnique({where:{id:feeId}}))fail(404,'NOT_FOUND','Fee not found.');const data=parse(z.object({programme:z.string().max(150),term:z.string().max(100),session:z.string().max(100),effectiveFrom:z.string().max(30),active:z.boolean()}).strict(),req.body);res.json(await write(req,'FEE_SCHEDULE:'+feeId,'FEE_SCHEDULE',{feeId,...data}));}));
  r.get('/results',moduleGuard('exams'),wrap(async(_req,res)=>res.json([...(await list(db,'RESULT')),...(await list(db,'ATTEMPT'))])));
  r.put('/results/:id',moduleGuard('exams',true),wrap(async(req,res)=>{const data=parse(resultSchema,req.body);if(!await db.student.findUnique({where:{id:data.studentId}}))fail(404,'NOT_FOUND','Student not found.');res.json(await write(req,'RESULT:'+parse(id,req.params.id),'RESULT',data,data.studentId));}));
  r.get('/proofs',moduleGuard('payments'),wrap(async(_req,res)=>{const rows=await list(db,'PROOF');res.json(await Promise.all(rows.map(async row=>({...row,payment:await db.payment.findUnique({where:{reference:(row.data as any).reference},select:{reference:true,status:true,amountMinor:true,currency:true,payerName:true,studentId:true}})}))));}));
 }else{
  r.get('/bank',wrap(async(req,res)=>res.json(await bankFor(db,parse(z.enum(bankPurposes).default('GENERAL'),req.query.purpose)))));
  r.get('/registration',wrap(async(req,res)=>res.json((await db.portalRecord.findUnique({where:{key:'REGISTRATION:'+sid(req)}}))?.data||null)));
  r.put('/registration',wrap(async(req,res)=>res.json(await write(req,'REGISTRATION:'+sid(req),'REGISTRATION',parse(registration,req.body),sid(req)))));
  for(const [resource,kind,defaults] of [['materials','MATERIAL',defaultMaterials],['motivation','MOTIVATION',defaultMotivation]] as const)r.get('/'+resource,wrap(async(_req,res)=>{const rows=await list(db,kind);res.json(rows.length?rows.filter(row=>(row.data as any).published).map(row=>({id:row.id,...row.data as any})):defaults);}));
  r.get('/mocks',wrap(async(req,res)=>{const attempts=new Map((await list(db,'ATTEMPT',sid(req))).map(row=>[(row.data as any).mockId,(row.data as any).submitted?'SUBMITTED':'IN_PROGRESS']));res.json((await list(db,'MOCK')).filter(row=>(row.data as any).published).map(row=>{const {questions,...data}=row.data as any;const mockId=row.key.slice(5);return {id:mockId,...data,questionCount:data.questionsPerAttempt||questions.length,attemptStatus:attempts.get(mockId)||null};}));}));
  r.post('/mocks/:id/start',wrap(async(req,res)=>{const mockId=parse(id,req.params.id);const result=await transaction(db,async tx=>{await lock(tx,'MOCK:'+mockId);const row=await tx.portalRecord.findUnique({where:{key:'MOCK:'+mockId}});const data=row?.data as any;const now=Date.now();if(!data?.published||now<new Date(data.opensAt).getTime()||now>new Date(data.closesAt).getTime())fail(409,'MOCK_CLOSED','This mock is not open.');const key='ATTEMPT:'+mockId+':'+sid(req);let attempt=await tx.portalRecord.findUnique({where:{key}});if(!attempt){const paper=drawPaper(data.questions,data.questionsPerAttempt);attempt=await tx.portalRecord.create({data:{key,kind:'ATTEMPT',studentId:sid(req),data:json({mockId,title:data.title,subject:data.subject,startedAt:new Date().toISOString(),deadline:new Date(Math.min(now+data.durationMinutes*60000,new Date(data.closesAt).getTime())).toISOString(),...paper,answers:paper.order.map(()=>-1),submitted:false})}});}const a=attempt.data as any;if(a.submitted)fail(409,'ALREADY_SUBMITTED','This mock has already been submitted.');const paper=paperOf(a,data.questions);return {mockId,title:a.title,subject:a.subject,startedAt:a.startedAt,deadline:a.deadline,savedAt:a.savedAt||null,answers:normalisedAnswers(paper,a.answers),questions:paperQuestions(data.questions,paper)};});res.json(result);}));
  r.put('/mocks/:id/answers',wrap(async(req,res)=>{const mockId=parse(id,req.params.id);const {answers}=parse(answersSchema,req.body);const key='ATTEMPT:'+mockId+':'+sid(req);const savedAt=new Date().toISOString();await transaction(db,async tx=>{await lock(tx,key);const attempt=await tx.portalRecord.findUnique({where:{key}});if(!attempt)fail(404,'NOT_FOUND','Start the mock first.');const a=attempt.data as any;if(a.submitted)fail(409,'ALREADY_SUBMITTED','This mock has already been submitted.');if(Date.now()>new Date(a.deadline).getTime()+5000)fail(409,'TIME_EXPIRED','Time is up. Your last saved answers will be marked.');const m=(await tx.portalRecord.findUniqueOrThrow({where:{key:'MOCK:'+mockId}})).data as any;const paper=paperOf(a,m.questions);if(answers.length!==paper.order.length)fail(400,'ANSWERS','Send one answer for each question.');await tx.portalRecord.update({where:{id:attempt.id},data:{data:json({...a,answers:normalisedAnswers(paper,answers),savedAt})}});});res.json({saved:true,savedAt});}));
  r.post('/mocks/:id/submit',wrap(async(req,res)=>{const mockId=parse(id,req.params.id);const {answers}=parse(answersSchema,req.body);const key='ATTEMPT:'+mockId+':'+sid(req);const result=await transaction(db,async tx=>{await lock(tx,key);const attempt=await tx.portalRecord.findUnique({where:{key}});if(!attempt)fail(404,'NOT_FOUND','Start the mock first.');const a=attempt.data as any;const m=(await tx.portalRecord.findUniqueOrThrow({where:{key:'MOCK:'+mockId}})).data as any;if(a.submitted)return {submitted:true};const paper=paperOf(a,m.questions);const expired=Date.now()>new Date(a.deadline).getTime()+5000;if(!expired&&answers.length!==paper.order.length)fail(400,'ANSWERS','Send one answer for each question.');/* A late submission is marked on the answers saved before time ran out. */const final=normalisedAnswers(paper,expired?a.answers:answers);await tx.portalRecord.update({where:{id:attempt.id},data:{data:json({...a,submitted:true,submittedAt:new Date().toISOString(),answers:final,expired,score:gradePaper(m.questions,paper,final),maximum:paper.order.length})}});await audit(tx,req.principal!.id,'MOCK_SUBMITTED','PortalRecord',attempt.id,req.ip||'');return {submitted:true,expired};});res.json(result);}));
  r.get('/results',wrap(async(req,res)=>{const manual=(await list(db,'RESULT',sid(req))).filter(row=>(row.data as any).published).map(row=>({id:row.id,...row.data as any}));const attempts=await list(db,'ATTEMPT',sid(req));for(const row of attempts){const a=row.data as any;if(!a.submitted)continue;const mockData=(await db.portalRecord.findUnique({where:{key:'MOCK:'+a.mockId}}))?.data as any;if(mockData?.releaseResults)manual.push({id:row.id,...a});}res.json(manual);}));
  r.get('/proofs',wrap(async(req,res)=>res.json(await list(db,'PROOF',sid(req)))));
  r.post('/proofs',wrap(async(req,res)=>{const data=parse(z.object({reference:z.string().min(5).max(120),documentId:id,paidAt:z.string().date(),note:z.string().max(500)}).strict(),req.body);const payment=await db.payment.findUnique({where:{reference:data.reference}});if(!payment||payment.studentId!==sid(req)||payment.provider!=='BANK'||payment.status!=='PENDING')fail(404,'PAYMENT_UNAVAILABLE','Pending bank payment unavailable.');const file=await db.document.findUnique({where:{id:data.documentId}});if(!file||file.ownerId!==req.principal!.id||file.public||!['PENDING','APPROVED'].includes(file.status)||!file.mime.startsWith('image/'))fail(422,'PROOF_INVALID','Upload your own validated private receipt image first.');await db.document.update({where:{id:file.id},data:{type:'BANK_PROOF'}});res.json(await write(req,'PROOF:'+payment.reference,'PROOF',{...data,status:'AWAITING_REVIEW'},sid(req)));}));
 }
 return r;
}
