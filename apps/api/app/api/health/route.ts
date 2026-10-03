export function GET() {
  return Response.json({ service: "verdant-api", status: "ok", scope: "process",
    environment: process.env.VERDANT_ENV ?? "unconfigured",
    paymentMode: process.env.PAYMENT_MODE ?? "unconfigured",
    capabilities: { requestValidation: true, acquisition: false, payments: false } },
    { headers: { "Cache-Control": "no-store" } });
}
