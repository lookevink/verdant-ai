import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { JobQueue, createDatabaseRpc, queueNamespace } from "@verdant/queue";
export function queue(lane:"probe"|"data_request") {
  return new JobQueue(createDatabaseRpc(),queueNamespace(),lane);
}
function hasToken(request:Request,expected:string|undefined) {
  const value=request.headers.get("authorization")?.replace(/^Bearer /,"");
  if (!expected || !value) return false;
  const a=Buffer.from(expected),b=Buffer.from(value);
  return a.length===b.length && timingSafeEqual(a,b);
}
export function isAdmin(request:Request) { return hasToken(request,process.env.API_ADMIN_TOKEN); }
/** The trusted worker, for operations that need credentials only the API holds. */
export function isWorker(request:Request) { return hasToken(request,process.env.VERDANT_WORKER_TOKEN) || isAdmin(request); }
export function supabase() {
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY;
  if(!url||!key) throw new Error("Supabase server configuration is missing.");
  return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}
