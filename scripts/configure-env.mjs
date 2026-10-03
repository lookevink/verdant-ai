import { readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, readEnv, writeEnv, pick } from './env-files.mjs';

const keysFile = process.argv[2];
const keys = keysFile ? JSON.parse(await readFile(keysFile, 'utf8')) : [];
const published = keys.find(k => k.type === 'publishable')?.api_key;
const secret = keys.find(k => k.type === 'secret')?.api_key;
const legacyProd = await readEnv(path.join(root, '.env.prod'));
const existingProd = await readEnv(path.join(root, '.env.production'));
const production = { ...legacyProd, ...existingProd };
const sandbox = await readEnv(path.join(root, '.env.local'));
for (const [environment, file, current] of [
  ['sandbox', '.env.local', sandbox], ['production', '.env.production', production],
]) {
  const defaults = {
    VERDANT_ENV: environment,
    SUPABASE_PROJECT_REF: 'ulspzrnnwrfbgldphjpe',
    SUPABASE_URL: 'https://ulspzrnnwrfbgldphjpe.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: published ?? '', SUPABASE_SECRET_KEY: secret ?? '',
    PAYMENT_MODE: 'test', MPP_SECRET_KEY: randomBytes(32).toString('hex'),
    MPP_PRICE_USD: '0.50', STRIPE_SECRET_KEY: '', STRIPE_PROFILE_ID: '',
    VERDANT_WORKER_TOKEN: randomBytes(32).toString('hex'),
    API_ADMIN_TOKEN: randomBytes(32).toString('hex'),
    VERDANT_API_URL: environment === 'sandbox' ? 'http://127.0.0.1:3001' : '',
    API_ORIGIN: environment === 'sandbox' ? 'http://127.0.0.1:3001' : '',
    ANTHROPIC_API_KEY: '', ANTHROPIC_WORKSPACE_ID: '', PI_MODEL: 'anthropic/claude-opus-5-5',
    // Playground: optional shared access code, rate-limit salt, and the secret the API and voice relay share for tickets.
    PLAYGROUND_ACCESS_CODE: '', PLAYGROUND_SALT: randomBytes(32).toString('hex'), PLAYGROUND_VOICE_SECRET: randomBytes(32).toString('hex'),
    PLAYGROUND_VOICE_URL: environment === 'sandbox' ? 'ws://127.0.0.1:3004/live' : '',
  };
  const values = { ...defaults, ...current, VERDANT_ENV: environment };
  if (!values.PI_MODEL) values.PI_MODEL = defaults.PI_MODEL;
  // Re-running fills empty retrieved credentials, never replaces a configured key.
  if (!values.SUPABASE_SECRET_KEY && secret) values.SUPABASE_SECRET_KEY = secret;
  if (!values.SUPABASE_PUBLISHABLE_KEY && published) values.SUPABASE_PUBLISHABLE_KEY = published;
  values.QUEUE_NAMESPACE = `verdant:${environment}:${values.PAYMENT_MODE}`;
  await writeEnv(path.join(root, file), values);
  const common = ['VERDANT_ENV','PAYMENT_MODE','SUPABASE_PROJECT_REF','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY'];
  const queue = ['QUEUE_NAMESPACE'];
  const api = pick(values, [...common, ...queue, 'SUPABASE_SECRET_KEY','VERDANT_WORKER_TOKEN',
    'API_ADMIN_TOKEN','MPP_SECRET_KEY','MPP_PRICE_USD','STRIPE_SECRET_KEY','STRIPE_PROFILE_ID',
    'PLAYGROUND_ACCESS_CODE','PLAYGROUND_SALT','PLAYGROUND_VOICE_SECRET','PLAYGROUND_VOICE_URL']);
  const worker = pick(values, [...common, ...queue, 'SUPABASE_SECRET_KEY','VERDANT_WORKER_TOKEN',
    'VERDANT_API_URL','ANTHROPIC_API_KEY','ANTHROPIC_WORKSPACE_ID','PI_MODEL']);
  const web = { ...pick(values, ['VERDANT_ENV','API_ORIGIN']),
    NEXT_PUBLIC_SUPABASE_URL: values.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: values.SUPABASE_PUBLISHABLE_KEY };
  // The voice relay also needs Vertex credentials: VERTEX_CREDENTIALS_FILE or vertex-service-account.json at the root.
  const voice = pick(values, ['VERDANT_ENV','PLAYGROUND_VOICE_SECRET','VERTEX_PROJECT','VERTEX_LOCATION','VOICE_ALLOWED_ORIGINS']);
  for (const [app, env] of [['web',web],['api',api],['worker',worker],['voice',voice]]) {
    await writeEnv(path.join(root,'apps',app,file), env);
    console.log(`${app}/${file}: configured ${Object.values(env).filter(Boolean).length}/${Object.keys(env).length} variables`);
  }
}
if (keysFile) await unlink(keysFile);
