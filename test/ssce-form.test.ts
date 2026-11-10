import test from 'node:test';
import assert from 'node:assert/strict';
import {ssceFormSchema,compulsorySubjects} from '../src/ssce.js';

const valid={examBody:'WAEC_NECO',surname:'Okafor',firstName:'Destiny',middleName:'Ada',dateOfBirth:'2009-03-14',stateOfOrigin:'Anambra',lga:'Awka South',gender:'Female',nin:'12345678901',electives:['Biology','Chemistry','Physics','Economics','Government'],phone:'08031234567',signature:'Destiny Ada Okafor',declaration:true};
const errors=(input:unknown)=>{const result=ssceFormSchema.safeParse(input);return result.success?[]:result.error.issues.map(issue=>issue.path.join('.'));};

test('a complete form matching the school paper form is accepted',()=>{
 assert.deepEqual(errors(valid),[]);
 assert.deepEqual([...compulsorySubjects],['Mathematics','English Language','Civic Education','Livestock Farming']);
});

test('subjects total 7 to 9: three to five chosen on top of the four printed subjects',()=>{
 assert.deepEqual(errors({...valid,electives:['Biology','Chemistry']}),['electives']);
 assert.deepEqual(errors({...valid,electives:['Biology','Chemistry','Physics','Economics','Government','Commerce']}),['electives']);
 assert.deepEqual(errors({...valid,electives:['Biology','Biology','Physics']}),['electives']);
 assert.deepEqual(errors({...valid,electives:['Biology','Chemistry','Astrology']}),['electives.2']);
});

test('identity fields are checked',()=>{
 assert.deepEqual(errors({...valid,nin:'1234'}),['nin']);
 assert.deepEqual(errors({...valid,dateOfBirth:'2999-01-01'}),['dateOfBirth']);
 assert.deepEqual(errors({...valid,stateOfOrigin:'Atlantis'}),['stateOfOrigin']);
 assert.ok(errors({...valid,surname:'0kafor1',signature:'Destiny 0kafor1'}).includes('surname'));
 assert.deepEqual(errors({...valid,declaration:false}),['declaration']);
});

test('the typed signature must include the surname',()=>{
 assert.deepEqual(errors({...valid,signature:'Someone Else'}),['signature']);
 assert.deepEqual(errors({...valid,signature:'destiny okafor'}),[]);
});
