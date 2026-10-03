// In-process Postgres for migrations, SQL tests and API/worker runs without Docker or a Supabase login.
// PGlite + pgmq's plain SQL + a PostgREST-compatible /rest/v1/rpc endpoint for service-role calls.
// It approximates Supabase (roles, storage.buckets, pgmq); hosted verification is still required.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(import.meta.dirname, "..");
const pgmqTag = "v1.5.1"; // Plain-SQL install is supported from 1.5.
const pgmqSha256 = "65b9302faa660539584769a572b57f2df76ccf1b3a2153c37cefc57b8db633e9";
const supabaseCompat = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema storage;
create table storage.buckets(id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
`;

async function pgmqSql() {
  const cached = path.join(root, ".work/vendor", `pgmq-${pgmqTag}.sql`);
  let sql = await readFile(cached, "utf8").catch(() => null);
  if (sql === null) {
    const response = await fetch(`https://raw.githubusercontent.com/pgmq/pgmq/${pgmqTag}/pgmq-extension/sql/pgmq.sql`);
    if (!response.ok) throw new Error(`pgmq source download failed (HTTP ${response.status}).`);
    sql = await response.text();
  }
  if (createHash("sha256").update(sql).digest("hex") !== pgmqSha256) throw new Error("pgmq source hash mismatch.");
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, sql);
  return sql;
}

export async function createLocalDatabase() {
  const db = await PGlite.create();
  await db.exec(supabaseCompat);
  const pgmq = await pgmqSql();
  const dir = path.join(root, "supabase/migrations");
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) {
    const sql = (await readFile(path.join(dir, file), "utf8")).replace(/create extension if not exists pgmq;/i, () => pgmq);
    try { await db.exec(sql); } catch (error) { throw new Error(`Migration ${file} failed: ${(error as Error).message}`); }
  }
  return db;
}

export async function runSqlTests(db: PGlite) {
  const dir = path.join(root, "supabase/tests");
  const results: string[] = [];
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) {
    // psql meta-commands are not SQL; each suite manages its own transaction.
    const sql = (await readFile(path.join(dir, file), "utf8")).split("\n").filter(l => !l.startsWith("\\")).join("\n");
    try {
      const output = await db.exec(sql);
      const last = output.at(-1)?.rows[0] as { result?: string } | undefined;
      results.push(`${file}: ${last?.result ?? "ok"}`);
    } catch (error) {
      await db.exec("rollback").catch(() => {});
      throw new Error(`${file} failed: ${(error as Error).message}`);
    }
  }
  return results;
}

/** Serves POST /rest/v1/rpc/verdant_* like PostgREST, as service_role, one call at a time. */
export async function serveRpc(db: PGlite, port: number) {
  const secretKey = "sb_secret_local_" + randomBytes(16).toString("hex");
  const signatures = new Map<string, { names: string[]; types: string[] }>();
  const rows = await db.query<{ name: string; names: string[]; types: string[] }>(`
    select p.proname name, p.proargnames names, array(select format_type(t,null) from unnest(p.proargtypes) t) types
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'verdant\\_%'`);
  for (const row of rows.rows) signatures.set(row.name, { names: row.names, types: row.types });
  let chain: Promise<unknown> = Promise.resolve();
  const call = (name: string, args: Record<string, unknown>) => {
    const signature = signatures.get(name);
    if (!signature) return Promise.reject(Object.assign(new Error("not found"), { code: "PGRST202", status: 404 }));
    const values: unknown[] = [];
    const params = Object.entries(args).map(([key, value]) => {
      const index = signature.names.indexOf(key);
      if (index < 0) throw Object.assign(new Error("unknown argument"), { code: "PGRST202", status: 404 });
      const type = signature.types[index]!;
      values.push(value === null || value === undefined ? null : type === "jsonb" ? JSON.stringify(value) : typeof value === "object" ? JSON.stringify(value) : value);
      return `${key} => $${values.length}::${type}`;
    });
    const run = () => db.transaction(async tx => {
      await tx.exec("set local role service_role");
      return (await tx.query<{ result: unknown }>(`select to_jsonb(public.${name}(${params.join(",")})) as result`, values)).rows[0]?.result ?? null;
    });
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
  const server: Server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    const match = /^\/rest\/v1\/rpc\/(verdant_[a-z_]+)$/.exec(request.url ?? "");
    if (request.method !== "POST" || !match) return send(404, { code: "PGRST202" });
    if (request.headers.apikey !== secretKey) return send(401, { code: "PGRST301" });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try {
      send(200, await call(match[1]!, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
    } catch (error) {
      const e = error as { code?: string; status?: number };
      send(e.status ?? 400, { code: e.code ?? "P0001" });
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${port}`, secretKey, server, call };
}

if (import.meta.main) {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 58331;
  const db = await createLocalDatabase();
  console.log(JSON.stringify({ migrations: "applied" }));
  if (process.argv.includes("--test")) {
    for (const line of await runSqlTests(db)) console.log(line);
    if (!process.argv.includes("--serve")) process.exit(0);
  }
  const { url, secretKey } = await serveRpc(db, port);
  if (process.argv.includes("--env-file")) {
    const file = process.argv[process.argv.indexOf("--env-file") + 1]!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `SUPABASE_URL=${url}\nSUPABASE_SECRET_KEY=${secretKey}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: "serving", url, note: "In-memory; data is discarded on exit." }));
}
