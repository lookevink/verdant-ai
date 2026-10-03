import { dataRequestSchema } from "@verdant/contracts";
export async function POST(request: Request) {
  // Bound the body before parsing, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "empty_body" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      return Response.json({ error: "request_too_large" }, { status: 413 });
    }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const result = dataRequestSchema.safeParse(body);
  if (!result.success) return Response.json({
    error: "invalid_request", issues: result.error.issues,
  }, { status: 422 });
  return Response.json({
    valid: true, request: result.data,
    coverageVerified: false, acquisitionEnabled: false,
    message: "Request structure is valid. Source coverage, pricing and acquisition are not connected yet.",
  });
}
