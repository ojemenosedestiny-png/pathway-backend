import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bankFor,bankKey} from '../src/learning.js';

const fakeDb=(records:Record<string,unknown>)=>({portalRecord:{findUnique:async({where}:{where:{key:string}})=>records[where.key]===undefined?null:{data:records[where.key]}}}) as any;
const account=(bankName:string,active=true)=>({bankName,accountName:'New World Emerald Private School',accountNumber:'0123456789',instructions:'',active});

test('existing single account keeps its storage key as the school fees account', () => {
 assert.equal(bankKey('GENERAL'),'bank');assert.equal(bankKey('HOSTEL'),'bank:HOSTEL');assert.equal(bankKey('APPLICATION'),'bank:APPLICATION');
});

test('each payment uses its own active account and falls back to school fees', async () => {
 const db=fakeDb({bank:account('Fees Bank'),'bank:HOSTEL':account('Hostel Bank'),'bank:APPLICATION':account('Application Bank',false)});
 assert.equal((await bankFor(db,'HOSTEL'))?.bankName,'Hostel Bank');assert.equal((await bankFor(db,'HOSTEL'))?.purpose,'HOSTEL');
 const application=await bankFor(db,'APPLICATION');assert.equal(application?.bankName,'Fees Bank');assert.equal(application?.purpose,'GENERAL');
 assert.equal((await bankFor(db,'GENERAL'))?.bankName,'Fees Bank');
});

test('no published account returns nothing rather than an unconfirmed account', async () => {
 const db=fakeDb({bank:account('Fees Bank',false),'bank:HOSTEL':account('Hostel Bank',false)});
 assert.equal(await bankFor(db,'HOSTEL'),null);assert.equal(await bankFor(db,'GENERAL'),null);
});
