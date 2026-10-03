import { randomUUID } from "node:crypto";

export type QueueJob = {
  id: string; kind: "probe" | "data_request"; payload: unknown;
  status: "queued" | "running" | "completed" | "failed";
  attempts: number; maxAttempts: number; createdAt: number;
  result?: unknown; error?: string;
};
export type ClaimedJob = { job: QueueJob; leaseToken: string };
export type RedisCommand = (command: (string | number)[]) => Promise<unknown>;

export function createRedisCommand(env: NodeJS.ProcessEnv = process.env): RedisCommand {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || new URL(url).protocol !== "https:") throw new Error("Redis HTTPS URL and token are required.");
  return async command => {
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command), signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!response.ok) throw new Error(`Redis request failed (HTTP ${response.status}).`);
    const body = await response.json() as { result?: unknown; error?: string };
    if (body.error) throw new Error("Redis command rejected."); // Do not log provider errors containing arguments.
    return body.result;
  };
}
export function queueNamespace(env: NodeJS.ProcessEnv = process.env) {
  if (!["sandbox","production"].includes(env.VERDANT_ENV ?? "")) throw new Error("VERDANT_ENV must be explicit.");
  if (!["test","live"].includes(env.PAYMENT_MODE ?? "")) throw new Error("PAYMENT_MODE must be explicit.");
  if (env.VERDANT_ENV === "sandbox" && env.PAYMENT_MODE === "live") throw new Error("Sandbox cannot use live payments.");
  const expected = `verdant:${env.VERDANT_ENV}:${env.PAYMENT_MODE}`;
  if (env.QUEUE_NAMESPACE !== expected) throw new Error("Queue namespace does not match the environment/payment mode.");
  return expected;
}
const time = `local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)\n`;
const enqueue = time + `
local current=redis.call('HGET',KEYS[1],ARGV[1])
if current then
 local j=cjson.decode(current)
 if j.fingerprint ~= ARGV[3] then return redis.error_reply('ID_CONFLICT') end
 return current
end
local job=cjson.decode(ARGV[2]); job.createdAt=now; job.fingerprint=ARGV[3]
local encoded=cjson.encode(job)
redis.call('HSET',KEYS[1],ARGV[1],encoded)
redis.call('ZADD',KEYS[2],now,ARGV[1])
return encoded`;
const claim = time + `
local expired=redis.call('ZRANGEBYSCORE',KEYS[3],'-inf',now,'LIMIT',0,25)
for _,id in ipairs(expired) do
 redis.call('ZREM',KEYS[3],id)
 redis.call('HDEL',KEYS[4],id)
 if redis.call('HEXISTS',KEYS[1],id)==1 then redis.call('ZADD',KEYS[2],now,id) end
end
for i=1,25 do
 local next=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now,'LIMIT',0,1)
 if #next==0 then return nil end
 local id=next[1]; redis.call('ZREM',KEYS[2],id)
 local raw=redis.call('HGET',KEYS[1],id)
 if raw then
  local job=cjson.decode(raw)
  if job.attempts >= job.maxAttempts then
   job.status='failed'; job.error='Retry budget exhausted'
   redis.call('HSET',KEYS[1],id,cjson.encode(job))
  else
   job.attempts=job.attempts+1; job.status='running'
   redis.call('HSET',KEYS[1],id,cjson.encode(job))
   redis.call('HSET',KEYS[4],id,ARGV[1])
   redis.call('ZADD',KEYS[3],now+tonumber(ARGV[2]),id)
   return cjson.encode(job)
  end
 end
end
return nil`;
const finish = time + `
if redis.call('HGET',KEYS[4],ARGV[1]) ~= ARGV[2] then return 0 end
local expiry=redis.call('ZSCORE',KEYS[3],ARGV[1])
if not expiry or tonumber(expiry)<=now then return 0 end
local job=cjson.decode(redis.call('HGET',KEYS[1],ARGV[1]))
redis.call('ZREM',KEYS[3],ARGV[1]); redis.call('HDEL',KEYS[4],ARGV[1])
if ARGV[3]=='completed' then job.status='completed'; job.result=cjson.decode(ARGV[4])
else
 job.error=ARGV[4]
 if job.attempts < job.maxAttempts then
  job.status='queued'; redis.call('ZADD',KEYS[2],now+tonumber(ARGV[5]),ARGV[1])
 else job.status='failed' end
end
redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job))
return 1`;
const heartbeat = time + `
if redis.call('HGET',KEYS[4],ARGV[1]) ~= ARGV[2] then return 0 end
local expiry=redis.call('ZSCORE',KEYS[3],ARGV[1])
if not expiry or tonumber(expiry)<=now then return 0 end
redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3]),ARGV[1]); return 1`;

export class JobQueue {
  private keys: string[];
  constructor(private command: RedisCommand, namespace: string, private lane: "probe" | "data_request") {
    if (!/^verdant:(sandbox|production):(test|live)(:smoke-[a-z0-9-]+)?$/.test(namespace))
      throw new Error("Invalid queue namespace.");
    const base = `{${namespace}}:${lane}`;
    this.keys = ["jobs","ready","leases","tokens"].map(k => `${base}:${k}`);
  }
  private async eval(script: string, args: (string|number)[]) {
    return this.command(["EVAL",script,this.keys.length,...this.keys,...args]);
  }
  async enqueue(id: string, payload: unknown, fingerprint: string, kind: QueueJob["kind"], maxAttempts=3): Promise<QueueJob> {
    if (kind !== this.lane) throw new Error("Job kind must match queue lane.");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid job ID.");
    if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>10) throw new Error("Invalid retry budget.");
    const serialized=JSON.stringify({id,kind,payload,status:"queued",attempts:0,maxAttempts,createdAt:0});
    if (Buffer.byteLength(serialized)>32_768) throw new Error("Job is too large; queue references, not files.");
    return JSON.parse(await this.eval(enqueue,[id,serialized,fingerprint]) as string);
  }
  async claim(leaseMs=60_000): Promise<ClaimedJob|null> {
    if (!Number.isInteger(leaseMs) || leaseMs<50 || leaseMs>900_000) throw new Error("Invalid lease duration.");
    const leaseToken=randomUUID();
    const result=await this.eval(claim,[leaseToken,leaseMs]);
    return result ? {job:JSON.parse(result as string),leaseToken}:null;
  }
  async get(id:string):Promise<QueueJob|null> {
    const raw=await this.command(["HGET",this.keys[0]!,id]);
    return raw ? JSON.parse(raw as string):null;
  }
  async complete(job:ClaimedJob,result:unknown) {
    return (await this.eval(finish,[job.job.id,job.leaseToken,"completed",JSON.stringify(result),0])) === 1;
  }
  async fail(job:ClaimedJob,message:string,retryMs=5_000) {
    return (await this.eval(finish,[job.job.id,job.leaseToken,"failed",message.slice(0,300),retryMs])) === 1;
  }
  async renew(job:ClaimedJob,leaseMs=60_000) {
    return (await this.eval(heartbeat,[job.job.id,job.leaseToken,leaseMs])) === 1;
  }
}
