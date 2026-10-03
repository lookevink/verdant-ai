import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { dataRequestSchema } from "@verdant/contracts";
import { createRedisCommand, JobQueue, queueNamespace } from "@verdant/queue";

// Direct invocations default to sandbox. Production must explicitly select its profile.
try { if (!process.env.VERDANT_PROFILE_LOADED) process.loadEnvFile(".env.local"); } catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

async function checkServices() {
  const url=process.env.SUPABASE_URL, key=process.env.SUPABASE_SECRET_KEY;
  if(!url||!key) throw new Error("Supabase server credentials missing.");
  const command=createRedisCommand();
  if(await command(["PING"])!=="PONG") throw new Error("Redis health check failed.");
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {error}=await client.storage.listBuckets();
  if(error) throw new Error("Supabase credential check failed.");
  return {redis:true,supabaseCredentials:true,namespace:queueNamespace()};
}
function log(event:string,details:Record<string,unknown>={}) {
  console.log(JSON.stringify({event,...details,timestamp:new Date().toISOString()}));
}
if (process.argv.includes("--validate")) {
  const path = process.argv[process.argv.indexOf("--validate") + 1];
  if (!path) throw new Error("Supply a path after --validate.");
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  console.log(JSON.stringify(dataRequestSchema.parse(input), null, 2));
} else if(process.argv.includes("--check")) {
  try {
    log("services_checked",{...await checkServices(),
      missingPi:["ANTHROPIC_API_KEY","PI_MODEL"].filter(k=>!process.env[k]),
      capabilities:["probe"],acquisitionImplemented:false});
  } catch { log("services_check_failed"); process.exitCode=1; }
} else if(process.argv.includes("--run")||process.argv.includes("--once")) {
  const stop=new AbortController();
  process.on("SIGINT",()=>stop.abort()); process.on("SIGTERM",()=>stop.abort());
  const queue=new JobQueue(createRedisCommand(),queueNamespace(),"probe");
  log("worker_started",{namespace:queueNamespace(),capabilities:["probe"]});
  do {
    try {
      const claimed=await queue.claim();
      if(claimed) {
        log("job_claimed",{id:claimed.job.id,attempt:claimed.job.attempts});
        try {
          const result=await checkServices();
          if(!await queue.complete(claimed,result)) throw new Error("Lease lost.");
          log("job_completed",{id:claimed.job.id});
        } catch {
          await queue.fail(claimed,"Service check failed");
          log("job_retry_or_failure",{id:claimed.job.id});
          if(process.argv.includes("--once")) process.exitCode=1;
        }
      }
    } catch { log("queue_unavailable"); if(process.argv.includes("--once")) process.exitCode=1; }
    if(process.argv.includes("--once")||stop.signal.aborted) break;
    try { await delay(3000,undefined,{signal:stop.signal}); } catch { break; }
  } while(!stop.signal.aborted);
  log("worker_stopped");
} else {
  console.error("Use --check, --run, --once, or --validate <request.json>."); process.exitCode=1;
}
