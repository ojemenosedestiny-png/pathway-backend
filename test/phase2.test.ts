import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {defaultPermissions} from '../src/auth.js';

test('Phase 2 invoice totals reject mixed currencies, negative lines and zero totals',async()=>{
 const {calculateInvoice}=await import('../src/invoices.js');
 const item=(amountMinor:bigint,currency='NGN')=>({description:'Test line',sourceId:crypto.randomUUID(),amountMinor,currency});
 assert.deepEqual(calculateInvoice([item(100n),item(25n)]),{amountMinor:125n,currency:'NGN'});
 for(const items of[[],[item(0n)],[item(-1n)],[item(1n),item(2n,'USD')]])assert.throws(()=>calculateInvoice(items));
 assert.ok(defaultPermissions.EXAMS_OFFICER.read.includes('exams'));
 assert.ok(!defaultPermissions.EXAMS_OFFICER.write.includes('payments'));
});


test('student welcome email includes the ID, login and recovery links without sending a password',async()=>{
 const {runJob}=await import('../src/jobs.js');const original=globalThis.fetch;let sent:any;
 globalThis.fetch=async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response('{}',{status:200});};
 try{await runJob({} as any,{RESEND_API_KEY:'synthetic-key',EMAIL_FROM:'NewworldPathway <noreply@mail.example.test>'} as any,'EMAIL','student-id-issued:synthetic',{to:'student@example.test',template:'student-ready',studentId:'PU-2026-000001',link:'https://example.test/student/login',resetLink:'https://example.test/forgot-password'});
 assert.equal(sent.subject,'Your NewworldPathway Student ID');assert.match(sent.html,/PU-2026-000001/);assert.match(sent.html,/href="https:\/\/example.test\/student\/login"/);assert.match(sent.html,/href="https:\/\/example.test\/forgot-password"/);assert.match(sent.html,/password you created/);assert.equal(sent.to[0],'student@example.test');
 }finally{globalThis.fetch=original;}
});
