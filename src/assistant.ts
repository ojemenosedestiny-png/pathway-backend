import {Router} from 'express';
import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {wrap,parse,fail,audit,transaction,rate,type Config} from './core.js';
import {aiConfigured,aiRespond} from './ai.js';

/**
 * Owner-only workspace assistant. It reads aggregate counts (no names, emails or payment
 * references) and reports health checks. It never changes records: staff act through the
 * normal permission-checked pages that each check links to.
 */
export type Severity='critical'|'warning'|'info'|'ok';
export interface Check {id:string;severity:Severity;title:string;detail:string;module:string}

const counts=(rows:{status:string;_count:{_all:number}}[])=>Object.fromEntries(rows.map(row=>[row.status,row._count._all])) as Record<string,number>;
const sum=(values:Record<string,number>,keys:string[])=>keys.reduce((total,key)=>total+(values[key]||0),0);

export async function schoolSnapshot(db:PrismaClient,now=new Date()){
 const day=864e5,since7=new Date(now.getTime()-7*day),since30=new Date(now.getTime()-30*day),since3=new Date(now.getTime()-3*day);
 const [students,newStudents,applicants,admissions,payments,revenue,documents,consultations,announcements,staleDrafts,countries,universities,courses,exams,fees,outbox,activity,records]=await Promise.all([
  db.student.count(),db.student.count({where:{createdAt:{gte:since7}}}),db.applicant.count(),
  db.admissionApplication.groupBy({by:['status'],_count:{_all:true}}),
  db.payment.groupBy({by:['status'],_count:{_all:true}}),
  db.payment.findMany({where:{status:'SUCCESS',currency:'NGN',verifiedAt:{gte:since30}},select:{amountMinor:true}}),
  db.document.groupBy({by:['status'],_count:{_all:true}}),
  db.consultationRequest.groupBy({by:['status'],_count:{_all:true}}),
  db.announcement.groupBy({by:['status'],_count:{_all:true}}),
  db.announcement.count({where:{status:'DRAFT',createdAt:{lt:since3}}}),
  db.country.count(),db.university.count({where:{active:true}}),db.course.count({where:{active:true}}),
  db.exam.count({where:{active:true}}),db.fee.findMany({where:{active:true},select:{id:true}}),
  db.outbox.groupBy({by:['status'],_count:{_all:true}}),
  db.auditLog.groupBy({by:['action','entity'],where:{at:{gte:since7}},_count:{_all:true}}),
  db.portalRecord.findMany({where:{kind:{in:['MOCK','ATTEMPT','MATERIAL','MOTIVATION','PROOF','REGISTRATION','FEE_SCHEDULE','BANK']}},select:{kind:true,key:true,data:true,createdAt:true},take:3000}),
 ]);
 const of=(kind:string)=>records.filter(row=>row.kind===kind).map(row=>({...row,data:(row.data||{}) as any}));
 const proofs=of('PROOF');const proofPayments=proofs.length?await db.payment.findMany({where:{reference:{in:proofs.map(p=>String(p.data.reference))}},select:{status:true}}):[];
 const mocks=of('MOCK'),attempts=of('ATTEMPT');const t=now.getTime();
 const submitted=attempts.filter(a=>a.data.submitted);const recent=submitted.filter(a=>new Date(a.data.submittedAt||a.createdAt).getTime()>=since7.getTime());
 const scheduled=new Set(of('FEE_SCHEDULE').map(row=>row.data.feeId));
 const bank=records.find(row=>row.key==='bank');
 const mockIds=(mock:{key:string})=>mock.key.slice(5);
 const outboxCounts=counts(outbox as any),admissionCounts=counts(admissions as any),documentCounts=counts(documents as any),consultationCounts=counts(consultations as any),paymentCounts=counts(payments as any);
 return {
  generatedAt:now.toISOString(),
  people:{students,newStudentsLast7Days:newStudents,applicantAccounts:applicants,admissionApplications:admissionCounts,admissionsAwaitingDecision:sum(admissionCounts,['SUBMITTED','UNDER_REVIEW'])},
  money:{paymentsByStatus:paymentCounts,verifiedNgnLast30Days:(revenue.reduce((total,row)=>total+BigInt(row.amountMinor),0n)/100n).toString(),activeFees:fees.length,activeFeesWithoutSchedule:fees.filter(fee=>!scheduled.has(fee.id)).length,bankDetailsPublished:Boolean((bank?.data as any)?.active),transferReceiptsAwaitingReview:proofPayments.filter(p=>p.status==='PENDING').length},
  admissionsWork:{documentsByStatus:documentCounts,documentsAwaitingReview:documentCounts.PENDING||0,visitorConsultationsByStatus:consultationCounts,newVisitorConsultations:consultationCounts.NEW||0},
  catalogue:{countries,activeUniversities:universities,activeCourses:courses,activeExams:exams},
  communication:{noticesByStatus:counts(announcements as any),draftNoticesOlderThan3Days:staleDrafts,messageDeliveryByStatus:outboxCounts,failedDeliveries:outboxCounts.DEAD||0},
  learning:{mockExams:mocks.length,publishedMocks:mocks.filter(m=>m.data.published).length,mocksOpenNow:mocks.filter(m=>m.data.published&&new Date(m.data.opensAt).getTime()<=t&&t<=new Date(m.data.closesAt).getTime()).length,
   closedMocksWithUnreleasedResults:mocks.filter(m=>new Date(m.data.closesAt).getTime()<t&&!m.data.releaseResults&&submitted.some(a=>a.data.mockId===mockIds(m))).length,
   attemptsStarted:attempts.length,attemptsSubmitted:submitted.length,attemptsSubmittedLast7Days:recent.length,
   averageScorePercentLast7Days:recent.length?Math.round(recent.reduce((total,a)=>total+(a.data.maximum?a.data.score/a.data.maximum:0),0)/recent.length*100):null,
   publishedStudyMaterials:of('MATERIAL').filter(m=>m.data.published).length,publishedEncouragements:of('MOTIVATION').filter(m=>m.data.published).length,
   registrationsSubmitted:of('REGISTRATION').filter(r=>r.data.submitted).length,registrationsInDraft:of('REGISTRATION').filter(r=>!r.data.submitted).length},
  staffActivityLast7Days:activity.map(row=>({action:row.action,entity:row.entity,count:row._count._all})).sort((a,b)=>b.count-a.count).slice(0,25),
 };
}
export type Snapshot=Awaited<ReturnType<typeof schoolSnapshot>>;

