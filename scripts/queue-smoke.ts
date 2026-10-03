import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JobQueue, createRedisCommand, queueNamespace } from "@verdant/queue";

const profile=process.argv[2] ?? "sandbox";
assert.ok(["sandbox","production"].includes(profile));
const env=parseEnv(await readFile(profile==="sandbox"?".env.local":".env.production","utf8"));
assert.equal(env.PAYMENT_MODE,"test","Integration tests refuse live payment configuration.");
const command=createRedisCommand(env);
assert.equal(await command(["PING"]),"PONG");
const namespace=queueNamespace(env)+":smoke-"+randomUUID();
const queue=new JobQueue(command,namespace,"probe");
const other=new JobQueue(command,namespace,"data_request");
try {
  await queue.enqueue("one",{check:true},"same","probe");
  await queue.enqueue("one",{check:true},"same","probe");
  await assert.rejects(()=>queue.enqueue("one",{changed:true},"different","probe"));
  const claims=await Promise.all([queue.claim(),queue.claim()]);
  assert.equal(claims.filter(Boolean).length,1,"Concurrent claims must not duplicate a job.");
  assert.equal(await other.claim(),null,"Different lanes must remain isolated.");
  const owned=claims.find(Boolean)!;
  assert.equal(await queue.complete({...owned,leaseToken:"wrong"},{}),false);
  assert.equal(await queue.renew(owned),true);
  assert.equal(await queue.complete(owned,{ok:true}),true);
  assert.equal((await queue.get("one"))?.status,"completed");
  assert.equal(await queue.claim(),null);
  await queue.enqueue("crash",{},"crash","probe");
  const expired=(await queue.claim(100))!;
  await delay(250);
  assert.equal(await queue.complete(expired,{}),false,"Expired worker cannot publish.");
  const recovered=(await queue.claim())!;
  assert.equal(recovered.job.id,"crash");
  assert.equal(recovered.job.attempts,2);
  assert.equal(await queue.complete(expired,{}),false,"Stale worker cannot acknowledge a reclaimed job.");
  assert.equal(await queue.complete(recovered,{recovered:true}),true);
  await queue.enqueue("retry",{},"retry","probe",2);
  const first=(await queue.claim())!;
  assert.equal(await queue.fail(first,"synthetic failure",0),true);
  const last=(await queue.claim())!;
  assert.equal(await queue.fail(last,"synthetic final failure",0),true);
  assert.equal((await queue.get("retry"))?.status,"failed");
  assert.equal(await queue.claim(),null);
  const report={profile,paymentMode:env.PAYMENT_MODE,status:"passed",checks:[
    "credential ping","idempotent enqueue","conflicting payload rejected","concurrent claim",
    "lane isolation","lease renewal","stale worker rejection","crash recovery","bounded retries"],
    timestamp:new Date().toISOString()};
  await mkdir(".work/verification",{recursive:true});
  await writeFile(`.work/verification/queue-${profile}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  for(const lane of ["probe","data_request"]) {
    await command(["DEL",...["jobs","ready","leases","tokens"].map(k=>`{${namespace}}:${lane}:${k}`)]);
  }
}
