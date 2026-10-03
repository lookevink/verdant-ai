import { dataResponse, unavailable } from "../../../../../../../src/lib/climate-data";
import { notFound, playgroundRpc, sessionAuth } from "../../../../../../../src/lib/playground";

/** Stop the current turn: a queued one is dropped, a running one is aborted by its worker. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = sessionAuth(request, (await context.params).id);
  if (!auth) return notFound();
  try {
    const session = await playgroundRpc()("verdant_playground_cancel", auth);
    return session ? dataResponse(session, 202) : notFound();
  } catch { return unavailable(); }
}
