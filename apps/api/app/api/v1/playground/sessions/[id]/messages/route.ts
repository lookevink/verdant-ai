import { playgroundLimits, playgroundMessageSchema } from "@verdant/contracts/playground";
import { dataResponse, unavailable } from "../../../../../../../src/lib/climate-data";
import { readJsonBody } from "../../../../../../../src/lib/http";
import { notFound, playgroundRpc, sessionAuth } from "../../../../../../../src/lib/playground";

/** Queue a user message. The session's worker picks it up, during a running turn as a follow-up. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = sessionAuth(request, (await context.params).id);
  if (!auth) return notFound();
  const parsed = await readJsonBody(request, 32_768);
  if (parsed.response) return parsed.response;
  const input = playgroundMessageSchema.safeParse(parsed.body);
  if (!input.success) return dataResponse({ error: "invalid_message", issues: input.error.issues }, 422);
  try {
    const result = await playgroundRpc()("verdant_playground_send", { ...auth, p_text: input.data.text, p_source: input.data.source,
      p_max_turns: playgroundLimits.maxTurns }) as Record<string, unknown> | null;
    if (!result) return notFound();
    return dataResponse(result, result.error ? 409 : 202);
  } catch { return unavailable(); }
}
