import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readEnv, root } from '../env-files.mjs';
import path from 'node:path';
const profile=process.argv[2]??'local';
if(!['local','sandbox','production'].includes(profile))throw new Error('Expected local, sandbox, or production.');
let env;
if(profile==='local') {
 const status=spawnSync('supabase',['status','-o','json'],{encoding:'utf8'});
 if(status.status!==0)throw new Error('Local Supabase is unavailable.');
 const local=JSON.parse(status.stdout);
 env={SUPABASE_URL:local.API_URL,SUPABASE_SECRET_KEY:local.SECRET_KEY??local.SERVICE_ROLE_KEY,VERDANT_ENV:'sandbox',PAYMENT_MODE:'test',QUEUE_NAMESPACE:'verdant:sandbox:test'};
} else env=await readEnv(path.join(root,'apps/api',profile==='sandbox'?'.env.local':'.env.production'));
const port=3102,origin=`http://127.0.0.1:${port}`;
// Detach the process group so the temporary Next server and its children close together.
const server=spawn('pnpm',['exec','next','dev','-p',String(port)],{cwd:path.join(root,'apps/api'),
 env:{...process.env,...env,NEXT_TELEMETRY_DISABLED:'1'},stdio:'ignore',detached:true});
try {
 let ready=false;
 for(let i=0;i<100;i++) {
  try {const r=await fetch(origin+'/api/health'); if(r.ok){ready=true;break;}} catch{}
  if(server.exitCode!==null)throw new Error('API process exited.');
  await delay(200);
 }
 if(!ready)throw new Error('API startup timed out.');
 const run=spawn(process.execPath,['--import','tsx','scripts/data/verify-api.ts',origin,`.work/import/${profile==='production'?'production':'sandbox'}.expected.json`],{cwd:root,stdio:'inherit'});
 const result=await new Promise(resolve=>run.on('exit',resolve));
 if(result!==0)throw new Error('HTTP data verification failed.');
 console.log(JSON.stringify({profile,status:'passed'}));
} finally {try {process.kill(-server.pid,'SIGTERM');}catch{}}
