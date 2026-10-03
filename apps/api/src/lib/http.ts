import { dataRequestSchema, deliveryLimits } from "@verdant/contracts";
import { dataResponse } from "./climate-data";

export async function readJsonBody(request: Request, maxBytes: number = deliveryLimits.maxRequestBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
    return { response: dataResponse({ error: "unsupported_media_type", message: "Use Content-Type: application/json." }, 415) } as const;
  const reader = request.body?.getReader();
  if (!reader) return { response: dataResponse({ error: "empty_body" }, 400) } as const;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { response: dataResponse({ error: "request_too_large" }, 413) } as const;
      }
      chunks.push(value);
    }
  } catch { return { response: dataResponse({ error: "invalid_body" }, 400) } as const; }
  try { return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown } as const; }
  catch { return { response: dataResponse({ error: "invalid_json" }, 400) } as const; }
}

export async function readDataRequest(request: Request) {
  const parsed = await readJsonBody(request);
  if (parsed.response) return { response: parsed.response } as const;
  const result = dataRequestSchema.safeParse(parsed.body);
  if (!result.success) return { response: dataResponse({ error: "invalid_request", issues: result.error.issues }, 422) } as const;
  return { request: result.data } as const;
}
