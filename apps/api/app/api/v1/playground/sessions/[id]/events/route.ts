import { API_VERSION } from "@verdant/contracts";
import { dataResponse, unavailable } from "../../../../../../../src/lib/climate-data";
import { notFound, playgroundRpc, sessionAuth } from "../../../../../../../src/lib/playground";

export const runtime = "nodejs";
export const maxDuration = 300;
type Page = { status: string; lastSeq: number; events: { seq: number; kind: string }[] };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Session events after `after` (or Last-Event-ID). With Accept: text/event-stream the response streams new events as
 * they are written, polling quickly while a turn is active, and ends after four minutes; clients reconnect from the
 * last sequence number. Otherwise one JSON page is returned.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = sessionAuth(request, (await context.params).id);
  if (!auth) return notFound();
  let after = Number(new URL(request.url).searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) after = 0;
  const rpc = playgroundRpc();
  const read = () => rpc("verdant_playground_events", { ...auth, p_after: after, p_limit: 200 }) as Promise<Page | null>;
  let first: Page | null;
  try { first = await read(); } catch { return unavailable(); }
  if (!first) return notFound();
  if (!request.headers.get("accept")?.includes("text/event-stream")) return dataResponse(first);

  const encoder = new TextEncoder(), deadline = Date.now() + 240_000;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      let status = "", lastWrite = Date.now(), page: Page | null = first;
      try {
        while (page && !request.signal.aborted) {
          for (const event of page.events) { write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); after = event.seq; lastWrite = Date.now(); }
          if (page.status !== status) {
            status = page.status; lastWrite = Date.now();
            write(`event: session\ndata: ${JSON.stringify({ status, lastSeq: page.lastSeq })}\n\n`);
          }
          if (page.events.length === 200) { page = await read(); continue; }
          if (Date.now() > deadline) break;
          if (Date.now() - lastWrite > 15_000) { write(": keep-alive\n\n"); lastWrite = Date.now(); }
          await pause(status === "idle" || status === "closed" ? 1500 : 350);
          try { page = await read(); } catch { await pause(2000); }
        }
      } catch { /* the client disconnected */ }
      try { controller.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no", "Verdant-API-Version": API_VERSION } });
}