export function healthChecks(s:Snapshot,aiReady:boolean):Check[]{
 const checks:Check[]=[];const add=(id:string,severity:Severity,title:string,detail:string,module:string)=>checks.push({id,severity,title,detail,module});
 const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
 if(s.communication.failedDeliveries)add('delivery','critical','Messages are failing to send',`${plural(s.communication.failedDeliveries,'email or SMS job')} stopped after repeated failures. Check the email and SMS provider settings.`,'audit');
 if(!s.money.bankDetailsPublished)add('bank','warning','Bank details are not published','Students cannot pay school fees by transfer until the school account is published.','bank-details');
 if(s.money.transferReceiptsAwaitingReview)add('receipts','warning','Transfer receipts are waiting',`${plural(s.money.transferReceiptsAwaitingReview,'student transfer receipt')} need checking against the bank statement.`,'bank-details');
 if(!s.money.activeFees)add('fees','warning','No fees are published','Students have no fees to view or pay.','fees');
 else if(s.money.activeFeesWithoutSchedule)add('fee-schedule','info','Some fees have no class or term',`${plural(s.money.activeFeesWithoutSchedule,'active fee')} show no class, term or session to students.`,'fees');
 if(s.admissionsWork.newVisitorConsultations)add('consultations','warning','New consultation requests',`${plural(s.admissionsWork.newVisitorConsultations,'visitor')} asked for a consultation and have not been contacted.`,'consultation-requests');
 if(s.people.admissionsAwaitingDecision)add('admissions','info','Applications awaiting a decision',`${plural(s.people.admissionsAwaitingDecision,'application')} are submitted or under review.`,'applicants');
 if(s.admissionsWork.documentsAwaitingReview)add('documents','info','Documents awaiting review',`${plural(s.admissionsWork.documentsAwaitingReview,'student document')} need a decision.`,'documents');
 if(s.catalogue.countries&&!s.catalogue.activeUniversities)add('universities','warning','No universities in the catalogue','Destinations exist but no universities do, so courses cannot be created and students see none.','universities');
 else if(s.catalogue.activeUniversities&&!s.catalogue.activeCourses)add('courses','warning','No courses are published','Students starting a university application will see “No courses have been published yet”.','courses');
 if(s.communication.draftNoticesOlderThan3Days)add('drafts','info','Old draft notices',`${plural(s.communication.draftNoticesOlderThan3Days,'notice')} has been in draft for more than three days. Publish or archive it.`,'announcements');
 if(s.learning.closedMocksWithUnreleasedResults)add('mock-results','info','Mock results not released',`${plural(s.learning.closedMocksWithUnreleasedResults,'closed mock examination')} has submissions but results are hidden from students.`,'mock-exams');
 if(!s.learning.publishedMocks)add('mocks','info','No mock examinations published','Students have no mock examinations to practise with.','mock-exams');
 if(!aiReady)add('ai','info','AI summaries are not connected','Health checks work without AI. Add OPENAI_API_KEY to the backend service to enable written briefings and questions.','assistant');
 if(checks.every(check=>check.id==='ai'))add('ok','ok','Everything looks in order','No problems were found in the areas the assistant checks.','dashboard');
 const order:Record<Severity,number>={critical:0,warning:1,info:2,ok:3};return checks.sort((a,b)=>order[a.severity]-order[b.severity]);
}

