import {spawn,execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
const runTests=(uri)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','tsx','--test','test/configuration.test.ts','test/job-runner.test.ts','test/phase2.test.ts','test/trust-content.test.ts','test/integration.test.ts'],{stdio:'inherit',env:{...process.env,TEST_MONGODB_URI:uri},windowsHide:true});child.on('error',reject);child.on('exit',code=>resolve(code??1));
});
if(process.env.TEST_MONGODB_URI){process.exitCode=await runTests(process.env.TEST_MONGODB_URI);}
else{
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const name='pathway-mongo-test-'+crypto.randomBytes(6).toString('hex');let created=false;
  const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:180000});
  try{
    docker(['version','--format','{{.Server.Version}}']);
    console.log('Starting isolated MongoDB test replica set (localhost only).');
    docker(['run','-d','--name',name,'-p',`127.0.0.1:${port}:${port}`,'mongo:8.0','--replSet','rs0','--bind_ip_all','--port',String(port)]);created=true;
    let ready=false;
    for(let i=0;i<45;i++){try{docker(['exec',name,'mongosh','--quiet','--port',String(port),'--eval','db.adminCommand({ping:1}).ok']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}
    if(!ready)throw new Error('Test MongoDB did not start.');
    docker(['exec',name,'mongosh','--quiet','--port',String(port),'--eval',`rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:${port}'}]})`]);
    process.exitCode=await runTests(`mongodb://127.0.0.1:${port}/?replicaSet=rs0&directConnection=true`);
  }catch(error){console.error('MongoDB tests could not run. Start Docker Desktop, or set TEST_MONGODB_URI to a development replica set.');console.error(error instanceof Error?error.message:'Test startup failed');process.exitCode=1;}
  finally{if(created)docker(['rm','-f',name]);}
}
