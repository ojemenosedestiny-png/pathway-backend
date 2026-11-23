import test from 'node:test';
import assert from 'node:assert/strict';
import {friendlyPassword,checkRows,placeholderEmail} from '../src/student-accounts.js';

const fakeDb=(taken:string[]=[])=>({user:{findMany:async({where}:any)=>where.email.in.filter((e:string)=>taken.includes(e)).map((email:string)=>({email}))}}) as any;

test('temporary passwords are friendly, at least 12 characters and vary',()=>{
 for(let i=0;i<200;i++){const p=friendlyPassword();assert.match(p,/^[A-Z][a-z]+-\d{4}$/);assert.ok(p.length>=12,p);}
 assert.equal(friendlyPassword(max=>max-1),'Sunbird-9999');
 assert.ok(new Set(Array.from({length:50},()=>friendlyPassword())).size>40);
});

test('every row is checked and all its problems are listed',async()=>{
 const rows=await checkRows(fakeDb(['taken@example.org']),[
  {firstName:'Ada',lastName:'Okafor',email:'ADA@example.org',programme:'WAEC',cohort:'SS3 2026'},
  {firstName:'',lastName:'Bello',email:'not-an-email'},
  {firstName:'Chidi',lastName:'Eze',email:'ada@example.org'},
  {firstName:'Dayo',lastName:'Ade',email:'taken@example.org',phone:'12'},
  {firstName:'Efe',lastName:'Obi'},
 ]);
 assert.deepEqual(rows.map(r=>r.errors),[
  [],
  ['First name is missing.','Email address is not valid.'],
  ['Same email as row 1.'],
  ['Phone number is not valid.'],
  [],
 ]);
 assert.equal(rows[0].value!.email,'ada@example.org');
 assert.equal(rows[4].value!.email,'');
});

test('the taken-email check runs for valid rows',async()=>{
 const rows=await checkRows(fakeDb(['taken@example.org']),[{firstName:'Dayo',lastName:'Ade',email:'taken@example.org'}]);
 assert.deepEqual(rows[0].errors,['This email already has an account.']);
});

test('students without email get an undeliverable placeholder',()=>{
 assert.equal(placeholderEmail('NWE-2026-000123'),'nwe-2026-000123@students.invalid');
});
