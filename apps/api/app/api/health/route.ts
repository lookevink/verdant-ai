export function GET() {
  return Response.json({ service: "verdant-api", status: "ok", scope: "process",
    capabilities: { requestValidation: true, acquisition: false, payments: false } },
    { headers: { "Cache-Control": "no-store" } });
}
