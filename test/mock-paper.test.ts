import {test} from 'node:test';
import assert from 'node:assert/strict';
import {drawPaper,paperOf,paperQuestions,gradePaper} from '../src/learning.js';
import {aiRespond} from '../src/ai.js';
import {healthChecks} from '../src/assistant.js';

const questions=Array.from({length:10},(_,q)=>({prompt:'Question '+q,options:['A'+q,'B'+q,'C'+q,'D'+q],answer:q%4,explanation:''}));
const config:any={OPENAI_API_KEY:'sk-test-0000000000000000000000',OPENAI_MODEL:'gpt-5-mini'};
const reply=(body:unknown,status=200)=>(async()=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})) as unknown as typeof fetch;
const output=(text:string)=>({status:'completed',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text}]}]});

test('each paper is a complete permutation with shuffled options', () => {
 const paper=drawPaper(questions);
 assert.deepEqual([...paper.order].sort((a,b)=>a-b),questions.map((_,i)=>i));
 for(const options of paper.optionOrders)assert.deepEqual([...options].sort(),[0,1,2,3]);
 const shown=paperQuestions(questions,paper);
 shown.forEach((q,i)=>{assert.equal(q.prompt,questions[paper.order[i]].prompt);assert.deepEqual([...q.options].sort(),[...questions[paper.order[i]].options].sort());});
});

test('questions per student draws a distinct subset and different students get different papers', () => {
 const paper=drawPaper(questions,4);
 assert.equal(paper.order.length,4);assert.equal(new Set(paper.order).size,4);
 const papers=new Set(Array.from({length:20},()=>JSON.stringify(drawPaper(questions))));
 assert.ok(papers.size>15,'papers should differ between students');
});

test('grading maps the option the student saw back to the original answer', () => {
 const paper=drawPaper(questions,6);
 const correct=paper.order.map((q,i)=>paper.optionOrders[i].indexOf(questions[q].answer));
 assert.equal(gradePaper(questions,paper,correct),6);
 const wrong=correct.map((choice,i)=>(choice+1)%paper.optionOrders[i].length);
 assert.equal(gradePaper(questions,paper,wrong),0);
 assert.equal(gradePaper(questions,paper,correct.map((c,i)=>i<3?c:-1)),3);
});

test('attempts from before shuffling keep the original order and marking', () => {
 const paper=paperOf({answers:[]},questions);
 assert.deepEqual(paper.order,questions.map((_,i)=>i));
 assert.equal(gradePaper(questions,paper,questions.map(q=>q.answer)),10);
});

test('AI errors become clear staff messages', async () => {
 const request={instructions:'x',content:[{type:'input_text' as const,text:'y'}]};
 await assert.rejects(aiRespond({...config,OPENAI_API_KEY:undefined},request,reply({})),(e:any)=>e.code==='AI_NOT_CONFIGURED');
 await assert.rejects(aiRespond(config,request,reply({error:{message:'bad key'}},401)),(e:any)=>e.code==='AI_KEY_REJECTED');
 await assert.rejects(aiRespond(config,request,reply({error:{}},429)),(e:any)=>e.code==='AI_RATE_LIMIT');
 await assert.rejects(aiRespond(config,request,reply({error:{code:'rate_limit_exceeded',message:'Request too large for gpt-5-mini in organization org-abc123 on tokens per min (TPM): Limit 200000, Requested 412000.'}},429)),(e:any)=>e.code==='AI_TOO_LARGE'&&e.status===413&&!/org-abc123/.test(e.message)&&/Requested 412000/.test(e.message));
 await assert.rejects(aiRespond(config,request,reply({error:{code:'rate_limit_exceeded',message:'You exceeded your current quota, please check your plan.'}},429)),(e:any)=>e.code==='AI_NO_CREDIT');
 await assert.rejects(aiRespond(config,request,reply({error:{code:'insufficient_quota',message:'You exceeded your current quota'}},429)),(e:any)=>e.code==='AI_NO_CREDIT'&&e.status===402);
 await assert.rejects(aiRespond(config,request,reply({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]})),(e:any)=>e.code==='AI_INCOMPLETE');
 await assert.rejects(aiRespond(config,request,reply({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]})),(e:any)=>e.code==='AI_REFUSED');
 assert.equal(await aiRespond(config,request,reply(output('Summary: all good'))),'Summary: all good');
});

test('health checks flag real problems first and report a clean school as in order', () => {
 const base:any={people:{admissionsAwaitingDecision:0},money:{activeFees:2,activeFeesWithoutSchedule:0,bankDetailsPublished:true,transferReceiptsAwaitingReview:0},admissionsWork:{newVisitorConsultations:0,documentsAwaitingReview:0},catalogue:{countries:5,activeUniversities:3,activeCourses:4},communication:{failedDeliveries:0,draftNoticesOlderThan3Days:0},learning:{closedMocksWithUnreleasedResults:0,publishedMocks:1}};
 assert.deepEqual(healthChecks(base,true).map(c=>c.id),['ok']);
 const troubled={...base,money:{...base.money,bankDetailsPublished:false},catalogue:{countries:5,activeUniversities:0,activeCourses:0},communication:{failedDeliveries:3,draftNoticesOlderThan3Days:1}};
 const checks=healthChecks(troubled,false);
 assert.equal(checks[0].id,'delivery');assert.equal(checks[0].severity,'critical');
 for(const id of ['bank','universities','drafts','ai'])assert.ok(checks.some(c=>c.id===id),id);
 assert.ok(!checks.some(c=>c.id==='ok'));
});
