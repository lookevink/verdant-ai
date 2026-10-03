import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dataRequestSchema } from "@verdant/contracts";
import { planAcquisition } from "@verdant/contracts/acquisition";
import { createDatabaseRpc, JobQueue, queueNamespace } from "@verdant/queue";
import { modelSpec } from "./acquisition/model";
import { Workspace } from "./acquisition/operations";
import { buildPublication } from "./acquisition/publication";
import { acquisitionLeaseMs, processAcquisition, runAgent } from "./acquisition/supervisor";
import { runPlayground } from "./playground/host";

// Direct invocations default to sandbox. Production must explicitly select its profile.
try { if (!process.env.VERDANT_PROFILE_LOADED) process.loadEnvFile(".env.local"); } catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const dataDir = path.resolve(process.env.WORKER_DATA_DIR ?? path.join(import.meta.dirname, "../../../.work/worker"));
/** Acquisition needs a model credential; without it the worker still serves diagnostics. */
const piConfigured = () => modelSpec().provider !== "anthropic" || Boolean(process.env.ANTHROPIC_API_KEY);
const capabilities = () => piConfigured() ? ["probe", "acquisition", "playground"] : ["probe"];
/** Playground sessions read data through the public MCP server, never the database. */
const mcpUrl = () => process.env.VERDANT_MCP_URL || new URL("/mcp", process.env.VERDANT_API_URL || "https://api.verdant-ai.com").href;

async function checkServices() {
  const health = await new JobQueue(createDatabaseRpc(), queueNamespace(), "probe").health();
  return {...health, supabaseCredentials: true};
}
async function checkPi() {
  const spec = modelSpec();
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ authPath: path.join(dataDir, ".pi-check", "auth.json"), modelsPath: null });
  return { model: spec.label, modelKnown: Boolean(runtime.getModel(spec.provider, spec.id)), credentialConfigured: piConfigured() };
}
function log(event:string,details:Record<string,unknown>={}) {
  console.log(JSON.stringify({event,...details,timestamp:new Date().toISOString()}));
}
/** Payments for failed acquisitions are refunded by the API, which alone holds payment credentials. */
async function sweepRefunds() {
  const api=process.env.VERDANT_API_URL, token=process.env.VERDANT_WORKER_TOKEN;
  if(!api||!token) return;
  try {
    const response=await fetch(new URL("/api/internal/acquisitions/refunds",api),{method:"POST",
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60_000)});
    const body=await response.json().catch(()=>({})) as {processed?:number};
    if(!response.ok||body.processed) log("refund_sweep",{status:response.status,...body});
  } catch { log("refund_sweep_unavailable"); }
}
/** Run the Pi pipeline for one request without a database: plan, acquire, verify, write the publication locally. */
async function acquireLocally(file: string) {
  const plan = planAcquisition(dataRequestSchema.parse(JSON.parse(await readFile(file, "utf8"))));
  if (!plan.ok) { log("acquisition_rejected", plan); process.exitCode = 1; return; }
  const id = `local-${plan.coverageDigest.slice(0, 12)}-${Date.now()}`;
  const ws = await Workspace.create(path.join(dataDir, "local", id), { acquisitionId: id, attempt: 1, target: plan.target });
  log("local_acquisition_started", { dir: ws.dir, target: plan.target, model: modelSpec().label });
  const outcome = await runAgent(ws, { signal: new AbortController().signal, log, onEvent: event => log("agent_event", event) });
  log("agent_finished", { ...outcome });
  if (!outcome.submitted) { process.exitCode = 1; return; }
  const publication = await buildPublication(ws, { model: outcome.model ?? modelSpec().label });
  await writeFile(ws.file("publication.json"), JSON.stringify(publication));
  log("local_acquisition_verified", { datasetVersion: publication.dataset.id, ...publication.stats, publication: ws.file("publication.json") });
}