const instructions=`You are the operations assistant inside the staff workspace of New World Emerald Private School (NewworldPathway), Kubwa, Abuja. The school prepares students for WAEC, NECO and Cambridge examinations and guides study abroad.
You receive a JSON snapshot of aggregate school records and a list of automated health checks. Rules:
- Use only the figures in the snapshot. If something is not in the data, say you do not have that information. Never invent numbers, names or events.
- You cannot change anything. When action is needed, name the workspace page to open (for example "Bank & transfer receipts", "Applicants", "Mock examinations").
- Money values are Nigerian naira (NGN).
- Write plain text for a busy school owner: short sections titled "Summary", "Needs attention" and "Suggested next steps", using "- " bullets. No tables, no bold or markdown symbols. Stay under 250 words unless the owner asks for more.
- When the owner asks a specific question, answer it directly first.`;
const briefingSchema=z.object({question:z.string().trim().max(600).optional(),history:z.array(z.object({question:z.string().max(600),answer:z.string().max(4000)}).strict()).max(6).default([])}).strict();

export function assistantRouter(db:PrismaClient,config:Config,send?:typeof fetch){
 const r=Router();
 r.use((req,_res,next)=>{if(req.principal?.adminRole!=='SUPER_ADMIN')fail(403,'OWNER_REQUIRED','The workspace assistant is available to the school owner.');next();});
 r.get('/',wrap(async(_req,res)=>{const snapshot=await schoolSnapshot(db);res.json({aiConfigured:aiConfigured(config),model:aiConfigured(config)?config.OPENAI_MODEL:null,snapshot,checks:healthChecks(snapshot,aiConfigured(config))});}));
 r.post('/briefing',wrap(async(req,res)=>{
  const {question,history}=parse(briefingSchema,req.body);
  await rate(db,'assistant:'+req.principal!.id,30,3600);
  const snapshot=await schoolSnapshot(db);const checks=healthChecks(snapshot,true);
  const conversation=history.map(turn=>`Owner asked: ${turn.question}\nYou answered: ${turn.answer}`).join('\n\n');
  const answer=await aiRespond(config,{instructions,content:[{type:'input_text',text:`School snapshot:\n${JSON.stringify(snapshot)}\n\nHealth checks:\n${JSON.stringify(checks.map(({severity,title,detail})=>({severity,title,detail})))}${conversation?`\n\nEarlier in this session:\n${conversation}`:''}\n\nOwner's request: ${question||'Give me today\'s briefing on school activity and anything that needs my attention.'}`}],maxOutputTokens:3000},send);
  await transaction(db,tx=>audit(tx,req.principal!.id,'AI_BRIEFING','Assistant','briefing',req.ip||'',undefined,{questionLength:question?.length||0}));
  res.json({answer:answer.trim(),generatedAt:snapshot.generatedAt,model:config.OPENAI_MODEL});
 }));
 return r;
}
