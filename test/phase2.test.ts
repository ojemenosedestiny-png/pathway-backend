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