if (process.argv.includes("--validate")) {
  const file = process.argv[process.argv.indexOf("--validate") + 1];
  if (!file) throw new Error("Supply a path after --validate.");
  const input: unknown = JSON.parse(await readFile(file, "utf8"));
  console.log(JSON.stringify(dataRequestSchema.parse(input), null, 2));
} else if (process.argv.includes("--acquire")) {
  const file = process.argv[process.argv.indexOf("--acquire") + 1];
  if (!file) throw new Error("Supply a request JSON path after --acquire.");
  await acquireLocally(file);
} else if(process.argv.includes("--check")) {
  try {
    log("services_checked",{...await checkServices(), pi: await checkPi(),
      missingPi:["ANTHROPIC_API_KEY"].filter(k=>!process.env[k]), capabilities:capabilities(), acquisitionImplemented:true});
  } catch { log("services_check_failed"); process.exitCode=1; }
} else if(process.argv.includes("--run")||process.argv.includes("--once")||process.argv.includes("--playground")) {
  const once=process.argv.includes("--once"), playgroundOnly=process.argv.includes("--playground");
  const stop=new AbortController();
  process.on("SIGINT",()=>stop.abort()); process.on("SIGTERM",()=>stop.abort());
  const rpc=createDatabaseRpc(), namespace=queueNamespace();
  const probes=new JobQueue(rpc,namespace,"probe"), acquisitions=new JobQueue(rpc,namespace,"acquisition");
  log("worker_started",{namespace,capabilities:capabilities(),model:piConfigured()?modelSpec().label:null,dataDir});
  if(!piConfigured()) log("acquisition_disabled",{reason:"ANTHROPIC_API_KEY is not configured"});
  // Playground sessions run beside the job lanes; each active session has its own Pi process.
  const playground=!once&&piConfigured()&&process.env.PLAYGROUND_ENABLED!=="0" ? runPlayground({rpc,namespace,dataDir,log,signal:stop.signal,
    mcpUrl:mcpUrl(),skillsDir:path.resolve(import.meta.dirname,"../../../skills"),concurrency:Number(process.env.PLAYGROUND_CONCURRENCY)||3,
    idleMs:Number(process.env.PLAYGROUND_IDLE_MS)||undefined}) : null;
  if(playgroundOnly&&!playground) { log("playground_disabled"); process.exitCode=1; }
  let nextSweep=0;
  while(!playgroundOnly) {
    if(Date.now()>=nextSweep) { await sweepRefunds(); nextSweep=Date.now()+300_000; }
    let worked=false;
    try {
      const claimed=await probes.claim();
      if(claimed) {
        worked=true;
        log("job_claimed",{lane:"probe",id:claimed.job.id,attempt:claimed.job.attempts});
        try {
          const result=await checkServices();
          if(!await probes.complete(claimed,result)) throw new Error("Lease lost.");
          log("job_completed",{lane:"probe",id:claimed.job.id});
        } catch {
          await probes.fail(claimed,"Service check failed");
          log("job_retry_or_failure",{lane:"probe",id:claimed.job.id});
          if(once) process.exitCode=1;
        }
      } else if(piConfigured()) {
        // One acquisition at a time: each runs a model session and bounded downloads.
        const job=await acquisitions.claim(acquisitionLeaseMs);
        if(job) {
          worked=true;
          log("job_claimed",{lane:"acquisition",id:job.job.id,attempt:job.job.attempts});
          const result=await processAcquisition(job,{rpc,queue:acquisitions,namespace,dataDir,log});
          log("job_finished",{lane:"acquisition",id:job.job.id,...result});
          if(result.status!=="ready") nextSweep=0;
          if(once&&result.status!=="ready") process.exitCode=1;
        }
      }
    } catch(error) { log("queue_unavailable",{message:(error as Error).message.slice(0,200)}); if(once) process.exitCode=1; }
    if(once||stop.signal.aborted) break;
    if(!worked) try { await delay(3000,undefined,{signal:stop.signal}); } catch { break; }
  }
  await playground;
  log("worker_stopped");
} else {
  console.error("Use --check, --run, --once, --playground, --validate <request.json>, or --acquire <request.json>."); process.exitCode=1;
}
