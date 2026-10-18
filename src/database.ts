import {Prisma,PrismaClient} from '@prisma/client';
import {MongoClient} from 'mongodb';

export function databaseUrl(env:NodeJS.ProcessEnv=process.env){
  const url=env.MONGODB_URI?.trim()||env.DATABASE_URL?.trim()||'';
  if(!/^mongodb(?:\+srv)?:\/\//.test(url)||/YOUR_|<db_password>|CHANGE_ME/.test(url))throw new Error('Set MONGODB_URI to your complete MongoDB replica-set connection string. PostgreSQL URLs are no longer accepted by this backend.');
  const parsed=new URL(url);if(!parsed.pathname||parsed.pathname==='/')throw new Error('MongoDB connection string must name an application database, such as /pathway.');
  return url;
}
const models=new Map(Prisma.dmmf.datamodel.models.map(model=>[model.name,model]));
/** MongoDB distinguishes absent fields from null. Persist optional scalar defaults explicitly. */
function prepare(modelName:string,data:any,creating:boolean):any {
  if(!data||typeof data!=='object')return data;
  const model=models.get(modelName);if(!model)return data;
  const result={...data};
  for(const field of model.fields){
    if(creating&&!field.isRequired&&!field.isList&&field.kind!=='object'&&field.type!=='Json'&&result[field.name]===undefined&&!field.hasDefaultValue)result[field.name]=null;
    if(field.kind==='object'&&result[field.name]){const nested={...result[field.name]};
      if(nested.create)nested.create=Array.isArray(nested.create)?nested.create.map((row:any)=>prepare(field.type,row,true)):prepare(field.type,nested.create,true);
      if(nested.createMany)nested.createMany={...nested.createMany,data:nested.createMany.data.map((row:any)=>prepare(field.type,row,true))};
      result[field.name]=nested;
    }
  }
  if(modelName==='Announcement'){
    if(result.audience&&typeof result.audience==='object'&&!('set' in result.audience)){result.audienceType=result.audience.type;result.audienceValue=result.audience.value||null;}
    if(Array.isArray(result.attachments))result.attachmentIds=result.attachments.map((item:any)=>item.documentId).filter((id:unknown)=>typeof id==='string');
  }
  return result;
}
export function createDatabase(url=databaseUrl()):PrismaClient {
  return new PrismaClient({datasourceUrl:url}).$extends({query:{$allModels:{$allOperations:async({model,operation,args,query}:any)=>{
    if(['AuditLog','IdReservation'].includes(model)&&['update','updateMany','upsert','delete','deleteMany'].includes(operation))throw new Error(model+' is append-only.');
    if(operation==='create')args.data=prepare(model,args.data,true);
    if(operation==='createMany')args.data=(Array.isArray(args.data)?args.data:[args.data]).map((row:any)=>prepare(model,row,true));
    if(operation==='update'||operation==='updateMany')args.data=prepare(model,args.data,false);
    if(operation==='upsert'){args.create=prepare(model,args.create,true);args.update=prepare(model,args.update,false);}
    return query(args);
  }}}}) as unknown as PrismaClient;
}

/** Updating a shared guard inside the transaction prevents snapshot-isolation write skew. */
export async function lock(tx:Prisma.TransactionClient,key:string){
  await tx.databaseLock.upsert({where:{key},create:{key,version:1},update:{version:{increment:1}}});
}

/** Provision indexes directly so nullable unique values use partial indexes, not unique-null slots. */
export async function setupMongoDatabase(url=databaseUrl()){
  const client=new MongoClient(url,{serverSelectionTimeoutMS:15000});await client.connect();
  try{
    const db=client.db();const hello=await db.admin().command({hello:1});if(!hello.setName&&hello.msg!=='isdbgrid')throw new Error('MongoDB must be a replica set or sharded cluster; transactions are required.');
    const existing=new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
    for(const model of models.values()){
      const collectionName=model.dbName||model.name;
      if(!existing.has(collectionName))await db.createCollection(collectionName);
      const collection=db.collection(collectionName);
      const uniqueGroups=[...model.fields.filter(f=>f.isUnique).map(f=>[f.name]),...model.uniqueFields];
      for(const fields of uniqueGroups){const key=Object.fromEntries(fields.map(name=>[model.fields.find(f=>f.name===name)?.dbName||name,1]));
        const optional=fields.filter(name=>!model.fields.find(f=>f.name===name)!.isRequired);
        const partialFilterExpression=optional.length?Object.fromEntries(optional.map(name=>[name,{$type:'string'}])):undefined;
        await collection.createIndex(key,{name:fields.join('_')+'_unique',unique:true,...partialFilterExpression?{partialFilterExpression}:{}});
      }
    }
    const indexes:Record<string,Record<string,1|-1>[]>= {
      Session:[{userId:1,expiresAt:1}],Student:[{cohort:1}],Application:[{studentId:1,status:1}],Document:[{ownerId:1,status:1}],HostelBooking:[{roomId:1,status:1,arrival:1,departure:1},{status:1,holdExpiresAt:1}],ConsultationSlot:[{advisorId:1,active:1,startsAt:1,endsAt:1}],Announcement:[{status:1,publishAt:1,expireAt:1},{audienceType:1,audienceValue:1},{attachmentIds:1}],Notification:[{userId:1,createdAt:-1}],Payment:[{studentId:1,status:1}],AuditLog:[{actorId:1,at:-1},{entity:1,entityId:1}],Outbox:[{status:1,runAt:1,createdAt:1}],PasswordToken:[{userId:1,usedAt:1}],Thread:[{studentId:1}],Message:[{threadId:1,createdAt:1}],
    };
    for(const [name,list]of Object.entries(indexes))for(const key of list)await db.collection(name).createIndex(key);
    await db.collection('DatabaseLock').updateOne({_id:'schema:mongodb:v1'} as any,{$setOnInsert:{version:1}},{upsert:true});
    return {database:db.databaseName,collections:models.size};
  }finally{await client.close();}
}
export async function assertDatabaseReady(db:PrismaClient){
  const hello=await db.$runCommandRaw({hello:1});
  if(!hello.setName&&hello.msg!=='isdbgrid')throw new Error('A MongoDB replica set is required.');
  if(!await db.databaseLock.findUnique({where:{key:'schema:mongodb:v1'}}))throw new Error('MongoDB indexes are not provisioned. Run npm run db:setup before starting the API or seed.');
}
