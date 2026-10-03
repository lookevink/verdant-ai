import { openapi } from "@verdant/contracts/openapi";
export function GET() { return Response.json(openapi, { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } }); }
