import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureUkUniversities} from '../src/catalogue-seed.js';

function fakeDb(universities:{name:string}[]=[]){
 const locks=new Set<string>();const countries=[{id:'uk',name:'United kingdom',code:'UK',featured:true}];const created:any[]=[];const courses:any[]=[];
 const db:any={
  databaseLock:{findUnique:async({where}:any)=>locks.has(where.key)?{key:where.key}:null,upsert:async({where}:any)=>{locks.add(where.key);}},
  country:{findMany:async()=>countries,create:async({data}:any)=>{const row={id:'new',...data};countries.push(row);return row;}},
  university:{findMany:async()=>[...universities,...created],create:async({data}:any)=>{const row={id:'u'+created.length,...data};created.push(row);return row;}},
  course:{create:async({data}:any)=>{courses.push(data);return data;}},
 };
 return {db,created,courses,countries};
}

test('adds Stirling and Newcastle once, under the existing UK destination, without fees',async()=>{
 const f=fakeDb();await ensureUkUniversities(f.db);await ensureUkUniversities(f.db);
 assert.deepEqual(f.created.map(u=>u.name),['University of Stirling','Newcastle University']);
 assert.ok(f.created.every(u=>u.countryId==='uk'&&u.tuitionMinor===0n&&u.active&&u.image.startsWith('/assets/universities/')));
 assert.equal(f.courses.length,10);assert.equal(f.countries.length,1,'reuses the existing United Kingdom');
});

test('skips a university staff already created',async()=>{
 const f=fakeDb([{name:'newcastle university'}]);await ensureUkUniversities(f.db);
 assert.deepEqual(f.created.map(u=>u.name),['University of Stirling']);
});
