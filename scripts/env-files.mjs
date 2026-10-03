import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export async function readEnv(file) {
  try { return parseEnv(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export async function writeEnv(file, values) {
  await mkdir(path.dirname(file), { recursive: true });
  const content = '# Generated service profile. Secrets: do not commit.\n' +
    Object.entries(values).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join('\n') + '\n';
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
}
export function pick(values, keys) {
  return Object.fromEntries(keys.filter(k => values[k] !== undefined).map(k => [k, values[k]]));
}
