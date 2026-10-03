import { playgroundCreateSchema, playgroundLimits } from "@verdant/contracts/playground";
import { dataResponse, unavailable } from "../../../../../src/lib/climate-data";
import { readJsonBody } from "../../../../../src/lib/http";
import { accessAllowed, createSession } from "../../../../../src/lib/playground";

/** Start a playground session. The returned token is shown once; send it as a bearer token on every session call. */
export async function POST(request: Request) {
  let body: unknown = {};
  if (request.headers.get("content-type")) {
    const parsed = await readJsonBody(request, 1024);
    if (parsed.response) return parsed.response;
    body = parsed.body;
  }
  const input = playgroundCreateSchema.safeParse(body);
  if (!input.success) return dataResponse({ error: "invalid_request", issues: input.error.issues }, 422);
  if (!accessAllowed(input.data.accessCode)) return dataResponse({ error: "access_code_required" }, 401);
  try {
    const session = await createSession(request);
    if (session.error) return dataResponse(session, 429);
    return dataResponse({ ...session, limits: playgroundLimits }, 201);
  } catch { return unavailable(); }
}
