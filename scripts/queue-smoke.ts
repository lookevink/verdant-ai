import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JobQueue, createDatabaseRpc, queueNamespace } from "@verdant/queue";

const profile=process.argv[2] ?? "sandbox";
assert.ok(["sandbox","production","local"].includes(profile));
const env=profile==="local" ? process.env : parseEnv(await readFile(profile==="sandbox"?".env.local":".env.production","utf8"));
assert.equal(env.PAYMENT_MODE,"test","Integration tests refuse live payment configuration.");
const rpc=createDatabaseRpc(env);
const namespace=queueNamespace(env)+":smoke";
const queue=new JobQueue(rpc,namespace,"probe");
const other=new JobQueue(rpc,namespace,"data_request");
const prefix=randomUUID();
const id=(name:string)=>prefix+"-"+name;
await queue.health();
try {
  await queue.enqueue(id("one"),{check:true},"same","probe");
  await queue.enqueue(id("one"),{check:true},"same","probe");
  await assert.rejects(()=>queue.enqueue(id("one"),{changed:true},"different","probe"));
  const claims=await Promise.all([queue.claim(),queue.claim()]);
  assert.equal(claims.filter(Boolean).length,1,"Concurrent claims must not duplicate a job.");
  assert.equal(await other.claim(),null,"Different lanes must remain isolated.");
  const owned=claims.find(Boolean)!;
  assert.equal(await queue.complete({...owned,leaseToken:randomUUID()},{}),false);
  assert.equal(await queue.renew(owned),true);
  assert.equal(await queue.complete(owned,{ok:true}),true);
  assert.equal((await queue.get(id("one")))?.status,"completed");
  assert.equal(await queue.claim(),null);
  await queue.enqueue(id("crash"),{},id("crash"),"probe");
  const expired=(await queue.claim(1000))!;
  await delay(1200);
  assert.equal(await queue.complete(expired,{}),false,"Expired worker cannot publish.");
  const recovered=(await queue.claim())!;
  assert.equal(recovered.job.id,id("crash"));
  assert.equal(recovered.job.attempts,2);
  assert.equal(await queue.complete(expired,{}),false,"Stale worker cannot acknowledge a reclaimed job.");
  assert.equal(await queue.complete(recovered,{recovered:true}),true);
  await queue.enqueue(id("retry"),{},id("retry"),"probe",2);
  const first=(await queue.claim())!;
  assert.equal(await queue.fail(first,"synthetic failure",0),true);
  const last=(await queue.claim())!;
  assert.equal(await queue.fail(last,"synthetic final failure",0),true);
  assert.equal((await queue.get(id("retry")))?.status,"failed");
  assert.equal(await queue.claim(),null);
  const report={profile,paymentMode:env.PAYMENT_MODE,status:"passed",checks:[
    "pgmq health","idempotent enqueue","conflicting payload rejected","concurrent claim",
    "lane isolation","lease renewal","stale worker rejection","crash recovery","bounded retries"],
    timestamp:new Date().toISOString()};
  await mkdir(".work/verification",{recursive:true});
  await writeFile(`.work/verification/queue-${profile}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  // Records and pgmq archives remain as verification evidence, in dedicated smoke queues.
}
