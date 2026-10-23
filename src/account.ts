import {Router} from 'express';
import type {PrismaClient} from '@prisma/client';
import argon2 from 'argon2';
import {z} from 'zod';
import {wrap,parse,fail,audit,transaction,rate} from './core.js';
import {passwordSchema} from './auth.js';

/** Signed-in staff manage their own name, phone and password. Email and role stay with the owner's Staff accounts page. */
const profileSchema=z.object({name:z.string().trim().min(2).max(120),phone:z.string().trim().min(7).max(30)}).strict();
const passwordChange=z.object({currentPassword:z.string().min(1).max(128),newPassword:passwordSchema}).strict();

export function accountRouter(db:PrismaClient){
 const r=Router();
 const load=async(id:string)=>{const user=await db.user.findUnique({where:{id},include:{admin:true}});if(!user?.admin)fail(404,'NOT_FOUND','Staff account not found.');return user;};
 r.get('/',wrap(async(req,res)=>{
  const user=await load(req.principal!.id);
  const sessions=await db.session.count({where:{userId:user.id,expiresAt:{gt:new Date()}}});
  res.json({name:user.admin!.name,email:user.email,phone:user.phone,role:user.admin!.roleType,createdAt:user.createdAt,twoFactorEnabled:Boolean(user.twoFactorSecret),recoveryCodesRemaining:user.backupCodes.length,activeSessions:sessions});
 }));
 r.patch('/',wrap(async(req,res)=>{
  const data=parse(profileSchema,req.body);const before=await load(req.principal!.id);
  await transaction(db,async tx=>{
   await tx.admin.update({where:{userId:before.id},data:{name:data.name}});
   await tx.user.update({where:{id:before.id},data:{phone:data.phone}});
   await audit(tx,before.id,'ACCOUNT_UPDATED','User',before.id,req.ip||'',{name:before.admin!.name,phone:before.phone},data);
  });
  res.json({name:data.name,phone:data.phone});
 }));
 r.post('/password',wrap(async(req,res)=>{
  const data=parse(passwordChange,req.body);const id=req.principal!.id;
  await rate(db,'password-change:'+id,5,900);
  const user=await load(id);
  if(!user.passwordHash||!(await argon2.verify(user.passwordHash,data.currentPassword)))fail(400,'CURRENT_PASSWORD','Your current password is not correct.');
  if(data.currentPassword===data.newPassword)fail(400,'SAME_PASSWORD','Choose a password you have not just used.');
  const passwordHash=await argon2.hash(data.newPassword,{type:argon2.argon2id});
  const signedOut=await transaction(db,async tx=>{
   const updated=await tx.user.update({where:{id},data:{passwordHash,sessionVersion:{increment:1}}});
   // Keep this device signed in on the new version; every other session ends.
   await tx.session.update({where:{id:req.principal!.sessionId},data:{version:updated.sessionVersion}});
   const removed=await tx.session.deleteMany({where:{userId:id,id:{not:req.principal!.sessionId}}});
   await audit(tx,id,'PASSWORD_CHANGED','User',id,req.ip||'',undefined,{otherSessionsEnded:removed.count});
   return removed.count;
  });
  res.json({changed:true,otherSessionsEnded:signedOut});
 }));
 return r;
}
