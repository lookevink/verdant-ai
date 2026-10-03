import test from "node:test";
import assert from "node:assert/strict";
import { queueNamespace, JobQueue } from "./index.js";
test("rejects environment/payment namespace mismatches",()=>{
  assert.throws(()=>queueNamespace({VERDANT_ENV:"sandbox",PAYMENT_MODE:"live",QUEUE_NAMESPACE:"verdant:sandbox:live"}));
  assert.throws(()=>queueNamespace({VERDANT_ENV:"sandbox",PAYMENT_MODE:"test",QUEUE_NAMESPACE:"verdant:production:test"}));
  assert.equal(queueNamespace({VERDANT_ENV:"sandbox",PAYMENT_MODE:"test",QUEUE_NAMESPACE:"verdant:sandbox:test"}),"verdant:sandbox:test");
});
test("rejects files and unsafe IDs before sending Redis commands",async()=>{
  const queue=new JobQueue(async()=>{throw new Error("Must not call Redis");},"verdant:sandbox:test","probe");
  await assert.rejects(()=>queue.enqueue("../x",{},"digest","probe"),/Invalid job ID/);
  await assert.rejects(()=>queue.enqueue("x","x".repeat(40000),"digest","probe"),/too large/);
});
