import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {assigned,stateOf,closedForEveryone,questionsFromRows,sheetRows,withDefaults,finalise,bandOf,mockSchema} from '../src/mock-exams.js';
import {drawPaper,markPaper,paperQuestions} from '../src/learning.js';

const iso=(minutes:number)=>new Date(Date.now()+minutes*60000).toISOString();
const base=withDefaults({title:'Maths',subject:'Mathematics',durationMinutes:30,opensAt:iso(-10),closesAt:iso(60),published:true,questions:[{prompt:'2+2',options:['3','4'],answer:1,marks:2},{prompt:'3+3',options:['6','7','8'],answer:0}]});

test('only assigned students see an exam: named students, else the cohort, else everyone',()=>{
 assert.equal(assigned(base,{id:'a',cohort:null}),true);
 assert.equal(assigned({...base,cohort:'SS3 2026'},{id:'a',cohort:'ss3 2026'}),true);
 assert.equal(assigned({...base,cohort:'SS3 2026'},{id:'a',cohort:'SS2'}),false);
 assert.equal(assigned({...base,cohort:'SS3',studentIds:['b']},{id:'a',cohort:'SS3'}),false,'named students override the cohort');
 assert.equal(assigned({...base,studentIds:['b']},{id:'b'}),true);
 assert.equal(assigned({...base,studentIds:['b']},{id:'a'},{opensAt:iso(0),closesAt:iso(30)}),true,'a make-up window counts as assignment');
});

test('windows: upcoming, open, closed, and a make-up has its own window',()=>{
 assert.equal(stateOf({...base,opensAt:iso(5)},null),'UPCOMING');
 assert.equal(stateOf(base,null),'OPEN');
 assert.equal(stateOf({...base,closesAt:iso(-1)},null),'CLOSED');
 assert.equal(stateOf({...base,closesAt:iso(-1)},{opensAt:iso(-5),closesAt:iso(20)}),'OPEN');
 assert.equal(closedForEveryone({...base,closesAt:iso(-1)},[]),true);
 assert.equal(closedForEveryone({...base,closesAt:iso(-1)},[{opensAt:iso(-5),closesAt:iso(20)}]),false,'review waits for make-ups');
});

test('marks per question and shuffle settings, with the key never on the student paper',()=>{
 const fixed=drawPaper(base.questions,{shuffleQuestions:false,shuffleOptions:false});
 assert.deepEqual(fixed,{order:[0,1],optionOrders:[[0,1],[0,1,2]]});
 assert.deepEqual(markPaper(base.questions,fixed,[1,0]),{score:3,maximum:3});
 assert.deepEqual(markPaper(base.questions,fixed,[0,-1]),{score:0,maximum:3});
 const paper=paperQuestions(base.questions,fixed);
 assert.ok(paper.every(q=>!('answer' in q)&&!('explanation' in q)));
 assert.equal(paper[0].marks,2);
 const subset=drawPaper(base.questions,{perAttempt:1,shuffleQuestions:false});assert.equal(subset.order.length,1);
 assert.equal(bandOf(50,50),'PASS');assert.equal(bandOf(49.9,50),'BELOW_PASS');
});

test('options 2 to 8, distinct, answer must match; older mocks get safe defaults',()=>{
 const ok=mockSchema.safeParse({...base,questions:[{prompt:'Q',options:['a','b','c','d','e','f','g','h'],answer:7}]});assert.ok(ok.success);
 const nine=mockSchema.safeParse({...base,questions:[{prompt:'Q',options:['1','2','3','4','5','6','7','8','9'],answer:0}]});assert.equal(nine.success,false);
 const dupe=mockSchema.safeParse({...base,questions:[{prompt:'Q',options:['Yes','yes'],answer:0}]});assert.equal(dupe.success,false);
 assert.equal(withDefaults({}).shuffleQuestions,true);assert.equal(withDefaults({}).passMark,50);
});

test('sheet import reports problems per row and never rewrites text',()=>{
 const rows=questionsFromRows([
  ['Question','A','B','C','D','Answer','Marks','Passage'],
  ['  What is 7 × 8?','54','56','','','b','',''],
  ['Gap','1','','3','','A','1',''],
  ['Dupes','Yes','yes','','','A','1',''],
  ['Wrong answer','x','y','','','C','1',''],
  ['','x','y','','','A','1',''],
  ['Bad marks','x','y','','','A','ten',''],
  ['Read it','Happy','Sad','','','A','2','Ada smiled.'],
 ]);
 assert.equal(rows[0].question!.prompt,'What is 7 × 8?');assert.equal(rows[0].question!.answer,1);assert.deepEqual(rows[0].warnings,['No marks given: 1 mark.']);
 assert.match(rows[1].problems.join(' '),/Choice B is empty but a later choice is filled/);
 assert.match(rows[2].problems.join(' '),/Choice B repeats an earlier choice/);
 assert.match(rows[3].problems.join(' '),/Answer "C" does not match a filled choice/);
 assert.match(rows[4].problems.join(' '),/The question is empty/);
 assert.match(rows[5].problems.join(' '),/Marks "ten"/);
 assert.equal(rows[6].question!.passage,'Ada smiled.');assert.equal(rows[6].question!.marks,2);
 assert.deepEqual(rows.map(r=>r.row),[2,3,4,5,6,7,8]);
 assert.throws(()=>questionsFromRows([['Prompt','A']]),/headings/);
});

test('reads both .xlsx and CSV files',async()=>{
 const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Q');sheet.addRow(['Question','A','B','Answer']);sheet.addRow(['Capital of Nigeria?','Lagos','Abuja','B']);
 const xlsx=Buffer.from(await book.xlsx.writeBuffer());
 const fromXlsx=questionsFromRows(await sheetRows(xlsx));assert.equal(fromXlsx[0].question!.options[1],'Abuja');
 const fromCsv=questionsFromRows(await sheetRows(Buffer.from('Question,A,B,Answer\r\n"Pick ""one""",Yes,"No, never",A\r\n')));
 assert.equal(fromCsv[0].question!.prompt,'Pick "one"');assert.equal(fromCsv[0].question!.options[1],'No, never');
});

test('an attempt past its deadline is marked on the answers saved before time ran out',async()=>{
 let saved:any;const db:any={portalRecord:{update:async({data}:any)=>{saved=data.data;}}};
 const row={id:'r1',data:{mockId:'m',deadline:iso(-1),order:[0,1],optionOrders:[[0,1],[0,1,2]],answers:[1,2],submitted:false}};
 const result=await finalise(db,row,base);
 assert.equal(result.submitted,true);assert.equal(result.expired,true);assert.equal(result.score,2);assert.equal(result.maximum,3);assert.equal(saved.autoSubmitted,true);
 const writing={id:'r2',data:{...row.data,deadline:iso(5)}};assert.equal((await finalise(db,writing,base)).submitted,false);
});
