import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startJobRunner} from '../src/job-runner.js';
const pause = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
test('runner drains sequentially and stop waits for the active delivery', async () => {
 let release!:()=>void;const active=new Promise<void>(resolve=>release=resolve);
 let began!:()=>void;const started=new Promise<void>(resolve=>began=resolve);
 let jobs=0;let schedules=0;
 const runner=startJobRunner({schedule:async()=>{schedules++;},work:async()=>{jobs++;began();await active;return 1;},onError:error=>{throw error;}});
 await started;let stopped=false;const stopping=runner.stop().then(()=>stopped=true);
 await pause(10);assert.equal(stopped,false);assert.equal(jobs,1);
 release();await stopping;assert.equal(stopped,true);assert.equal(jobs,1);assert.equal(schedules,1);
});
test('idle sleep can be interrupted immediately on shutdown', async()=>{
 let began!:()=>void;const started=new Promise<void>(resolve=>began=resolve);
 const runner=startJobRunner({schedule:async()=>{},work:async()=>{began();return 0;},idleMs:60000,onError:()=>{}});
 await started;await pause(0);await Promise.race([runner.stop(),pause(1000).then(()=>{throw Error('Idle shutdown did not wake');})]);
});
test('failed jobs retry without overlapping or terminating the loop',async()=>{
 let completed!:()=>void;const success=new Promise<void>(resolve=>completed=resolve);let attempts=0;let failures=0;
 const runner=startJobRunner({schedule:async()=>{},retryMs:1,idleMs:60000,work:async()=>{if(++attempts===1)throw Error('Delivery unavailable');completed();return 0;},onError:()=>failures++});
 await success;await runner.stop();assert.equal(failures,1);assert.equal(attempts,2);
});
