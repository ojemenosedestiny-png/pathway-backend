import test from 'node:test';
import assert from 'node:assert/strict';
import {missingRegistrationFields} from '../src/learning.js';
import {unreadFor} from '../src/messages.js';
import {checkRoomPhotos} from '../src/admin.js';
import {redactDeliveryError} from '../src/jobs.js';

test('a registration draft may be incomplete; submission lists every missing required field',()=>{
 assert.deepEqual(missingRegistrationFields({address:'',currentSchool:'',currentLevel:'',programme:'',guardianName:'',guardianPhone:'',notes:'Only this'}),['Home address','Current or most recent school','Current class or qualification','Preparation programme','Parent or guardian name','Parent or guardian phone']);
 assert.deepEqual(missingRegistrationFields({address:'1 Road',currentSchool:'NWE',currentLevel:'SS3',programme:'WAEC',guardianName:'Ada',guardianPhone:'08030000000'}),[]);
 assert.deepEqual(missingRegistrationFields({address:'   ',currentSchool:'NWE',currentLevel:'SS3',programme:'WAEC',guardianName:'Ada',guardianPhone:'08030000000'}),['Home address']);
});

test('a thread is unread only for replies from the other side after the read point',()=>{
 const at=(minute:number)=>new Date(Date.UTC(2026,9,23,10,minute));
 const thread={messages:[{authorId:'student',createdAt:at(0)},{authorId:'staff',createdAt:at(5)}]};
 const fromStaff=(author:string)=>author!=='student';
 assert.equal(unreadFor(thread,null,fromStaff),true);
 assert.equal(unreadFor(thread,at(5),fromStaff),false);
 assert.equal(unreadFor({messages:[...thread.messages,{authorId:'staff',createdAt:at(9)}]},at(5),fromStaff),true,'a later reply makes it unread again');
 assert.equal(unreadFor({messages:[{authorId:'student',createdAt:at(9)}]},null,fromStaff),false,'own messages never count');
});

test('room photographs must come from the school media library',()=>{
 const config={PUBLIC_MEDIA_BASE:'https://media.example.org'};
 assert.doesNotThrow(()=>checkRoomPhotos([{url:'https://media.example.org/public/a/file.webp',alt:'Room 2 at Nile Paradise',cover:true}],config));
 assert.throws(()=>checkRoomPhotos([{url:'https://www.pinterest.com/pin/232850243236928052/',alt:'2'}],config),(e:any)=>e.code==='ROOM_PHOTO_SOURCE');
 assert.throws(()=>checkRoomPhotos(['http://media.example.org/public/a.jpg'],config),(e:any)=>e.code==='ROOM_PHOTO_SOURCE');
 assert.throws(()=>checkRoomPhotos(['https://media.example.org.evil.test/a.jpg'],config),(e:any)=>e.code==='ROOM_PHOTO_SOURCE');
 assert.doesNotThrow(()=>checkRoomPhotos(undefined,config));
});

test('delivery errors keep the reason but never the recipient',()=>{
 const text=redactDeliveryError('Email provider rejected delivery (403): You can only send testing emails to your own email address (owner@example.com). Number +234 803 123 4567 is invalid');
 assert.match(text,/403/);assert.match(text,/testing emails/);
 assert.doesNotMatch(text,/owner@example\.com/);assert.doesNotMatch(text,/803 123 4567/);
});
