import type {Config} from './core.js';
import {fail} from './core.js';

/** Minimal OpenAI Responses API client. Requests are not stored by OpenAI (store:false). */
type Content = {type:'input_text';text:string}|{type:'input_file';filename:string;file_data:string};
export interface AiRequest {instructions:string;content:Content[];schema?:{name:string;schema:Record<string,unknown>};maxOutputTokens?:number;timeoutMs?:number}
export type AiFetch = typeof fetch;

export function aiConfigured(config:Config){return Boolean(config.OPENAI_API_KEY);}

const reasoningModel=(model:string)=>/^(gpt-5|o\d)/i.test(model);

export async function aiRespond(config:Config,request:AiRequest,send:AiFetch=fetch):Promise<string>{
 if(!config.OPENAI_API_KEY)fail(503,'AI_NOT_CONFIGURED','The AI assistant is not connected. Add OPENAI_API_KEY to the backend service settings.');
 const body:Record<string,unknown>={model:config.OPENAI_MODEL,instructions:request.instructions,input:[{role:'user',content:request.content}],max_output_tokens:request.maxOutputTokens??4000,store:false};
 if(reasoningModel(config.OPENAI_MODEL))body.reasoning={effort:'low'};
 if(request.schema)body.text={format:{type:'json_schema',name:request.schema.name,schema:request.schema.schema,strict:true}};
 let response:Response;
 try{response=await send('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+config.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(request.timeoutMs??90000)});}
 catch(error){fail(504,'AI_UNAVAILABLE',(error as Error)?.name==='TimeoutError'?'The AI service took too long to respond. Try again.':'The AI service could not be reached. Try again shortly.');}
 const data:any=await response.json().catch(()=>null);
 if(!response.ok){
  if(response.status===401)fail(502,'AI_KEY_REJECTED','OpenAI rejected the API key. Check OPENAI_API_KEY on the backend service.');
  // OpenAI uses 429 for both: insufficient_quota means no credit (retrying cannot help); otherwise it is a temporary rate limit.
  const code=String(data?.error?.code||data?.error?.type||'');
  if(response.status===429&&/insufficient_quota|billing/i.test(code))fail(402,'AI_NO_CREDIT','The OpenAI account has no remaining credit or has reached its spending limit. The owner adds credit at platform.openai.com under Billing; until then, enter questions manually.');
  if(response.status===429)fail(429,'AI_RATE_LIMIT','The AI service is busy right now. Wait a minute, then try again. Your questions and edits are kept.');
  if(response.status===400&&/file|pdf|invalid_image|unsupported/i.test(String(data?.error?.message||'')))fail(422,'AI_INVALID_FILE','The AI service could not read this PDF. Check it opens normally and is not password-protected, or enter the questions manually.');
  fail(502,'AI_FAILED','The AI service could not complete this request'+(data?.error?.message?': '+String(data.error.message).slice(0,200):'.'));
 }
 const parts=(data?.output||[]).filter((item:any)=>item.type==='message').flatMap((item:any)=>item.content||[]);
 const refusal=parts.find((part:any)=>part.type==='refusal');
 if(refusal)fail(422,'AI_REFUSED','The AI service declined this request.');
 const text=parts.filter((part:any)=>part.type==='output_text').map((part:any)=>part.text).join('');
 if(data?.status==='incomplete')fail(502,'AI_INCOMPLETE',data?.incomplete_details?.reason==='max_output_tokens'?'The document is too long to process in one go. Split it into smaller papers.':'The AI response was incomplete. Try again.');
 if(!text.trim())fail(502,'AI_EMPTY','The AI service returned no answer. Try again.');
 return text;
}
