// The whole playground on one machine: in-memory Postgres (scripts/local-db.ts), API, worker (playground lane only),
// voice relay and website. Nothing here touches hosted Supabase; data reads go to the public MCP server.
//   node --import tsx scripts/playground-dev.ts [--profile apps/worker/.env.production] [--web-port 3010] [--api-port 3011]
// The model credential comes from the profile (default: the worker production profile) or the environment. Voice starts
// when a Vertex service-account file is found (VERTEX_CREDENTIALS_FILE, ~/.config/verdant/ or the repo root).
// Session data is discarded on exit.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { readEnv, root } from "./env-files.mjs";
import { createLocalDatabase, serveRpc } from "./local-db";

const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const webPort = arg("--web-port", "3010"), apiPort = arg("--api-port", "3011"), voicePort = arg("--voice-port", "3004");
const profile = await readEnv(path.resolve(arg("--profile", path.join(root, "apps/worker/.env.production"))));
const credential = (key: string) => process.env[key] ?? profile[key];
if (!credential("ANTHROPIC_API_KEY")) throw new Error("No ANTHROPIC_API_KEY in the environment or the --profile file.");
const vertex = [process.env.VERTEX_CREDENTIALS_FILE, path.join(homedir(), ".config/verdant/vertex-service-account.json"),
  path.join(root, "vertex-service-account.json")].find(f => f && existsSync(f));

const db = await createLocalDatabase();
const rpc = await serveRpc(db, 58340);
const base = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
  VERDANT_ENV: "sandbox", PAYMENT_MODE: "test", QUEUE_NAMESPACE: "verdant:sandbox:test", VERDANT_PROFILE_LOADED: "1" };
const voiceSecret = randomBytes(32).toString("hex");
const children: ChildProcess[] = [];
function start(name: string, cwd: string, command: string, args: string[], env: Record<string, string | undefined>) {
  const child = spawn(command, args, { cwd: path.join(root, cwd), env: Object.fromEntries(Object.entries({ ...base, ...env }).filter(e => e[1] !== undefined)) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout!, child.stderr!]) createInterface({ input: stream }).on("line", line => console.log(`${name.padEnd(6)} │ ${line}`));
  child.on("exit", code => console.log(`${name.padEnd(6)} │ exited (${code})`));
  children.push(child);
}
const next = (app: string) => path.join(root, "apps", app, "node_modules/.bin/next");

start("api", "apps/api", next("api"), ["dev", "-p", apiPort], { SUPABASE_URL: rpc.url, SUPABASE_SECRET_KEY: rpc.secretKey,
  PLAYGROUND_VOICE_SECRET: vertex ? voiceSecret : undefined, PLAYGROUND_VOICE_URL: vertex ? `ws://127.0.0.1:${voicePort}/live` : undefined });
start("worker", "apps/worker", process.execPath, ["--import", "tsx", "src/index.ts", "--playground"], { SUPABASE_URL: rpc.url, SUPABASE_SECRET_KEY: rpc.secretKey,
  ANTHROPIC_API_KEY: credential("ANTHROPIC_API_KEY"), ANTHROPIC_WORKSPACE_ID: credential("ANTHROPIC_WORKSPACE_ID"), PI_MODEL: credential("PI_MODEL"),
  VERDANT_MCP_URL: process.env.VERDANT_MCP_URL ?? "https://api.verdant-ai.com/mcp", PLAYGROUND_IDLE_MS: process.env.PLAYGROUND_IDLE_MS });
if (vertex) start("voice", "apps/voice", process.execPath, ["--import", "tsx", "src/index.ts"], { PLAYGROUND_VOICE_SECRET: voiceSecret, VERTEX_CREDENTIALS_FILE: vertex,
  VOICE_PORT: voicePort, VOICE_ALLOWED_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}` });
else console.log("voice  │ disabled: no Vertex service-account file (set VERTEX_CREDENTIALS_FILE)");
start("web", "apps/web", next("web"), ["dev", "-p", webPort], { API_ORIGIN: `http://127.0.0.1:${apiPort}` });
console.log(`ready  │ http://localhost:${webPort}/playground  (database in memory; Ctrl-C stops everything)`);

const stop = () => { for (const child of children) child.kill("SIGTERM"); rpc.server.close(); void db.close().finally(() => process.exit(0)); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
