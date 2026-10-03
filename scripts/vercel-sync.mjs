import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readEnv, writeEnv, root } from './env-files.mjs';

const scope='lookevinks-projects';
function api(endpoint, method='GET', body) {
  const args=['api',endpoint,'--scope',scope,'--raw','--method',method];
  if(body) args.push('--input','-');
  const result=spawnSync('vercel',args,{input:body?JSON.stringify(body):undefined,encoding:'utf8'});
  if(result.status!==0) {
    let diagnostic=result.stderr;
    for(const item of (Array.isArray(body)?body:[])) if(item.value) diagnostic=diagnostic.split(item.value).join('[REDACTED]');
    diagnostic=diagnostic.replace(/\b[a-z]+_(?:test|live)_[A-Za-z0-9]+/g,'[REDACTED]');
    throw new Error(`Vercel ${method} ${endpoint} failed: ${diagnostic}`);
  }
  return JSON.parse(result.stdout);
}
const projects=api('/v9/projects?limit=100').projects;
for(const app of ['api','web']) {
  const name=`verdant-ai-${app}`;
  let project=projects.find(p=>p.name===name);
  if(!project) project=api('/v11/projects','POST',{name,framework:'nextjs',rootDirectory:`apps/${app}`,
    installCommand:'pnpm install --frozen-lockfile',buildCommand:'pnpm build'});
  project=api(`/v9/projects/${project.id}`);
  const settings={rootDirectory:`apps/${app}`,sourceFilesOutsideRootDirectory:true,nodeVersion:'24.x',framework:'nextjs'};
  if(Object.entries(settings).some(([key,value])=>project[key]!==value)) {
    project=api(`/v9/projects/${project.id}`,'PATCH',settings);
  }
  await mkdir(path.join(root,'apps',app,'.vercel'),{recursive:true});
  await writeFile(path.join(root,'apps',app,'.vercel','project.json'),JSON.stringify({
    orgId:project.accountId,projectId:project.id,projectName:name},null,2)+'\n');
  console.log(`${name}: linked in ${scope}, root apps/${app}`);
  if(app==='api') {
    const domains=api(`/v9/projects/${project.id}/domains`).domains;
    const domain=domains.find(d=>d.name.endsWith('.vercel.app'));
    if(!domain) throw new Error('No verified project domain available.');
    const prod=await readEnv(path.join(root,'.env.production'));
    prod.API_ORIGIN=`https://${domain.name}`;prod.VERDANT_API_URL=prod.API_ORIGIN;
    await writeEnv(path.join(root,'.env.production'),prod);
    const sync=spawnSync(process.execPath,['scripts/configure-env.mjs'],{cwd:root,encoding:'utf8'});
    if(sync.status!==0) throw new Error('Local env sync failed.');
    console.log(`Production API origin: ${prod.API_ORIGIN}`);
  }
  for(const [file,targets] of [['.env.local',['development','preview']],['.env.production',['production']]]) {
    const values=await readEnv(path.join(root,'apps',app,file));
    for(const target of targets) {
      const vars=Object.entries(values).filter(([key,value])=>value && !(app==='web'&&key==='API_ORIGIN'&&target==='preview'))
        .map(([key,value])=>({key,value,target:[target],type:target==='development'?'encrypted':
          /SECRET|TOKEN/.test(key)?'sensitive':'encrypted'}));
      for(const variable of vars) {
        const args=['env','add',variable.key,target,'--scope',scope,'--cwd',path.join(root,'apps',app),'--yes','--force'];
        if(variable.type==='sensitive')args.push('--sensitive');
        const result=spawnSync('vercel',args,{input:variable.value,encoding:'utf8'});
        if(result.status!==0)throw new Error(`Environment upload failed for ${name}/${target}/${variable.key}: ${result.stderr.split(variable.value).join('[REDACTED]')}`);
      }
      console.log(`${name}/${target}: synced ${vars.length} variables`);
    }
  }
}
console.log('Preview web builds must receive API_ORIGIN pointing to their matching sandbox API deployment. No deployment was created.');
