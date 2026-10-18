import type {Prisma} from '@prisma/client';
import {lock} from './database.js';
import {fail} from './core.js';

/** Shared transactional guards replace PostgreSQL foreign-key/exclusion safeguards. */
export async function guardCatalogWrite(tx:Prisma.TransactionClient,resource:string,data:any,before?:any){
  await lock(tx,'catalog');
  if(resource==='rooms'&&before)await lock(tx,'Room:'+before.id);
  if(resource==='exams'&&before)await lock(tx,'Exam:'+before.id);
  if(resource==='slots'){
    if(before)await lock(tx,'ConsultationSlot:'+before.id);
    for(const advisor of [...new Set([before?.advisorId,data.advisorId].filter(Boolean))].sort())await lock(tx,'advisor:'+advisor);
    if(data.active!==false&&await tx.consultationSlot.count({where:{advisorId:data.advisorId,active:true,startsAt:{lt:data.endsAt},endsAt:{gt:data.startsAt},...before?{id:{not:before.id}}:{}}}))fail(409,'ADVISOR_OVERLAP','This advisor already has a slot overlapping those times.');
  }
  const parent=resource==='universities'?['country','countryId']:resource==='courses'?['university','universityId']:resource==='rooms'?['hostel','hostelId']:null;
  if(parent&&!await (tx as any)[parent[0]].findUnique({where:{id:data[parent[1]]}}))fail(422,'PARENT_NOT_FOUND','Select an existing parent record.');
  if(resource==='exams'&&before&&data.capacity<before.capacity&&await tx.examEnrolment.count({where:{examId:before.id,status:{not:'CANCELLED'}}})>data.capacity)fail(409,'EXAM_CAPACITY','Capacity cannot be lower than existing enrolments.');
}
export async function guardCatalogDelete(tx:Prisma.TransactionClient,resource:string,before:any){
  await lock(tx,'catalog');
  if(resource==='rooms')await lock(tx,'Room:'+before.id);
  if(resource==='exams')await lock(tx,'Exam:'+before.id);
  if(resource==='slots'){await lock(tx,'ConsultationSlot:'+before.id);await lock(tx,'advisor:'+before.advisorId);}
  const relations:Record<string,[string,string][]>= {
    countries:[['university','countryId']],universities:[['course','universityId'],['application','universityId']],courses:[['application','courseId']],hostels:[['room','hostelId']],rooms:[['hostelBooking','roomId']],exams:[['examEnrolment','examId'],['payment','examId']],fees:[['payment','feeId']],slots:[['consultationBooking','originalSlotId'],['consultationBooking','slotId']],announcements:[['announcementRead','announcementId']],
  };
  for(const [model,field]of relations[resource]||[])if(await (tx as any)[model].count({where:{[field]:before.id}}))fail(409,'RECORD_IN_USE','This record has related history. Retire or archive it instead of deleting.');
}
