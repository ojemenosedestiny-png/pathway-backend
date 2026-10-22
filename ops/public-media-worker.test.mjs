import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from './public-media-worker.mjs';
const key='public/00000000-0000-4000-8000-000000000001/tour.mp4';
function fixture(){const calls=[];return{calls,MEDIA_BUCKET:{head:async key=>{calls.push(key);return{size:8,httpEtag:'"test"',httpMetadata:{contentType:'video/mp4'}};},get:async(_key,options)=>{const bytes=new TextEncoder().encode('abcdefgh');const r=options?.range;return{body:r?bytes.slice(r.offset,r.offset+r.length):bytes};}}};}
test('private, quarantine, arbitrary paths and write methods never reach R2',async()=>{
 const env=fixture();for(const path of ['private/document','quarantine/file','public/invalid/file',''])assert.equal((await worker.fetch(new Request('https://media.test/'+path),env)).status,404);
 assert.equal((await worker.fetch(new Request('https://media.test/'+key,{method:'PUT'}),env)).status,405);assert.equal(env.calls.length,0);
});
test('public media supports playback, HEAD, byte ranges and invalid ranges',async()=>{
 const env=fixture();const full=await worker.fetch(new Request('https://media.test/'+key),env);assert.equal(await full.text(),'abcdefgh');assert.equal(full.headers.get('x-content-type-options'),'nosniff');
 const part=await worker.fetch(new Request('https://media.test/'+key,{headers:{Range:'bytes=2-4'}}),env);assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 2-4/8');assert.equal(await part.text(),'cde');
 const suffix=await worker.fetch(new Request('https://media.test/'+key,{headers:{Range:'bytes=-2'}}),env);assert.equal(await suffix.text(),'gh');
 assert.equal((await worker.fetch(new Request('https://media.test/'+key,{headers:{Range:'bytes=9-10'}}),env)).status,416);
 const head=await worker.fetch(new Request('https://media.test/'+key,{method:'HEAD'}),env);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),'8');
});
