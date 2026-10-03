import { randomUUID } from "node:crypto";
import { isAdmin, queue } from "../../../../../src/lib/services";
export async function POST(request:Request) {
  if(!isAdmin(request)) return Response.json({error:"unauthorized"},{status:401});
  const id=randomUUID();
  try {
    await queue("probe").enqueue(id,{purpose:"service-connectivity"},id,"probe");
    return Response.json({id,status:"queued",paymentRequired:false,scope:"admin-diagnostic"},{status:202});
  } catch { return Response.json({error:"queue_unavailable"},{status:503}); }
}
export async function GET(request:Request) {
  if(!isAdmin(request)) return Response.json({error:"unauthorized"},{status:401});
  const id=new URL(request.url).searchParams.get("id");
  if(!id||!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return Response.json({error:"invalid_id"},{status:400});
  try {
    const job=await queue("probe").get(id);
    return Response.json(job??{error:"not_found"},{status:job?200:404,headers:{"Cache-Control":"no-store"}});
  } catch { return Response.json({error:"queue_unavailable"},{status:503}); }
}
