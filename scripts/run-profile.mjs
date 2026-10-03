import { spawn } from 'node:child_process';
import path from 'node:path';
import { readEnv, root } from './env-files.mjs';

const [profile, service, ...command] = process.argv.slice(2);
if (!['sandbox','production'].includes(profile) || !['web','api','worker','voice'].includes(service) || !command.length)
  throw new Error('Usage: run-profile.mjs sandbox|production web|api|worker|voice <command> [args]');
const file = profile === 'sandbox' ? '.env.local' : '.env.production';
const values = await readEnv(path.join(root,'apps',service,file));
if (values.VERDANT_ENV !== profile) throw new Error(`Missing or mismatched ${service}/${file}; run env:sync.`);
// Explicit process variables win over Next's .env.local precedence during production runs.
const child = spawn(command[0], command.slice(1), { cwd: path.join(root,'apps',service),
  env: { ...process.env, ...values, VERDANT_PROFILE_LOADED: '1' }, stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Unable to start configured command.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
