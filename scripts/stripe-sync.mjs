import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, readEnv, writeEnv } from './env-files.mjs';
// Read only the dedicated Verdant CLI profile. Never borrow another project's key.
const result=spawnSync('stripe',['config','--list'],{encoding:'utf8'});
if(result.status!==0)throw new Error('Unable to read Stripe CLI configuration.');
let section='',key;
for(const raw of result.stdout.split('\n')) {
 const line=raw.trim();
 if(line.startsWith('['))section=line.replace(/[\[\]'"\s]/g,'');
 if(section==='verdant' && line.startsWith('test_mode_api_key')) {
  const value=line.slice(line.indexOf('=')+1).trim();key=/^['"]/.test(value)?value.slice(1,-1):value;
 }
}
if(!key || !/^(sk|rk|rkcs)_test_/.test(key))throw new Error('Log into the dedicated sandbox with stripe login --project-name verdant.');
const response=await fetch('https://api.stripe.com/v2/network/business_profiles/me',{
 headers:{Authorization:`Bearer ${key}`,'Stripe-Version':'2026-07-29.preview'},signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error(`Stripe profile lookup returned HTTP ${response.status}. Claim the sandbox, refresh its CLI login, and create a Stripe sandbox business profile. No credential values were logged.`);
const profile=await response.json();
if(!profile.id?.startsWith('profile_test_'))throw new Error('Expected a sandbox business profile.');
for(const file of ['.env.local','.env.production']) {
 const env=await readEnv(path.join(root,file));
 if(env.PAYMENT_MODE!=='test')throw new Error('Refusing to overwrite a live profile.');
 env.STRIPE_SECRET_KEY=key;env.STRIPE_PROFILE_ID=profile.id;
 await writeEnv(path.join(root,file),env);
}
const sync=spawnSync(process.execPath,['scripts/configure-env.mjs'],{cwd:root,stdio:'inherit'});
process.exitCode=sync.status??1;
