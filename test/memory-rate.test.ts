import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryRate} from '../src/core.js';

test('in-memory API limiter blocks above the limit, resets after the window and keeps callers separate', () => {
 let time=1_000_000;const limit=memoryRate(3,60,()=>time);
 for(let i=0;i<3;i++)limit('api:1.1.1.1');
 assert.throws(()=>limit('api:1.1.1.1'),(e:any)=>e.status===429&&e.code==='RATE_LIMIT');
 limit('api:2.2.2.2');
 time+=60_000;limit('api:1.1.1.1');
});
