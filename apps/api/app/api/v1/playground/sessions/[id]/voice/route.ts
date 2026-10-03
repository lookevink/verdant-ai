import { dataResponse, unavailable } from "../../../../../../../src/lib/climate-data";
import { notFound, playgroundRpc, sessionAuth, voiceTicket } from "../../../../../../../src/lib/playground";

/** A two-minute ticket for opening this session's voice connection on the relay. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = sessionAuth(request, (await context.params).id);
  if (!auth) return notFound();
  try {
    if (!await playgroundRpc()("verdant_playground_events", { ...auth, p_after: Number.MAX_SAFE_INTEGER, p_limit: 1 })) return notFound();
  } catch { return unavailable(); }
  const ticket = voiceTicket(auth.p_id);
  return ticket ? dataResponse(ticket) : dataResponse({ error: "voice_unavailable" }, 503);
}
