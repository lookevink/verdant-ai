import { spawnSync } from 'node:child_process';
const status = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' });
if (status.status !== 0) throw new Error('Local Supabase is not running.');
const env = JSON.parse(status.stdout);
const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/queue-smoke.ts', 'local'], {
  stdio: 'inherit', env: { ...process.env, SUPABASE_URL: env.API_URL, SUPABASE_SECRET_KEY: env.SECRET_KEY ?? env.SERVICE_ROLE_KEY,
    VERDANT_ENV: 'sandbox', PAYMENT_MODE: 'test', QUEUE_NAMESPACE: 'verdant:sandbox:test' },
});
process.exitCode = run.status ?? 1;
