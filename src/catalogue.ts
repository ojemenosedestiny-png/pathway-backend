import {Router} from 'express';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {moduleGuard} from './auth.js';
import {wrap,parse,idSchema,pageSchema,moneySchema,transaction,audit,fail} from './core.js';

export const catalogueKinds=['DESTINATION','EXAM','HOSTEL'] as const;
const text=(max=2000)=>z.string().trim().max(max);
const image=text(1000).refine(value=>!value||/^\/assets\/[\w./-]+$/.test(value)||/^https:\/\//.test(value),'Use an uploaded HTTPS image or a bundled asset.');
export const catalogueSchema=z.object({
 slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),kind:z.enum(catalogueKinds),name:text(150).min(1),summary:text().min(1),image:image.default(''),countryCode:z.string().regex(/^(?:[A-Z]{2})?$/).default(''),
 category:z.enum(['','Cambridge','Nigerian','Pre-degree']).default(''),level:text(150).default(''),whoFor:text().default(''),provision:text().default(''),route:text().default(''),intakes:text(500).default(''),disclaimer:text().default(''),
 amountMinor:moneySchema.nullable().default(null),currency:z.enum(['NGN','USD']).default('NGN'),deadline:z.coerce.date().nullable().default(null),session:text(100).default(''),subjects:z.array(text(100).min(1)).max(40).default([]),requiredDocuments:z.array(text(100).min(1)).max(15).default([]),
 gender:z.enum(['','FEMALE','MALE','MIXED']).default(''),roomType:text(150).default(''),availability:text(150).default('Confirm with the school'),demo:z.boolean().default(false),status:z.enum(['DRAFT','PUBLISHED']).default('DRAFT'),order:z.number().int().min(0).max(100000).default(0),
}).strict();
const permission=(kind:string)=>kind==='DESTINATION'?'countries':kind==='EXAM'?'exams':'slides';
const kindSchema=z.enum(catalogueKinds);
export function publicCatalogueRouter(db:PrismaClient){const r=Router();r.get('/catalogue',wrap(async(req,res)=>{const q=parse(z.object({kind:kindSchema.optional(),...pageSchema.shape}).strict(),req.query);res.json(await db.catalogueEntry.findMany({where:{status:'PUBLISHED',...(q.kind?{kind:q.kind}:{})},orderBy:[{order:'asc'},{id:'asc'}],take:q.take,skip:q.skip}));}));return r;}
export function adminCatalogueRouter(db:PrismaClient){const r=Router();
 r.get('/catalogue/:kind',wrap(async(req,res,next)=>{const kind=parse(kindSchema,req.params.kind);moduleGuard(permission(kind))(req,res,async error=>{if(error)return next(error);try{res.json(await db.catalogueEntry.findMany({where:{kind},orderBy:[{order:'asc'},{id:'asc'}],...parse(pageSchema,req.query)}));}catch(e){next(e);}});}));
 r.post('/catalogue/:kind',wrap(async(req,res,next)=>{const kind=parse(kindSchema,req.params.kind);moduleGuard(permission(kind),true)(req,res,async error=>{if(error)return next(error);try{const data=parse(catalogueSchema,{...req.body,kind});const result=await transaction(db,async tx=>{const item=await tx.catalogueEntry.create({data});await audit(tx,req.principal!.id,'CREATE','CatalogueEntry',item.id,req.ip||'',undefined,item);return item;});res.status(201).json(result);}catch(e){next(e);}});}));
 for(const method of ['patch','delete'] as const)r[method]('/catalogue/:kind/:id',wrap(async(req,res,next)=>{const kind=parse(kindSchema,req.params.kind),id=parse(idSchema,req.params.id);moduleGuard(permission(kind),true)(req,res,async error=>{if(error)return next(error);try{const result=await transaction(db,async tx=>{const before=await tx.catalogueEntry.findUnique({where:{id}});if(!before||before.kind!==kind)fail(404,'NOT_FOUND','Catalogue entry not found.');let after;if(method==='delete'){await tx.catalogueEntry.delete({where:{id}});after={id};}else{const data=parse(catalogueSchema.partial(),req.body);if(data.kind&&data.kind!==kind)fail(422,'KIND','An entry cannot change its catalogue section.');after=await tx.catalogueEntry.update({where:{id},data});}await audit(tx,req.principal!.id,method==='delete'?'DELETE':'UPDATE','CatalogueEntry',id,req.ip||'',before,after);return after;});res.json(result);}catch(e){next(e);}});}));
 return r;
}
export async function ensureCatalogueCollection(db:PrismaClient){try{await db.$runCommandRaw({create:'CatalogueEntry'});}catch(error:any){if(String(error?.meta?.code)!=='48'&&!/NamespaceExists|already exists/i.test(String(error?.meta?.message||error?.message)))throw error;}}
