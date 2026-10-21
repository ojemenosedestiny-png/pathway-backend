import sharp from 'sharp';
import {PDFDocument,PDFName} from 'pdf-lib';
import {fileTypeFromBuffer} from 'file-type';
import {S3Client,GetObjectCommand,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {PrismaClient} from '@prisma/client';
sharp.cache({memory:16,files:0,items:20});sharp.concurrency(1);
export const imageTypes=['image/jpeg','image/png','image/webp'];
export async function normaliseImage(bytes:Uint8Array,mime:string){
 if(!imageTypes.includes(mime)||!bytes.length||bytes.length>10*1024*1024)throw Error('Choose a JPG, PNG or WebP image up to 10 MB.');
 if((await fileTypeFromBuffer(bytes))?.mime!==mime)throw Error('Image content does not match its declared type.');
 const pipeline=sharp(bytes,{failOn:'warning',limitInputPixels:25000000,sequentialRead:true});
 const metadata=await pipeline.metadata();if(!metadata.width||!metadata.height||(metadata.pages||1)>1)throw Error('Choose a single-frame photograph.');
 const output=await pipeline.rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:88}).timeout({seconds:20}).toBuffer();
 if(output.length>10*1024*1024)throw Error('Processed image is too large.');return output;
}
export async function normalisePdf(bytes:Uint8Array){
 if(!bytes.length||bytes.length>10*1024*1024||(await fileTypeFromBuffer(bytes))?.mime!=='application/pdf')throw Error('Choose a PDF up to 10 MB.');
 const source=await PDFDocument.load(bytes,{ignoreEncryption:false,throwOnInvalidObject:true,updateMetadata:false});
 if(source.getPageCount()<1||source.getPageCount()>200)throw Error('PDF must contain 1 to 200 pages.');
 const output=await PDFDocument.create();const pages=await output.copyPages(source,source.getPageIndices());
 for(const page of pages){for(const key of ['Annots','AA','A','Metadata','AF','PresSteps'])page.node.delete(PDFName.of(key));output.addPage(page);}
 const result=Buffer.from(await output.save());if(result.length>10*1024*1024)throw Error('Rebuilt PDF is too large.');return result;
}
export async function processImageUpload(db:PrismaClient,client:S3Client,bucket:string,f:any){
 if(f.status!=='SCANNING')return;
 let output:Buffer;
 try{
 if(![...imageTypes,'application/pdf'].includes(f.mime)||(f.public&&f.mime==='application/pdf'))throw Error('Unsupported file format.');
 const object=await client.send(new GetObjectCommand({Bucket:bucket,Key:f.fileKey}));
 if(object.ContentLength!==f.size){(object.Body as any)?.destroy?.();throw Error('Uploaded object size changed.');}
 const chunks:Buffer[]=[];let length=0;for await(const chunk of object.Body as any){length+=chunk.length;if(length>f.size||length>10*1024*1024){(object.Body as any)?.destroy?.();throw Error('Image exceeds upload limit.');}chunks.push(Buffer.from(chunk));}
 if(length!==f.size)throw Error('Incomplete image.');output=f.mime==='application/pdf'?await normalisePdf(Buffer.concat(chunks)):await normaliseImage(Buffer.concat(chunks),f.mime);
 }catch(error){await db.document.updateMany({where:{id:f.id,status:'SCANNING'},data:{status:'QUARANTINED',rejectionReason:'File validation failed. Choose a valid JPG, PNG, WebP or unencrypted PDF up to 10 MB. PDFs may contain up to 200 pages.'}});return;}
 const pdf=f.mime==='application/pdf';const mime=pdf?'application/pdf':'image/webp';const extension=pdf?'.pdf':'.webp';
 const destination=(f.public?'public/':'private/')+f.id+'/file'+extension;
 await client.send(new PutObjectCommand({Bucket:bucket,Key:destination,Body:output,ContentType:mime,ContentLength:output.length}));
 await db.document.updateMany({where:{id:f.id,status:'SCANNING'},data:{fileKey:destination,mime,filename:f.filename.replace(/\.[^.]+$/,'')+extension,size:output.length,status:f.public?'APPROVED':'PENDING'}});
 await client.send(new DeleteObjectCommand({Bucket:bucket,Key:f.fileKey}));
}
