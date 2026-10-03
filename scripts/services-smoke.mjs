import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { readEnv, root } from './env-files.mjs';
const profile=process.argv[2]??'sandbox';
assert.ok(['sandbox','production'].includes(profile));
const env=await readEnv(path.join(root,'apps/api',profile==='sandbox'?'.env.local':'.env.production'));
assert.equal(env.PAYMENT_MODE,'test');
const port=3101,origin=`http://127.0.0.1:${port}`;
const server=spawn('pnpm',['exec','next','start','-p',String(port)],{
 cwd:path.join(root,'apps/api'),env:{...process.env,...env},stdio:'ignore'});
try {
 let ready=false;
 for(let n=0;n<50;n++) {
  try {const res=await fetch(origin+'/api/health');const health=await res.json();
   if(res.ok&&health.environment===profile){ready=true;break;}}
  catch{}
  if(server.exitCode!==null)throw new Error('API process failed to start.');
  await delay(200);
 }
 assert.ok(ready,'API startup timed out or port is occupied by another profile.');
 assert.equal((await fetch(origin+'/api/internal/queue/probe',{method:'POST'})).status,401);
 const auth={Authorization:`Bearer ${env.API_ADMIN_TOKEN}`};
 const response=await fetch(origin+'/api/internal/queue/probe',{method:'POST',headers:auth});
 assert.equal(response.status,202);const {id}=await response.json();
 const worker=spawn(process.execPath,['scripts/run-profile.mjs',profile,'worker','pnpm','exec','tsx','src/index.ts','--once'],
 {cwd:root,stdio:'inherit'});
 assert.equal(await new Promise(resolve=>worker.on('exit',resolve)),0);
 const result=await fetch(origin+'/api/internal/queue/probe?id='+id,{headers:auth});
 const body=await result.json();
 assert.equal(body.status,'completed');
 assert.equal((await fetch(origin+'/api/v1/data/requests',{method:'POST'})).status,503);
 console.log(JSON.stringify({profile,status:'passed',checks:['API authorization','API enqueue','worker pull','Supabase credential check','job completion','acquisition fails closed']}));
} finally {server.kill('SIGTERM');}
